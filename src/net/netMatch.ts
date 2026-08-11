/*
 * NetMatch — the client-side read mirror of the authority's MatchState. Every
 * networked client renders from one of these (there is no host client under server
 * authority). It satisfies MatchLike so the existing UI renders from it unchanged:
 * reads come from the mirrored state; mutators (bay reorder, sniper-ban pick) are
 * routed to the authority as intents rather than applied locally. Authoritative
 * changes arrive as snapshots; the per-snapshot event list is replayed on this
 * emitter so components that animate off events (score replay, turn-armed) still
 * fire — and healPhaseFromState re-derives the ones a snapshot arrives without.
 */

import { getCard } from "../game/cards/library";
import { Emitter } from "../game/emitter";
import type { MatchEvents } from "../game/match";
import { DEFAULT_SETTINGS, legalBanLetters } from "../game/settings";
import {
  byScoreDesc,
  emptyMatchState,
  type GameMode,
  type GamePhase,
  type MatchState,
  type PlayerState,
} from "../game/types";
import type { MatchLike } from "./controller";
import type { ClockAnchor, Intent, WireEvent } from "./messages";
import { deserializeState, type WireMatchState } from "./serialize";

export class NetMatch implements MatchLike {
  readonly events = new Emitter<MatchEvents>();
  private _state: MatchState = emptyMatchState({ ...DEFAULT_SETTINGS });

  /** Absolute expiry instants on the LOCAL monotonic clock (`now()` units), each
   *  null when its timer isn't running. Set on every snapshot from the authority's
   *  absolute anchor; the per-frame countdown reads off these instead of
   *  subtracting dt, so dropped/clamped frames can't make it drift. */
  private clockExpiry: number | null = null;
  private subTimerExpiry: number | null = null;
  private countdownExpiry: number | null = null;
  /** Last whole-second value emitted on countdownTick, to throttle emits. */
  private countdownShown = -1;

  /**
   * @param sendIntent routes this client's mutations to the authority as intents.
   * @param now monotonic clock in ms (default performance.now); injectable so
   *   tests can drive the anchor-based countdown deterministically.
   */
  constructor(
    private readonly sendIntent: (intent: Intent) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get state(): MatchState {
    return this._state;
  }

  get current(): PlayerState {
    return this._state.players[this._state.currentPlayerIndex];
  }

  /** Adopt an authoritative snapshot, then replay the authority's events for the UI.
   *  The clock anchor re-bases each running timer onto the local monotonic clock:
   *  `expiresAt − sentAt` is the server-reported remaining duration (the absolute
   *  server/client clocks cancel, so a mis-set system clock can't corrupt it), and
   *  anchoring it on `now()` makes the per-frame countdown immune to frame drift. */
  applySnapshot(wire: WireMatchState, events: WireEvent[], clock: ClockAnchor): void {
    const prevPhase = this._state.phase;
    const prevIndex = this._state.currentPlayerIndex;
    this._state = deserializeState(wire);
    const base = this.now();
    const anchor = (expiresAt: number | null): number | null =>
      expiresAt == null ? null : base + (expiresAt - clock.sentAt);
    this.clockExpiry = anchor(clock.clockExpiresAt);
    this.subTimerExpiry = anchor(clock.subTimerExpiresAt);
    this.countdownExpiry = anchor(clock.countdownExpiresAt);
    this.countdownShown = -1; // re-seed countdownTick throttle for the new anchor
    const replayed = new Set(events.map((e) => e.type));
    for (const e of events) this.events.emit(e.type, e.payload as never);
    this.healPhaseFromState(prevPhase, prevIndex, replayed);
  }

  /** Re-derive the phase- and turn-level transitions the UI animates off, for the
   *  snapshots the authority sends with NO replay events: a sync/reconnect
   *  fullSnapshot, the roster-change resync after a player leaves, and the
   *  contained-failure re-broadcast. Without this a client that adopts an advanced
   *  state but sees no `phaseChanged`/`turnArmed`/`gameOver` event stays stranded on
   *  the previous one (never leaves the lobby on reconnect, never reaches the
   *  game-over screen when a disconnect ends the match, and — see the turn heal
   *  below — sits with a dead word box when the player who was up disconnects).
   *
   *  The roster resync is the only snapshot that can advance the TURN with no events
   *  attached: the authority's onPlayerLeft calls dropPlayer (which ends the departed
   *  player's turn and arms the next one) but then drops its buffered events, because
   *  the platform's own post-roster-change re-broadcast supersedes them — and letting
   *  them ride the next patch instead would replay a `gameOver` this method has
   *  already synthesized, double-writing the Play Log. So the turn arm has to be
   *  re-derived here, from state.
   *
   *  Guarded against misfiring: it only emits an event that was NOT already in the
   *  replay list (so a normal snapshot doesn't double-fire — critical for gameOver,
   *  whose listener writes the Play Log), and only for genuine in-match transitions —
   *  a fresh client syncing into a finished (GameOver) or empty (Setup) lobby must NOT
   *  fabricate a gameOver or get shoved onto the match surface. */
  private healPhaseFromState(
    prevPhase: GamePhase,
    prevIndex: number,
    replayed: Set<keyof MatchEvents>,
  ): void {
    const s = this._state;
    const active = (ph: GamePhase): boolean =>
      ph === "Countdown" || ph === "Round" || ph === "Intermission" || ph === "Tutorial";
    if (s.phase !== prevPhase && !replayed.has("phaseChanged")) {
      if (active(s.phase) || (s.phase === "GameOver" && active(prevPhase))) {
        this.events.emit("phaseChanged", s.phase);
      }
    }
    // The turn moved (or Round re-opened) without an arm to announce it: re-announce
    // from state, in the engine's own order (phaseChanged → turnArmed). Whoever is up
    // now needs their input enabled, shot clock re-armed and leaderboard seat lit.
    if (
      s.phase === "Round" &&
      s.players.length > 0 &&
      !replayed.has("turnArmed") &&
      (s.currentPlayerIndex !== prevIndex || prevPhase !== "Round")
    ) {
      this.events.emit("turnArmed", {
        playerIndex: s.currentPlayerIndex,
        requiredLetter: s.requiredLetter,
        clockTotal: s.clockTotal,
      });
    }
    if (s.phase === "GameOver" && active(prevPhase) && !replayed.has("gameOver")) {
      this.events.emit("gameOver", { winnerId: s.winnerId, standings: this.standings() });
    }
  }

  /** Refresh the visible countdowns from their absolute expiry anchors between
   *  authoritative snapshots. Never advances a phase — only the server's timers are
   *  authoritative; its next snapshot resyncs everyone. `dt` is ignored: each
   *  value is `expiry − now`, so dropped/clamped frames can't accumulate drift.
   *  Covers the shot clock (Round), the tutorial/intermission sub-timer, and the
   *  pre-round countdown. */
  localClockTick(_dt: number): void {
    const s = this._state;
    const remaining = (expiry: number | null): number =>
      expiry == null ? 0 : Math.max(0, (expiry - this.now()) / 1000);
    if (s.phase === "Round") {
      const next = remaining(this.clockExpiry);
      if (next !== s.clockRemaining) {
        s.clockRemaining = next;
        this.events.emit("clockTick", next);
      }
    } else if (s.phase === "Tutorial" || s.phase === "Intermission") {
      const next = remaining(this.subTimerExpiry);
      if (next !== s.subTimerRemaining) {
        s.subTimerRemaining = next;
        this.events.emit("subTimerTick", next);
      }
    } else if (s.phase === "Countdown" && this.countdownExpiry != null) {
      // Countdown has no serialized state field; ac-countdown renders the integer
      // straight off the event. Emit only when the whole-second value changes.
      const next = Math.ceil(remaining(this.countdownExpiry));
      if (next !== this.countdownShown) {
        this.countdownShown = next;
        this.events.emit("countdownTick", next);
      }
    }
  }

  // ── Reads ──
  standings(): PlayerState[] {
    return [...this._state.players].sort(byScoreDesc);
  }
  computeLastPlaceId(): string {
    const active = this._state.players.filter((p) => !p.eliminated);
    let last = active[0];
    for (const p of active) if (p.score < last.score) last = p;
    return last?.id ?? "";
  }
  isExempt(player: PlayerState): boolean {
    return this.computeLastPlaceId() === player.id;
  }
  personalBansFor(playerId: string): { letter: string; cardName: string }[] {
    // The authority stamps personalBans onto each player at era arm, so the mirrored
    // snapshot carries them; read straight from the synced state.
    return this._state.players.find((p) => p.id === playerId)?.personalBans ?? [];
  }
  /**
   * The mode this mirror renders card values for.
   *
   * Read from the replicated setting rather than derived, because `isPicker`'s word-pool half is
   * host-local and a guest has no pool to inspect. The two can only disagree in the logged
   * wiring-bug case where the host asked for Picker and was given no pool — and there the guest is
   * a display mirror whose scores all arrive pre-computed from the authority anyway.
   */
  get effectiveMode(): GameMode {
    return this._state.settings.gameMode;
  }

  hidesInput(playerId: string): boolean {
    const p = this._state.players.find((x) => x.id === playerId);
    if (!p) return false;
    return p.bay.some((b) => getCard(b.id, this.effectiveMode)?.hidesInput?.() ?? false);
  }

  // ── Mutators → authority intents (clients never mutate authoritative state) ──
  setPlayerBay(_playerId: string, engineUids: string[], discardUids: string[]): void {
    // engine/discard carry BayCard uids (read from this client's synced state), which
    // the authority resolves back to its own bay instances.
    this.sendIntent({ kind: "reorderBay", engine: engineUids, discard: discardUids });
  }
  applySniperBanAndAdvance(letter: string): void {
    this.sendIntent({ kind: "sniperBan", letter });
  }
  skipTutorial(): void {
    // Owner-only on the authoritative side; the authority ignores everyone else's skip
    // (the dwell is shared, so one skip advances the page for the whole lobby).
    this.sendIntent({ kind: "skipTutorial" });
  }
  markTutorialReady(_playerId: string): void {
    // The authority derives the player id from the sender; the page advances when all ready.
    this.sendIntent({ kind: "tutorialReady" });
  }
  skipOptimize(): void {
    // Route to the authority, which fast-forwards the shared optimize dwell.
    this.sendIntent({ kind: "lockInOptimize" });
  }
  unlockOptimize(): void {
    // Route to the authority, which clears this player's lock-in (deriving the id from
    // the sender).
    this.sendIntent({ kind: "unlockOptimize" });
  }
  randomBanLetter(): string {
    // The authority re-validates; this only feeds the UI's timeout-default path.
    const legal = legalBanLetters(this._state.settings.banMode);
    return legal[0] ?? "e";
  }
}
