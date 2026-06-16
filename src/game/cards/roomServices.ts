/*
 * Card-contributed, player-keyed room-state services (alpha-chain-gdd.md §5.3),
 * ported from RoomStateServices.cs / AlphaChainEvaluationServices.cs. All the
 * mutable, side-effecting state a card needs lives here — never in the scoring
 * fold (which stays pure) and never in the FSM. Keyed by player id (string).
 *
 * Plus the EngineEffects facade (EngineEffects.cs): the single helper through
 * which the three automated attacks (time shave, point drain, letter hijack)
 * resolve, so a victim's Titanium Mirror can block + reflect them at the caster.
 */

import { legalBanLetters } from "../settings";
import type { AlphaChainSettings, EngineEffectNotice, PlayerState } from "../types";
import type { ModifierCard } from "./card";

export type RoomServiceKey =
  | "shield"
  | "prismGuard"
  | "wildcardGuard"
  | "cardBan"
  | "timePenalty"
  | "hijackBan";

/** Titanium Mirror multiplier per player. Persists across eras; only a fresh
 *  mirror deal resets it. Decays −0.1 per reflected block, floored at 0. */
export class ShieldService {
  private readonly mult = new Map<string, number>();
  getMultiplier(id: string): number {
    return this.mult.get(id) ?? 1;
  }
  decay(id: string, amount = 0.1): void {
    this.mult.set(id, Math.max(0, this.getMultiplier(id) - amount));
  }
  grantFresh(id: string): void {
    this.mult.set(id, 1);
  }
  has(id: string): boolean {
    return this.mult.has(id);
  }
}

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

/** Personal banned letters rolled by Roulette Wheel / Toll Booth, per card,
 *  reset each era. A player may hold several (one per ban-rolling card). */
export class CardBanService {
  private readonly bans = new Map<string, Map<string, string>>();
  roll(playerId: string, cardId: string, letter: string): void {
    const m = this.bans.get(playerId) ?? new Map<string, string>();
    m.set(cardId, letter);
    this.bans.set(playerId, m);
  }
  /** Letters personally banned for this player (deduped). */
  bansFor(playerId: string): string[] {
    return [...new Set((this.bans.get(playerId) ?? new Map()).values())];
  }
  /** The letter a specific card rolled (for chip display). */
  letterFor(playerId: string, cardId: string): string | null {
    return this.bans.get(playerId)?.get(cardId) ?? null;
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

/** The container of all room services, instantiated once per match. */
export class RoomServices {
  readonly shield = new ShieldService();
  readonly prismGuard = new EraGuard();
  readonly wildcardGuard = new EraGuard();
  readonly cardBan = new CardBanService();
  readonly timePenalty = new TimePenaltyService();
  readonly hijackBan = new HijackBanService();

  /** Draws personal banned letters for Roulette Wheel / Toll Booth at era start. */
  constructor(readonly banLetters: BanLetterService) {}

  /** Per-turn reset boundary (room services that re-arm each turn). No-op today. */
  fireTurnStarted(_player: PlayerState): void {
    // Reserved: turn-scoped services re-arm here (mirrors C# IRoomStateService.OnTurnStarted).
  }

  /** Reset the per-era guards for a player at an era boundary. The shield is
   *  deliberately NOT reset — it persists across eras (GDD §3.7). */
  fireEraStarted(player: PlayerState): void {
    this.prismGuard.resetEra(player.id);
    this.wildcardGuard.resetEra(player.id);
    this.cardBan.resetEra(player.id);
    this.hijackBan.resetEra(player.id);
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

/** Dependencies EngineEffects needs from the match to resolve + route attacks. */
export interface EngineEffectsDeps {
  /** Resolved bay cards for a player (to find an interceptor). */
  cardsOf(player: PlayerState): ModifierCard[];
  /** Active (non-eliminated) players in turn order. */
  activePlayers(): PlayerState[];
  /** The current round leader's id (highest score; turn order breaks ties). */
  leaderId(): string;
  /** Armed clock seconds for a player (for percentage time shaves). */
  armedClockOf(player: PlayerState): number;
}

/**
 * The facade through which automated attacks resolve. Each attack first tries
 * the victim's Titanium Mirror: if present it blocks + reflects (decaying the
 * shield) and the hit lands on the caster instead — single-shot, a reflected
 * hit is never re-reflected.
 */
export class EngineEffects {
  private notices: EngineEffectNotice[] = [];
  private siphons: { playerId: string; amount: number }[] = [];

  constructor(
    private readonly services: RoomServices,
    private readonly deps: EngineEffectsDeps,
  ) {}

  /** Record points siphoned from the resolving word (Tax Collector / Toll / Chrono). */
  recordSiphon(playerId: string, amount: number): void {
    this.siphons.push({ playerId, amount });
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

  /** Resolve the victim's interceptor: redirect to the caster on a block. */
  private route(
    caster: PlayerState,
    victim: PlayerState,
  ): { target: PlayerState; reflected: boolean } {
    const interceptor = this.deps.cardsOf(victim).find((c) => typeof c.intercept === "function");
    if (interceptor && interceptor.intercept!(victim, this.services)) {
      return { target: caster, reflected: true };
    }
    return { target: victim, reflected: false };
  }

  /** Shave seconds off the target's next armed clock (Flak Cannon). */
  timeShave(caster: PlayerState, victim: PlayerState, seconds: number, source: string): void {
    if (seconds <= 0) return;
    const { target, reflected } = this.route(caster, victim);
    this.services.timePenalty.queue(target.id, seconds);
    this.addNotice({ source, targetId: target.id, text: `−${seconds}s shot clock`, reflected });
  }

  /** Dock points from the target (Bounty Hunter). */
  drain(caster: PlayerState, victim: PlayerState, points: number, source: string): void {
    if (points <= 0) return;
    const { target, reflected } = this.route(caster, victim);
    target.score -= points;
    this.addNotice({ source, targetId: target.id, text: `−${points} pts`, reflected });
  }

  /** Curse the target with a personal banned letter for their next turn (Bait & Switch). */
  letterHijack(caster: PlayerState, victim: PlayerState, letter: string, source: string): void {
    if (!letter) return;
    const { target, reflected } = this.route(caster, victim);
    this.services.hijackBan.curse(target.id, letter);
    this.addNotice({ source, targetId: target.id, text: `letter "${letter}" banned`, reflected });
  }
}
