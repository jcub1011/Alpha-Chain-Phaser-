/*
 * Alpha Chain server-authoritative module. The KnockBox server runs this sandboxed
 * (Jint), one instance per lobby (GAME.json "serverAuthority": "authority.js"). It
 * is the server-side port of the former host controller (the host loop Alpha Chain
 * used before this migration): it owns the real MatchController, validates every
 * intent, and returns absolute-valued patches the platform broadcasts to all
 * clients stamped `from: "server"`.
 *
 * Sandbox contract (docs/SERVER_AUTHORITY_DESIGN.md §3):
 *   - single bundled file, no imports (the build inlines everything);
 *   - no ambient `Date` — the match clock is fed kb.now(); no fetch/DOM;
 *   - word validation is the server word service `kb.words.has("en", word)`
 *     (the 386k-word dictionary lives on the server, declared in GAME.json
 *     `authorityWords`, never bundled here).
 *
 * The client (src/net/serverController.ts) renders every state from the same
 * NetMatch mirror the host-auth guests used, so the wire payload is unchanged in
 * substance: state + the events to replay + an absolute clock anchor
 * (ServerStatePayload in src/net/messages.ts).
 */

import { MatchController, type MatchEvents, type PlayerSeed } from "../game/match";
import { DEFAULT_SETTINGS, sanitizeSettings, SUBMIT_GRACE_SECONDS } from "../game/settings";
import {
  DictionaryTier,
  emptyMatchState,
  type AlphaChainSettings,
  type MatchState,
} from "../game/types";
import type { ClockAnchor, Intent, ServerStatePayload, WireEvent } from "../net/messages";
import { serializeState } from "../net/serialize";
import { kbWordPool } from "../game/picker/wordPool";
import { createLogger, setLogSink, type KbLog } from "./serverLog";

const log = createLogger("authority");

/** Read-only word queries over the game's declared dictionaries (GAME.json authorityWords). */
interface KbWords {
  has(key: string, word: string): boolean;
  count(key: string): number;
  pick(key: string, index: number): string | null;
  countOfLength(key: string, len: number): number;
  pickOfLength(key: string, len: number, index: number): string | null;
}

/** The frozen capability object the platform injects into createAuthority(kb). */
export interface Kb {
  /** Server clock, epoch ms — the only time source (no `Date` in the sandbox). */
  now(): number;
  /** Server-side logger (info/warn/error/debug). */
  log?: KbLog;
  /** Word dictionaries declared in GAME.json authorityWords. */
  words: KbWords;
  /** Join gate. */
  setLobbyOpen(open: boolean): void;
  /** Owner-migration primitive. */
  setOwner(playerId: string): void;
  /** Optional deterministic RNG for the match (turn shuffle, card deals). The platform
   *  does NOT provide this — production falls back to Math.random — but tests inject one
   *  for reproducibility, matching MatchController's own injectable-rng convention. */
  rng?: () => number;
}

/** The dictionary keys Alpha Chain declares in GAME.json authorityWords.
 *
 *  `en` is the full 386k list and is the ONLY validator, in both game modes. `en-common` is the
 *  ~9k common-word list Picker can draw its Offer from — a strict subset of `en`
 *  (tools/build-common-wordlist.mjs enforces the intersection), which is what lets validation stay
 *  on the full list while the Offer comes from the smaller one. If that subset property ever
 *  broke, offered words would start rejecting as "not-a-word". */
const DICTIONARY = "en";
const DICTIONARY_COMMON = "en-common";

/** Match events replayed to clients for animation (everything but the per-frame clock,
 *  which clients interpolate from the snapshot's absolute-expiry anchor). Mirrors the
 *  list the old host controller broadcast. */
const REPLAYED_EVENTS: (keyof MatchEvents)[] = [
  "phaseChanged",
  "subPhaseChanged",
  "turnArmed",
  "submission",
  "rejected",
  "timeout",
  "intermission",
  "gameOver",
];

export function createAuthority(kb: Kb) {
  setLogSink(kb.log);

  /** The current lobby roster in join order (id + name). */
  let roster: { id: string; displayName: string }[] = [];
  /** The member holding lobby powers; the game decides succession (see onPlayerLeft). */
  let ownerId: string | null = null;
  /** The owner's working lobby settings, adopted by the match at startMatch. */
  let settings: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  /** The authoritative match, once startMatch fires. Undefined in the lobby. */
  let host: MatchController | undefined;
  /** Match events buffered since the last patch (replayed on clients). */
  let pending: WireEvent[] = [];

  /** A blank pre-match MatchState carrying the current lobby settings (shares the
   *  NetMatch factory so the client's lobby renders consistently and the two can't drift). */
  function emptyState(): MatchState {
    return emptyMatchState(settings);
  }

  /** Whether a match is currently being played. A finished match's MatchController stays
   *  assigned to `host` (so a rematch can boot from it), so "has a host" is NOT the same as
   *  "in a live match": pre-match and the post-match rematch lobby are both non-live, and
   *  that's when the owner may edit lobby settings and a (re)match may start. */
  function liveMatch(): boolean {
    return !!host && host.state.phase !== "GameOver";
  }

  /** Absolute-expiry clock anchor for the running timer, as the old buildSnapshot did
   *  but sourced from kb.now(). Clients take (expiresAt − sentAt), so the server/client
   *  wall-clock offset cancels (see NetMatch.applySnapshot). */
  function buildClock(sentAt: number): ClockAnchor {
    if (!host) {
      return { sentAt, clockExpiresAt: null, subTimerExpiresAt: null, countdownExpiresAt: null };
    }
    const s = host.state;
    const expiry = (seconds: number): number => sentAt + seconds * 1000;
    return {
      sentAt,
      clockExpiresAt: s.phase === "Round" && s.clockRemaining > 0 ? expiry(s.clockRemaining) : null,
      subTimerExpiresAt:
        (s.phase === "Tutorial" || s.phase === "Intermission") && s.subTimerRemaining > 0
          ? expiry(s.subTimerRemaining)
          : null,
      countdownExpiresAt:
        s.phase === "Countdown" && host.countdownSecondsRemaining > 0
          ? expiry(host.countdownSecondsRemaining)
          : null,
    };
  }

  /** Build a full absolute payload (whole state + the given replay events + clock).
   *  Events are JSON-cleaned (like serializeState does for the state) to drop
   *  own-property `undefined`s (e.g. Submission.effects/timedOut): the sandbox
   *  boundary is strict-JSON, and the local emulation's fidelity check throws on
   *  undefined rather than silently dropping it like JSON.stringify. */
  function buildPayload(events: WireEvent[]): ServerStatePayload {
    const sentAt = kb.now();
    const state = serializeState(host ? host.state : emptyState());
    // Outside a live match the authoritative lobby settings are the owner's working copy,
    // not whatever the (finished) match's state carries — reflect them so owner edits in
    // the rematch lobby reach every client. (Standings/winner in the GameOver state are
    // left untouched; only the settings field is re-sourced.)
    if (!liveMatch()) state.settings = JSON.parse(JSON.stringify(settings)) as AlphaChainSettings;
    const cleanEvents = JSON.parse(JSON.stringify(events)) as WireEvent[];
    return { state, events: cleanEvents, clock: buildClock(sentAt) };
  }

  /** A full snapshot with no replay events (sync / late-join / reconvergence). */
  function fullSnapshot(): ServerStatePayload {
    return buildPayload([]);
  }

  /** Drain buffered events into a patch. Returns null when nothing changed (no forced
   *  snapshot and no events) so the platform broadcasts nothing and clients interpolate. */
  function drainPatch(force: boolean): ServerStatePayload | null {
    if (!force && pending.length === 0) return null;
    const events = pending;
    pending = [];
    return buildPayload(events);
  }

  /** Whether the match is currently in the optimize sub-phase (bay edits / lock-in). */
  function inOptimize(): boolean {
    return host?.state.phase === "Intermission" && host.state.intermissionPhase === "optimize";
  }

  /** Owner-only: construct and start the MatchController from the given settings.
   *  Returns whether a match actually started, so the caller only broadcasts on a real
   *  change — a refused start must publish nothing, or any client could spam startMatch
   *  and make the server fan out the whole serialized MatchState per frame. */
  function beginMatch(fromId: string, requested: AlphaChainSettings): boolean {
    if (fromId !== ownerId) return false; // only the owner starts
    // First start (no match yet) and rematch (previous match finished) proceed; a stray
    // startMatch mid-game must not wipe the running MatchController.
    if (liveMatch()) return false;
    // `requested` is wire data: the guards above settle WHO and WHEN, this settles WHAT.
    // A stale client omits whatever settings it predates, and a missing key reads as
    // `undefined`, which survives arithmetic and comparison silently — dealCards' weights
    // would go NaN, so `r < 0` never trips and every draw falls through to the last pooled
    // card. Sanitized once, here, because this is the single point where a client's
    // settings become the lobby's working copy AND the running match's rules. (After the
    // migration this is the home of the check the guest-side controller used to do.)
    const chosen = sanitizeSettings(requested);
    const seeds: PlayerSeed[] = roster
      .filter((p) => chosen.hostPlays || p.id !== ownerId)
      .map((p) => ({ id: p.id, name: p.displayName, isBot: false }));
    // No eligible players (e.g. a solo owner sitting out with hostPlays=false): a player-less
    // MatchController arms no turn and throws on every tick, hanging the lobby. Refuse to
    // start — before adopting `chosen`, so a refused start leaves the lobby's working
    // settings exactly as they were.
    if (seeds.length === 0) {
      log.warn("startMatch ignored: no eligible players to seed the match");
      return false;
    }
    settings = chosen;
    log.info(`starting match (${seeds.length} players)`);
    host = new MatchController(seeds, chosen, {
      isWord: (w) => kb.words.has(DICTIONARY, w),
      rng: kb.rng ?? Math.random,
      now: () => kb.now(),
      submitGraceSeconds: SUBMIT_GRACE_SECONDS,
      // Picker's Offer pool. The dictionary never reaches the client in networked play — the
      // index-only word service is enough to build a length-shaped, succession-constrained Offer
      // host-side, and the Offer itself ships in the snapshot.
      wordPool: kbWordPool(
        kb.words,
        chosen.offerDictionary === DictionaryTier.Reduced ? DICTIONARY_COMMON : DICTIONARY,
      ),
    });
    for (const type of REPLAYED_EVENTS) {
      host.events.on(type, (payload) => pending.push({ type, payload } as WireEvent));
    }
    // Re-open the lobby when the match ends so the rematch lobby accepts joins, the way
    // the pre-match one does — the session now outlives its creator, so a closed-forever
    // lobby would strand it. A player who joins during GameOver lands in `roster` and is
    // seeded by the next beginMatch, which closes the gate again below.
    host.events.on("gameOver", () => kb.setLobbyOpen(true));
    kb.setLobbyOpen(false); // close the lobby once the match starts
    host.start();
    return true;
  }

  return {
    init(players: { id: string; displayName: string }[]): void {
      roster = players.map((p) => ({ id: p.id, displayName: p.displayName }));
      ownerId = roster.length > 0 ? roster[0].id : null;
      kb.setLobbyOpen(true);
      log.info(`authority init (${roster.length} players, owner=${ownerId ?? "?"})`);
    },

    /** Validate + apply an intent; return an absolute patch to broadcast, or null to reject. */
    applyIntent(fromId: string, action: Intent): ServerStatePayload | null {
      try {
        if (action.kind === "startMatch") {
          // Only a start that actually happened is worth a broadcast (see beginMatch).
          return beginMatch(fromId, action.settings) ? drainPatch(true) : null;
        }
        if (action.kind === "setSettings") {
          // Owner-only, and only while NOT in a live match — i.e. the pre-match lobby AND the
          // post-match rematch lobby (GameOver), where the owner may re-tune before starting
          // again. Rejected mid-match so settings can't change under a running game. Rides the
          // snapshot (buildPayload re-sources the settings field when not live).
          if (fromId !== ownerId) return null;
          if (liveMatch()) return null;
          // Same trust boundary as beginMatch, and a genuinely separate entry point: a
          // startMatch carries the lobby's own draft, not whatever setSettings last
          // published, so neither site can lean on the other having validated.
          settings = sanitizeSettings(action.settings);
          return drainPatch(true);
        }
        const h = host;
        if (!h) return null;
        switch (action.kind) {
          case "submit":
            h.submitWord(fromId, action.word);
            return drainPatch(false);
          case "draftWord":
            // Streamed in-progress word for timeout auto-submit; sets no state, emits no
            // event — nothing to broadcast.
            h.setDraft(fromId, action.word);
            return null;
          case "selectOffer":
            // Picker's twin of draftWord. Returning a literal null — never drainPatch — is
            // LOAD-BEARING, not tidiness: there is no server-side rate limiter anywhere in this
            // build, and an intent that cannot make the server fan state out is the only thing
            // standing between a held-down tap and an amplification vector. setSelection also
            // refuses a word that isn't in the current Offer, and refuses off-turn senders.
            h.setSelection(fromId, action.word);
            return null;
          case "commitSelection":
            // Mirrors `submit`: commitSelection emits `submission` on success or one `rejected`
            // on a bad word, and is deliberately EVENTLESS when nothing is selected — so
            // drainPatch(false) publishes exactly once per real outcome and nothing for a stray.
            h.commitSelection(fromId, action.word);
            return drainPatch(false);
          case "reorderBay":
            if (!inOptimize()) return null;
            h.setPlayerBay(fromId, action.engine, action.discard);
            return drainPatch(true); // emits no event; force so the reorder reaches clients
          case "lockInOptimize":
            if (!inOptimize()) return null;
            h.lockInOptimize(fromId);
            return drainPatch(true);
          case "unlockOptimize":
            if (!inOptimize()) return null;
            h.unlockOptimize(fromId);
            return drainPatch(true);
          case "sniperBan":
            if (
              h.state.phase === "Intermission" &&
              h.state.intermissionPhase === "sniperBan" &&
              h.computeLastPlaceId() === fromId
            ) {
              h.applySniperBanAndAdvance(action.letter);
              return drainPatch(false);
            }
            return null;
          case "tutorialReady":
            // Any player may mark the current tutorial page read (may auto-advance).
            h.markTutorialReady(fromId);
            return drainPatch(true);
          case "skipTutorial":
            if (fromId !== ownerId) return null; // only the owner may skip
            h.skipTutorial();
            return drainPatch(false);
          default: {
            // Exhaustiveness guard. Without it a new Intent member with no case here silently
            // returns null — the intent would just never work, with nothing to debug from. The
            // two early `if` returns above narrow startMatch/setSettings out, so `action` is
            // `never` here once every remaining kind is handled.
            const unhandled: never = action;
            log.warn(`applyIntent: unhandled intent ${String((unhandled as Intent).kind)}`);
            return null;
          }
        }
      } catch (err) {
        // Contained failure: drop the intent and re-broadcast the authoritative state so
        // clients re-converge, exactly like the old host's try/catch (never freeze play).
        log.error(`applyIntent(${action?.kind}) failed: ${String(err)}`);
        pending = [];
        return fullSnapshot();
      }
    },

    /** Server-driven tick: advance the match clock; broadcast only when an event fired. */
    tick(dtMs: number): ServerStatePayload | null {
      if (!host) return null;
      try {
        host.tick(dtMs / 1000);
        return drainPatch(false);
      } catch (err) {
        log.error(`tick failed: ${String(err)}`);
        pending = [];
        return fullSnapshot();
      }
    },

    /** Full state for sync / late-join / reconnect. */
    snapshot(_forPlayerId?: string): ServerStatePayload {
      return fullSnapshot();
    },

    onPlayerJoined(player: { id: string; displayName: string }): null {
      if (!roster.some((p) => p.id === player.id)) {
        roster.push({ id: player.id, displayName: player.displayName });
      }
      return null; // the platform re-broadcasts snapshot() after every roster change
    },

    onPlayerLeft(playerId: string): null {
      roster = roster.filter((p) => p.id !== playerId);
      // Owner succession: promote the longest-standing remaining member.
      if (playerId === ownerId) {
        ownerId = roster.length > 0 ? roster[0].id : null;
        if (ownerId) kb.setOwner(ownerId);
      }
      // Mark them eliminated (turns skip them; they stay on the leaderboard) and, if it
      // was their live turn, skip it with no timeout penalty rather than run their clock
      // down. Also re-checks optimize completion so a departed straggler can't strand the
      // locked-in players.
      host?.dropPlayer(playerId);
      // The platform re-broadcasts a full snapshot() after a roster change, which carries
      // the advanced turn + re-armed clock. Any events dropPlayer buffered (e.g. turnArmed)
      // are superseded by that hard resync — drop them so they don't double-fire on the
      // next patch.
      pending = [];
      return null;
    },
  };
}

/** Broadcast mode (no hidden info — the same full state the host-auth model sent everyone),
 *  server-driven tick for the shot clock / countdown (clamped to AuthorityTickHzMax). */
export const config = { tickHz: 20 };
