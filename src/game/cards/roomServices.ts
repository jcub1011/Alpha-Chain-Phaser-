/*
 * Card-contributed, player-keyed room-state services (alpha-chain-gdd.md §5.3),
 * ported from RoomStateServices.cs / AlphaChainEvaluationServices.cs. All the
 * mutable, side-effecting state a card needs lives here — never in the scoring
 * fold (which stays pure) and never in the FSM. Keyed by player id (string).
 *
 * Plus the EngineEffects facade (EngineEffects.cs): the single helper through
 * which automated attacks (time shave, letter hijack) resolve on their target.
 */

import { legalBanLetters } from "../settings";
import type { AlphaChainSettings, EngineEffectNotice, PlayerState } from "../types";

export type RoomServiceKey =
  | "prismGuard"
  | "wildcardGuard"
  | "cardBan"
  | "timePenalty"
  | "hijackBan"
  | "crescendoStreak";

/** A once-per-era charge (Prism refill, Wildcard succession bypass). */
export class EraGuard {
  private readonly used = new Set<string>();
  /** Consume the charge if available; returns true if it fired this call. */
  tryConsume(id: string): boolean {
    if (this.used.has(id)) return false;
    this.used.add(id);
    return true;
  }
  isAvailable(id: string): boolean {
    return !this.used.has(id);
  }
  resetEra(id: string): void {
    this.used.delete(id);
  }
}

/** Personal banned letters rolled by Roulette Wheel / Toll Booth, reset each era.
 *  Keyed by the card's bay SLOT INDEX (not its card id) so duplicate ban-rolling
 *  cards each keep their own letter — slot indices are stable within an era (the
 *  bay only reorders at intermission, where bans reset). The card id rides along
 *  as a value so the HUD can name each ban's source. */
export class CardBanService {
  private readonly bans = new Map<string, Map<number, { cardId: string; letter: string }>>();
  roll(playerId: string, instanceKey: number, cardId: string, letter: string): void {
    const m = this.bans.get(playerId) ?? new Map<number, { cardId: string; letter: string }>();
    m.set(instanceKey, { cardId, letter });
    this.bans.set(playerId, m);
  }
  /** Letters personally banned for this player (deduped) — drives the tax gate. */
  bansFor(playerId: string): string[] {
    return [...new Set([...(this.bans.get(playerId)?.values() ?? [])].map((b) => b.letter))];
  }
  /** Each personal ban paired with the card id that rolled it (for display).
   *  Not deduped: each card instance contributes its own entry. */
  entriesFor(playerId: string): { cardId: string; letter: string }[] {
    return [...(this.bans.get(playerId)?.values() ?? [])].map((b) => ({
      cardId: b.cardId,
      letter: b.letter,
    }));
  }
  /** The letter a specific card instance rolled (Toll Booth toll lookup). */
  letterFor(playerId: string, instanceKey: number): string | null {
    return this.bans.get(playerId)?.get(instanceKey)?.letter ?? null;
  }
  resetEra(playerId: string): void {
    this.bans.delete(playerId);
  }
}

/** Seconds queued to shave off a player's next armed clock (Flak Cannon). */
export class TimePenaltyService {
  private readonly pending = new Map<string, number>();
  queue(playerId: string, seconds: number): void {
    this.pending.set(playerId, (this.pending.get(playerId) ?? 0) + seconds);
  }
  peek(playerId: string): number {
    return this.pending.get(playerId) ?? 0;
  }
  /** Return and clear the queued penalty for a player. */
  consumeFor(playerId: string): number {
    const s = this.pending.get(playerId) ?? 0;
    this.pending.delete(playerId);
    return s;
  }
}

/** A transient personal ban cursed onto a player for their next turn (Bait & Switch). */
export class HijackBanService {
  private readonly bans = new Map<string, string>();
  /** Curse a player; no-op if already cursed (a single ban at a time). */
  curse(playerId: string, letter: string): void {
    if (!this.bans.has(playerId)) this.bans.set(playerId, letter);
  }
  peek(playerId: string): string | null {
    return this.bans.get(playerId) ?? null;
  }
  consumeFor(playerId: string): string | null {
    const l = this.bans.get(playerId) ?? null;
    this.bans.delete(playerId);
    return l;
  }
  resetEra(playerId: string): void {
    this.bans.delete(playerId);
  }
}

/** Per-player count of clean (untaxed) words submitted this era (Crescendo).
 *  Resets to 0 on a taxed word and at each era boundary, so the multiplier
 *  rewards an unbroken run of clean submissions. */
export class CrescendoStreakService {
  private readonly streak = new Map<string, number>();
  get(id: string): number {
    return this.streak.get(id) ?? 0;
  }
  increment(id: string): void {
    this.streak.set(id, this.get(id) + 1);
  }
  reset(id: string): void {
    this.streak.set(id, 0);
  }
  resetEra(id: string): void {
    this.streak.delete(id);
  }
}

/** The container of all room services, instantiated once per match. */
export class RoomServices {
  readonly prismGuard = new EraGuard();
  readonly wildcardGuard = new EraGuard();
  readonly cardBan = new CardBanService();
  readonly timePenalty = new TimePenaltyService();
  readonly hijackBan = new HijackBanService();
  readonly crescendoStreak = new CrescendoStreakService();

  /** Draws personal banned letters for Roulette Wheel / Toll Booth at era start. */
  constructor(readonly banLetters: BanLetterService) {}

  /** Per-turn reset boundary (room services that re-arm each turn). No-op today. */
  fireTurnStarted(_player: PlayerState): void {
    // Reserved: turn-scoped services re-arm here (mirrors C# IRoomStateService.OnTurnStarted).
  }

  /** Reset the per-era guards + streaks for a player at an era boundary. */
  fireEraStarted(player: PlayerState): void {
    this.prismGuard.resetEra(player.id);
    this.wildcardGuard.resetEra(player.id);
    this.cardBan.resetEra(player.id);
    this.hijackBan.resetEra(player.id);
    this.crescendoStreak.resetEra(player.id);
  }
}

/** Draws a legal personal banned letter, dodging the era's banned letter. Knows
 *  the room's ban mode + current era letter so cards roll with no arguments. */
export class BanLetterService {
  constructor(
    private readonly rng: () => number,
    private readonly banMode: () => AlphaChainSettings["banMode"],
    private readonly eraLetter: () => string,
  ) {}
  rollPersonalBan(): string {
    const pool = legalBanLetters(this.banMode()).filter((l) => l !== this.eraLetter());
    if (pool.length === 0) return "";
    return pool[Math.floor(this.rng() * pool.length)];
  }
}

/** Dependencies EngineEffects needs from the match to resolve attacks. */
export interface EngineEffectsDeps {
  /** Active (non-eliminated) players in turn order. */
  activePlayers(): PlayerState[];
  /** The current round leader's id (highest score; turn order breaks ties). */
  leaderId(): string;
  /** Armed clock seconds for a player (for percentage time shaves). */
  armedClockOf(player: PlayerState): number;
}

/**
 * The facade through which automated attacks (time shave, letter hijack) resolve
 * on their target, banking the resulting notices for the score replay.
 */
export class EngineEffects {
  private notices: EngineEffectNotice[] = [];
  private siphons: { playerId: string; amount: number }[] = [];

  constructor(
    private readonly services: RoomServices,
    private readonly deps: EngineEffectsDeps,
  ) {}

  /** Bank a siphon AND emit a named notice so the UI can attribute it to a card. */
  bankSiphon(playerId: string, amount: number, source: string): void {
    if (amount <= 0) return;
    this.siphons.push({ playerId, amount });
    this.notices.push({ source, targetId: playerId, text: `+${amount} banked`, amount });
  }

  /** Return and clear siphons accumulated since the last drain. */
  takeSiphons(): { playerId: string; amount: number }[] {
    const out = this.siphons;
    this.siphons = [];
    return out;
  }

  get roundLeaderId(): string {
    return this.deps.leaderId();
  }

  orderedActivePlayers(): PlayerState[] {
    return this.deps.activePlayers();
  }

  /** The armed shot clock a player would get right now (Flak Cannon shaves a %). */
  armedClockOf(player: PlayerState): number {
    return this.deps.armedClockOf(player);
  }

  /** The next active player after `fromId` in turn order (wraps). */
  peekNextActivePlayer(fromId: string): PlayerState | null {
    const order = this.deps.activePlayers();
    const i = order.findIndex((p) => p.id === fromId);
    if (i < 0 || order.length === 0) return order[0] ?? null;
    return order[(i + 1) % order.length];
  }

  addNotice(notice: EngineEffectNotice): void {
    this.notices.push(notice);
  }

  /** Return and clear notices accumulated since the last drain. */
  takeNotices(): EngineEffectNotice[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /** Shave seconds off the target's next armed clock (Blind Sniper). */
  timeShave(victim: PlayerState, seconds: number, source: string): void {
    if (seconds <= 0) return;
    this.services.timePenalty.queue(victim.id, seconds);
    this.addNotice({ source, targetId: victim.id, text: `−${seconds}s shot clock` });
  }

  /** Curse the target with a personal banned letter for their next turn (Bait & Switch). */
  letterHijack(victim: PlayerState, letter: string, source: string): void {
    if (!letter) return;
    this.services.hijackBan.curse(victim.id, letter);
    this.addNotice({ source, targetId: victim.id, text: `letter "${letter}" banned` });
  }
}
