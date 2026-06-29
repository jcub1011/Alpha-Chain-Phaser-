/*
 * KnockBoxController — the host-authoritative multiplayer GameController.
 *
 * Model: EVERY client (host included) renders from a local NetMatch mirror fed
 * by the host's authoritative snapshots — a single code path (GAME_DEVELOPER_GUIDE
 * §5). The HOST additionally owns the real MatchController: it applies each intent
 * (its own loop back through sendToHost too), buffers the resulting match events,
 * and broadcasts a full snapshot + those events to everyone. The host applies its
 * own snapshot directly to its mirror (so it never depends on the relay echoing
 * sendToAll back to the sender) and ignores any echoed snapshot.
 *
 * Shot clock: only the host's real MatchController ticks + times out. Guests run
 * a smooth local countdown between snapshots and never time out; the host's next
 * turn-arm snapshot resyncs everyone.
 */

import type { Dictionary } from "../game/dictionary";
import { MatchController, type MatchEvents, type PlayerSeed } from "../game/match";
import { SUBMIT_GRACE_SECONDS } from "../game/settings";
import type { AlphaChainSettings, PlayerState, SubmitResult } from "../game/types";
import { createLogger, type KnockBoxLogger } from "../log";
import type { GameController, MatchLike } from "./controller";
import type { Intent, NetMessage, SnapshotMsg, WireEvent } from "./messages";
import { NetMatch } from "./netMatch";
import { serializeState } from "./serialize";

const log = createLogger("net");

/** The transport surface shared by KnockBoxPlugin and KnockBoxLocalPeer. */
export interface NetPeer {
  playerId: string | null;
  players: { id: string; displayName: string }[];
  isHost: boolean;
  events: {
    on(event: string, fn: (...args: unknown[]) => void): unknown;
    off(event: string, fn: (...args: unknown[]) => void): unknown;
  };
  sendToHost(payload: unknown): void;
  sendToAll(payload: unknown): void;
  sendTo(playerId: string, payload: unknown): void;
  setLobbyOpen?(open: boolean): void;
  /** Records a Play Log entry on the player's KnockBox home page. Present on the real
   *  WebSocket plugin only; absent on the local-tab peer (calls are a no-op there). */
  logPlay?(metadata: Record<string, unknown>): void;
  /** Ships diagnostic lines to the server log (the addon's console-like logger). */
  log?: KnockBoxLogger;
}

/** Match events the host broadcasts for replay (everything but the per-frame clock). */
const REPLAYED_EVENTS: (keyof MatchEvents)[] = [
  "phaseChanged",
  "subPhaseChanged",
  // countdownTick is intentionally NOT replayed: the pre-round countdown is now
  // driven on every client from the snapshot's absolute-expiry anchor (see
  // NetMatch.localClockTick), so it stays drift-proof without per-second events.
  // The Countdown-start snapshot still propagates via the phaseChanged above,
  // which beginCountdown() emits first.
  "turnArmed",
  "submission",
  "rejected",
  "timeout",
  "intermission",
  "gameOver",
];

export class KnockBoxController implements GameController {
  readonly match: MatchLike;
  private readonly mirror: NetMatch;
  private host?: MatchController;
  private pending: WireEvent[] = [];
  private startSettings?: AlphaChainSettings;
  /** Host's working lobby settings, broadcast to guests before the match starts so
   *  their read-only lobby mirrors the host's choices. On a guest, the last settings
   *  received from the host (undefined until the first arrives). */
  private _lobbySettings?: AlphaChainSettings;
  private lobbyCbs: (() => void)[] = [];
  private sessionEndedCbs: ((reason: string) => void)[] = [];
  /** The host's player id (learned from snapshots), for host-departure detection. */
  private hostId = "";
  private ended = false;

  /** Subscribe to lobby/roster changes (ready, join, leave) for the waiting UI. */
  onLobbyChange(cb: () => void): () => void {
    this.lobbyCbs.push(cb);
    return () => (this.lobbyCbs = this.lobbyCbs.filter((c) => c !== cb));
  }
  private notifyLobby(): void {
    this.lobbyCbs.slice().forEach((c) => c());
  }

  /** Subscribe to a terminal session end (host left / socket closed). */
  onSessionEnded(cb: (reason: string) => void): () => void {
    this.sessionEndedCbs.push(cb);
    return () => (this.sessionEndedCbs = this.sessionEndedCbs.filter((c) => c !== cb));
  }
  private endSession(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    log.warn(`session ended: ${reason}`);
    this.sessionEndedCbs.slice().forEach((c) => c(reason));
  }

  constructor(
    private readonly peer: NetPeer,
    private readonly dict: Dictionary,
    /** RNG for the host's MatchController (per-era turn shuffle). Injectable for
     *  deterministic tests; production uses Math.random. */
    private readonly rng: () => number = Math.random,
    /** Monotonic clock (ms) for the mirror's anchor-based countdowns. Injectable
     *  for deterministic tests; production uses performance.now. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.mirror = new NetMatch((intent) => this.dispatch(intent), this.now);
    this.match = this.mirror;
    // gameOver is a replayed event (see REPLAYED_EVENTS), so the mirror fires it exactly
    // once per match on every client — and again for each new match the host starts after
    // "Return To Lobby". That gives one Play Log entry per finished game, never overwriting
    // the prior one, with no dedupe/reset bookkeeping needed.
    this.mirror.events.on("gameOver", this.onGameOver);
    peer.events.on("ready", this.onReady);
    peer.events.on("message", this.onMessage);
    peer.events.on("player-joined", this.onRoster);
    peer.events.on("player-left", this.onLeft);
    peer.events.on("closed", this.onClosed);
    peer.events.on("resumed", this.onResumed);
  }

  get events(): MatchLike["events"] {
    return this.mirror.events;
  }
  get humanId(): string {
    return this.peer.playerId ?? "";
  }
  get isHost(): boolean {
    return this.peer.isHost;
  }
  /** The lobby roster (for the pre-match waiting surface). */
  get roster(): { id: string; displayName: string }[] {
    return this.peer.players;
  }

  /** The current lobby settings (host's working copy / last received from host).
   *  Read by <ac-net-lobby> so a guest's read-only form mirrors the host. */
  get lobbySettings(): AlphaChainSettings | undefined {
    return this._lobbySettings;
  }

  /** Host-only: publish the working lobby settings to every guest so their
   *  read-only lobby reflects the host's live choices before the match starts.
   *  No-op for guests (only the host edits settings). The host's own UI already
   *  holds the draft, so it ignores its own echoed broadcast (see onMessage). */
  setLobbySettings(settings: AlphaChainSettings): void {
    if (!this.peer.isHost) return;
    this._lobbySettings = settings;
    this.peer.sendToAll({ t: "lobby", settings } satisfies NetMessage);
  }

  // ── GameController ──────────────────────────────────────────────────────────
  /** Host-only: begin a match with the given settings (loops through dispatch). */
  startMatch(settings: AlphaChainSettings): void {
    this.dispatch({ kind: "startMatch", settings });
  }

  start(): void {
    // No-op: the match begins when the host calls startMatch().
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    if (this.host) {
      this.host.tick(dt); // authoritative clock + timeouts
      // The host renders from its own mirror too, but the per-frame clock/sub-timer
      // ticks aren't replayed events, so flush() only resnaps on a real state change.
      // On the frames in between ("noop"), drive the mirror's smooth countdown exactly
      // like a guest so the host's displayed timers don't sit frozen between snapshots.
      // On "failed" we do NOT tick locally — that would advance the host's display past
      // a state it couldn't broadcast; let the next successful flush resync instead.
      if (this.flush() === "noop") this.mirror.localClockTick(dt);
    } else {
      this.mirror.localClockTick(dt); // smooth guest countdown, never times out
    }
  }

  submitWord(word: string): SubmitResult {
    this.dispatch({ kind: "submit", word });
    // The UI is event-driven (rejected/submission re-emitted on the mirror), so the
    // synchronous return is neutral.
    return { accepted: false };
  }

  reportDraft(word: string): void {
    // Stream the in-progress word to the host so its authoritative clock can auto-submit
    // it on timeout. The host loops its own draft through dispatch → applyIntent too.
    this.dispatch({ kind: "draftWord", word });
  }

  destroy(): void {
    this.peer.events.off("ready", this.onReady as never);
    this.peer.events.off("message", this.onMessage as never);
    this.peer.events.off("player-joined", this.onRoster as never);
    this.peer.events.off("player-left", this.onLeft as never);
    this.peer.events.off("closed", this.onClosed as never);
    this.peer.events.off("resumed", this.onResumed as never);
    this.mirror.events.off("gameOver", this.onGameOver);
    this.pending = [];
  }

  /** Write a Play Log entry for THIS player when a match finishes. Runs on every client
   *  (host + guests) from the mirror's replayed gameOver, each logging its own result from
   *  the shared standings. logPlay appends a new home-page entry (the real peer only). */
  private onGameOver = (e: { winnerId: string | null; standings: PlayerState[] }): void => {
    const me = this.peer.playerId;
    if (!me) return;
    const idx = e.standings.findIndex((p) => p.id === me);
    if (idx < 0) return; // a host who isn't playing (hostPlays=false) has no result to log
    const self = e.standings[idx];
    const winner = e.standings.find((p) => p.id === e.winnerId);
    // logPlay coerces values to strings and drops nullish ones, so numbers are fine here.
    this.peer.logPlay?.({
      // Standard keys → rendered as chips on the home page.
      placement: idx + 1,
      playerCount: e.standings.length,
      result: e.winnerId === me ? "win" : "loss",
      score: self.score,
      // Extras → shown in the entry's details table.
      eras: this.mirror.state.settings.eraCount,
      words: this.mirror.state.history.length,
      winner: winner?.name ?? "",
    });
  };

  // ── Transport ────────────────────────────────────────────────────────────────
  private dispatch(action: Intent): void {
    log.debug(`intent → host: ${action.kind}`);
    this.peer.sendToHost({ t: "intent", action } satisfies NetMessage);
  }

  private onReady = (): void => {
    log.info(
      `ready as ${this.peer.isHost ? "host" : "guest"} (id=${this.peer.playerId ?? "?"}, players=${this.peer.players.length})`,
    );
    if (!this.peer.isHost) {
      this.peer.sendToHost({ t: "sync" } satisfies NetMessage);
    } else if (this.host) {
      this.broadcast(); // host reconnect: re-push current state
    }
    this.notifyLobby();
  };

  private onRoster = (): void => {
    if (this.peer.isHost && this.host) this.broadcast();
    this.notifyLobby();
  };

  private onLeft = (...args: unknown[]): void => {
    const leftId = args[0] as string;
    log.info(`player left: ${leftId}`);
    if (this.peer.isHost && this.host) {
      // Mirror the Blazor HasLeft: mark eliminated so turns skip them.
      const p = this.host.state.players.find((x) => x.id === leftId);
      if (p) p.eliminated = true;
      // A departure during optimize may have removed the last player we were waiting
      // on — re-evaluate so the remaining locked-in players aren't stranded.
      this.host.recheckOptimizeCompletion();
      this.broadcast();
    } else if (!this.peer.isHost && leftId && leftId === this.hostId) {
      // The host left and there is no host migration — the session is over.
      this.endSession("The host left — the session has ended.");
    }
    this.notifyLobby();
  };

  private onClosed = (...args: unknown[]): void => {
    const info = args[0] as { terminal?: boolean } | undefined;
    // Terminal close (bad ticket / ended membership) won't reconnect — end the
    // session. A transient close resolves via the SDK's "resumed"/"ready".
    if (info?.terminal) this.endSession("Connection closed — the session has ended.");
  };

  private onResumed = (): void => {
    // Reconnected after a transient drop: host re-pushes, guest re-requests.
    if (this.peer.isHost) {
      if (this.host) this.broadcast();
    } else {
      this.peer.sendToHost({ t: "sync" } satisfies NetMessage);
    }
    this.notifyLobby();
  };

  private onMessage = (...args: unknown[]): void => {
    const { from, payload } = args[0] as { from: string; payload: NetMessage };
    if (!payload || typeof payload !== "object" || !("t" in payload)) return;
    switch (payload.t) {
      case "intent":
        if (this.peer.isHost) this.applyIntent(from, payload.action);
        break;
      case "sync":
        if (this.peer.isHost) {
          // In a match: re-push the authoritative snapshot. Still in the lobby (no
          // MatchController yet): re-push the current lobby settings so a late joiner
          // / reconnecting guest sees the host's choices, not its own defaults.
          if (this.host) this.sendSnapshotTo(from);
          else if (this._lobbySettings)
            this.peer.sendTo(from, {
              t: "lobby",
              settings: this._lobbySettings,
            } satisfies NetMessage);
        }
        break;
      case "lobby":
        // Host → all lobby-settings push. Guests adopt it and refresh the lobby; the
        // host ignores its own echo (sendToAll delivers back to the sender), exactly
        // like the "snap" echo below.
        if (!this.peer.isHost) {
          this._lobbySettings = payload.settings;
          this.notifyLobby();
        }
        break;
      case "snap":
        // The host already applied its own snapshot directly; ignore the echo.
        if (!this.peer.isHost) {
          this.hostId = payload.hostId;
          log.debug(`guest applying snapshot (${payload.events.length} events)`);
          this.mirror.applySnapshot(payload.state, payload.events, payload.clock);
        }
        break;
    }
  };

  // ── Host authority ───────────────────────────────────────────────────────────
  private applyIntent(fromId: string, action: Intent): void {
    log.debug(`host applying intent ${action.kind} from ${fromId}`);
    // A thrown intent must never tear down the host (it would freeze the match for
    // everyone). Contain it, log it (reaches the KnockBox server log), and carry on.
    try {
      if (action.kind === "startMatch") {
        if (fromId !== this.peer.playerId) return; // only the host starts
        this.beginHostMatch(action.settings);
        return;
      }
      const h = this.host;
      if (!h) return;
      switch (action.kind) {
        case "submit":
          h.submitWord(fromId, action.word);
          break;
        case "draftWord":
          // Stream the live player's in-progress word so timeoutCurrent can auto-submit
          // it. Sets no state and emits no event, so the trailing flush() no-ops — no
          // snapshot needed (the draft is host-only and never serialized).
          h.setDraft(fromId, action.word);
          break;
        case "reorderBay":
          if (h.state.phase === "Intermission" && h.state.intermissionPhase === "optimize") {
            h.setPlayerBay(fromId, action.engine, action.discard);
            // setPlayerBay emits no match event, so the trailing flush() would no-op
            // and clients would never see the reorder. Force a snapshot.
            this.flush(true);
          }
          break;
        case "lockInOptimize":
          // Record this player's engine lock-in. Optimize advances only once every
          // active human has locked in (decided inside lockInOptimize); the timer is
          // the fallback. The flag-set alone emits no event, so force a snapshot below
          // so the lock-in status — or the resulting advance — reaches every client.
          if (h.state.phase === "Intermission" && h.state.intermissionPhase === "optimize") {
            h.lockInOptimize(fromId);
            this.flush(true);
          }
          break;
        case "unlockOptimize":
          // Re-open this player's engine. Like lock-in, the flag-clear alone emits no
          // event, so force a snapshot so the cleared status reaches every client.
          if (h.state.phase === "Intermission" && h.state.intermissionPhase === "optimize") {
            h.unlockOptimize(fromId);
            this.flush(true);
          }
          break;
        case "sniperBan":
          if (
            h.state.phase === "Intermission" &&
            h.state.intermissionPhase === "sniperBan" &&
            h.computeLastPlaceId() === fromId
          )
            h.applySniperBanAndAdvance(action.letter);
          break;
        case "tutorialReady":
          // Any player may mark the current tutorial page read. The flag-set alone
          // emits no event (it may auto-advance, which does), so force a snapshot so
          // the updated ready count reaches every client.
          h.markTutorialReady(fromId);
          this.flush(true);
          break;
        case "skipTutorial":
          if (fromId === this.peer.playerId) h.skipTutorial(); // only the host may skip
          break;
      }
      this.flush();
    } catch (err) {
      log.error(`applyIntent(${action.kind}) failed: ${String(err)}`, err);
    }
  }

  private beginHostMatch(settings: AlphaChainSettings): void {
    this.startSettings = settings;
    const seeds: PlayerSeed[] = this.peer.players
      .filter((p) => settings.hostPlays || p.id !== this.peer.playerId)
      .map((p) => ({ id: p.id, name: p.displayName, isBot: false }));
    log.info(`host starting match (${seeds.length} players)`);
    this.host = new MatchController(seeds, settings, {
      isWord: (w) => this.dict.has(w),
      rng: this.rng,
      submitGraceSeconds: SUBMIT_GRACE_SECONDS,
    });
    for (const type of REPLAYED_EVENTS) {
      this.host.events.on(type, (payload) => this.pending.push({ type, payload } as WireEvent));
    }
    this.peer.setLobbyOpen?.(false); // close the lobby once the match starts
    this.host.start();
    this.flush(true);
  }

  /** Flush buffered host events as a snapshot to everyone (and the host's own mirror).
   *  Returns the outcome so tick() can react precisely:
   *   - "sent"   a snapshot was built + broadcast (state changed this frame)
   *   - "noop"   nothing to send (no host / no pending events) — safe to tick locally
   *   - "failed" a throw was contained — do NOT advance the local clock past it. */
  private flush(force = false): "sent" | "noop" | "failed" {
    if (!this.host) return "noop";
    if (!force && this.pending.length === 0) return "noop";
    const events = this.pending;
    this.pending = [];
    // flush() runs every host frame from tick(); a throw here (serialize / send /
    // snapshot-apply) must not kill the loop. Contain + log; pending is already cleared
    // so the next frame starts clean rather than re-throwing on the same events.
    try {
      const snap = this.buildSnapshot(events);
      this.peer.sendToAll(snap);
      this.mirror.applySnapshot(snap.state, snap.events, snap.clock); // host renders via the same path
      return "sent";
    } catch (err) {
      log.error(`flush failed (${events.length} events dropped): ${String(err)}`, err);
      return "failed";
    }
  }

  private broadcast(): void {
    this.flush(true);
  }

  private sendSnapshotTo(playerId: string): void {
    this.peer.sendTo(playerId, this.buildSnapshot([]));
  }

  private buildSnapshot(events: WireEvent[]): SnapshotMsg {
    const host = this.host!;
    const s = host.state;
    // One Date.now() reading anchors all three expiries: clients take the
    // (expiresAt − sentAt) difference, so the host/client clock offset cancels.
    const sentAt = Date.now();
    const expiry = (seconds: number): number => sentAt + seconds * 1000;
    return {
      t: "snap",
      state: serializeState(s),
      events,
      hostId: this.peer.playerId ?? "",
      clock: {
        sentAt,
        clockExpiresAt:
          s.phase === "Round" && s.clockRemaining > 0 ? expiry(s.clockRemaining) : null,
        subTimerExpiresAt:
          (s.phase === "Tutorial" || s.phase === "Intermission") && s.subTimerRemaining > 0
            ? expiry(s.subTimerRemaining)
            : null,
        countdownExpiresAt:
          s.phase === "Countdown" && host.countdownSecondsRemaining > 0
            ? expiry(host.countdownSecondsRemaining)
            : null,
      },
    };
  }

  /** Whether a match has begun (vs. still in the lobby). */
  get inMatch(): boolean {
    return this.mirror.state.players.length > 0;
  }

  /** The settings the host started with (for late UI). */
  get matchSettings(): AlphaChainSettings | undefined {
    return this.startSettings;
  }
}
