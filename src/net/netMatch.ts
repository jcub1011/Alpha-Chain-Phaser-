/*
 * NetMatch — the guest-side read mirror of the host's MatchState. It satisfies
 * MatchLike so the existing UI renders from it unchanged: reads come from the
 * mirrored state; mutators (bay reorder, sniper-ban pick) are routed to the host
 * as intents rather than applied locally. Authoritative changes arrive as
 * snapshots; the host's per-snapshot event list is replayed on this emitter so
 * components that animate off events (score replay, turn-armed) still fire.
 */

import { getCard } from "../game/cards/library";
import { Emitter } from "../game/emitter";
import type { MatchEvents } from "../game/match";
import { DEFAULT_SETTINGS, legalBanLetters } from "../game/settings";
import type { MatchState, PlayerState } from "../game/types";
import type { MatchLike } from "./controller";
import type { Intent, SnapshotMsg, WireEvent } from "./messages";
import { deserializeState, type WireMatchState } from "./serialize";

/** A blank state shown before the first snapshot arrives. */
function emptyState(): MatchState {
  return {
    phase: "Setup",
    era: 1,
    round: 0,
    roundInEra: 0,
    players: [],
    currentPlayerIndex: 0,
    requiredLetter: "",
    bannedLetter: "",
    usedWords: new Set(),
    history: [],
    clockRemaining: 0,
    clockTotal: 0,
    intermissionPhase: null,
    currentTutorial: null,
    subTimerRemaining: 0,
    subTimerTotal: 0,
    shownTutorials: [],
    settings: { ...DEFAULT_SETTINGS },
    winnerId: null,
  };
}

export class NetMatch implements MatchLike {
  readonly events = new Emitter<MatchEvents>();
  private _state: MatchState = emptyState();

  /** Absolute expiry instants on the LOCAL monotonic clock (`now()` units), each
   *  null when its timer isn't running. Set on every snapshot from the host's
   *  absolute anchor; the per-frame countdown reads off these instead of
   *  subtracting dt, so dropped/clamped frames can't make it drift. */
  private clockExpiry: number | null = null;
  private subTimerExpiry: number | null = null;
  private countdownExpiry: number | null = null;
  /** Last whole-second value emitted on countdownTick, to throttle emits. */
  private countdownShown = -1;

  /**
   * @param sendIntent routes guest mutations to the host as intents.
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

  /** Adopt an authoritative snapshot, then replay the host's events for the UI.
   *  The clock anchor re-bases each running timer onto the local monotonic clock:
   *  `expiresAt − sentAt` is the host-reported remaining duration (the absolute
   *  host/client clocks cancel, so a mis-set system clock can't corrupt it), and
   *  anchoring it on `now()` makes the per-frame countdown immune to frame drift. */
  applySnapshot(wire: WireMatchState, events: WireEvent[], clock: SnapshotMsg["clock"]): void {
    this._state = deserializeState(wire);
    const base = this.now();
    const anchor = (expiresAt: number | null): number | null =>
      expiresAt == null ? null : base + (expiresAt - clock.sentAt);
    this.clockExpiry = anchor(clock.clockExpiresAt);
    this.subTimerExpiry = anchor(clock.subTimerExpiresAt);
    this.countdownExpiry = anchor(clock.countdownExpiresAt);
    this.countdownShown = -1; // re-seed countdownTick throttle for the new anchor
    for (const e of events) this.events.emit(e.type, e.payload as never);
  }

  /** Refresh the visible countdowns from their absolute expiry anchors between
   *  authoritative snapshots. Never advances a phase — only the host's timers are
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
    return [...this._state.players].sort((a, b) =>
      a.score > b.score ? -1 : a.score < b.score ? 1 : 0,
    );
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
  personalBansFor(_playerId: string): { letter: string; cardName: string }[] {
    // Personal bans live in the host's CardBanService and aren't mirrored to
    // guests yet; surface nothing rather than a stale guess.
    return [];
  }
  hidesInput(playerId: string): boolean {
    const p = this._state.players.find((x) => x.id === playerId);
    if (!p) return false;
    return p.bay.some((b) => getCard(b.id)?.hidesInput?.() ?? false);
  }

  // ── Mutators → host intents (guests never mutate authoritative state) ──
  setPlayerBay(_playerId: string, engineIds: string[], discardIds: string[]): void {
    this.sendIntent({ kind: "reorderBay", engine: engineIds, discard: discardIds });
  }
  applySniperBanAndAdvance(letter: string): void {
    this.sendIntent({ kind: "sniperBan", letter });
  }
  skipTutorial(): void {
    // Host-only on the authoritative side; the host ignores non-host skips.
    this.sendIntent({ kind: "skipTutorial" });
  }
  skipOptimize(): void {
    // Route to the host, which fast-forwards the shared optimize dwell authoritatively.
    this.sendIntent({ kind: "lockInOptimize" });
  }
  randomBanLetter(): string {
    // The host re-validates; this only feeds the UI's timeout-default path.
    const legal = legalBanLetters(this._state.settings.banMode);
    return legal[0] ?? "e";
  }
}
