/*
 * NetMatch — the guest-side read mirror of the host's MatchState. It satisfies
 * MatchLike so the existing UI renders from it unchanged: reads come from the
 * mirrored state; mutators (bay reorder, sniper-ban pick) are routed to the host
 * as intents rather than applied locally. Authoritative changes arrive as
 * snapshots; the host's per-snapshot event list is replayed on this emitter so
 * components that animate off events (score replay, turn-armed) still fire.
 */

import { Emitter } from "../game/emitter";
import type { MatchEvents } from "../game/match";
import { DEFAULT_SETTINGS, legalBanLetters } from "../game/settings";
import type { MatchState, PlayerState } from "../game/types";
import type { MatchLike } from "./controller";
import type { Intent, WireEvent } from "./messages";
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

  constructor(private readonly sendIntent: (intent: Intent) => void) {}

  get state(): MatchState {
    return this._state;
  }

  get current(): PlayerState {
    return this._state.players[this._state.currentPlayerIndex];
  }

  /** Adopt an authoritative snapshot, then replay the host's events for the UI. */
  applySnapshot(wire: WireMatchState, events: WireEvent[]): void {
    this._state = deserializeState(wire);
    for (const e of events) this.events.emit(e.type, e.payload as never);
  }

  /** Smoothly count the local timers down between authoritative snapshots. Never
   *  advances a phase — only the host's timers are authoritative; the host's next
   *  snapshot resyncs everyone. Covers the shot clock (Round) and the tutorial /
   *  intermission sub-phase dwells (Tutorial / Intermission). */
  localClockTick(dt: number): void {
    const s = this._state;
    if (s.phase === "Round") {
      const next = Math.max(0, s.clockRemaining - dt);
      if (next !== s.clockRemaining) {
        s.clockRemaining = next;
        this.events.emit("clockTick", next);
      }
    } else if (s.phase === "Tutorial" || s.phase === "Intermission") {
      s.subTimerRemaining = Math.max(0, s.subTimerRemaining - dt);
    }
  }

  // ── Reads ──
  standings(): PlayerState[] {
    return [...this._state.players].sort((a, b) => b.score - a.score);
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

  // ── Mutators → host intents (guests never mutate authoritative state) ──
  setPlayerBay(_playerId: string, orderedIds: string[]): void {
    this.sendIntent({ kind: "reorderBay", order: orderedIds });
  }
  applySniperBanAndAdvance(letter: string): void {
    this.sendIntent({ kind: "sniperBan", letter });
  }
  skipTutorial(): void {
    // Host-only on the authoritative side; the host ignores non-host skips.
    this.sendIntent({ kind: "skipTutorial" });
  }
  skipOptimize(): void {
    // Optimize is timer-only in networked play (guests never fast-forward it).
  }
  randomBanLetter(): string {
    // The host re-validates; this only feeds the UI's timeout-default path.
    const legal = legalBanLetters(this._state.settings.banMode);
    return legal[0] ?? "e";
  }
}
