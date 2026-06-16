/*
 * Card model. A ModifierCard folds into the score via `fold()` and expresses
 * everything beyond pure scoring through optional capability hooks (clock
 * effects, perceived length, letter classification, tax policy, succession
 * exemption, attack interception, input mask, the magnifier) and optional
 * lifecycle hooks (era start, word accepted, turn ended, opponent word
 * resolved, validation failed). This mirrors the Blazor IModifierCard surface
 * (alpha-chain-gdd.md §5.3): the evaluator discovers a card's capabilities by
 * walking the bay, so the scoring loop stays closed to change — a new card
 * "implements the fields" rather than touching the evaluator.
 *
 * Capability/lifecycle hooks are all optional; presence = opting in. Pure
 * scoring stays in `fold()`; side-effecting state lives in the room services
 * (roomServices.ts), reached through `ctx.services` inside the hooks.
 */

import { isVowel, MAX_WORD_SCORE } from "../settings";
import type { CardFamily, CardOp, PlayerState, Submission, WordResolution } from "../types";
import type { EffectMagnifier } from "./magnifier";
import type { EngineEffects, RoomServices, RoomServiceKey } from "./roomServices";

/** Everything a card needs to decide its trigger + magnitude for one word. */
export interface EvalContext {
  word: string; // lowercased
  length: number; // actual letter count
  vowelCount: number;
  consonantCount: number;
  distinctLetters: number;
  hasRepeatLetter: boolean;
  startsWith: string; // first letter
  endsInVowel: boolean;
  prevWordLength: number; // length of the previously submitted word (0 = first)
  cardsToRight: number; // bay slots to the right of this card
  clockRemaining: number;
  clockTotal: number;

  // ── Bay position + history (richer context for the 40-card set) ──
  /** This card's slot index in the bay (set by the evaluator before each fold). */
  cardIndex: number;
  /** Total slots in the bay being evaluated. */
  bayLength: number;
  /** The match's base shot-clock seconds (settings.shotClockSeconds). */
  baseClockSeconds: number;
  /** Words submitted so far this match (Blueprint / Scavenger read this). */
  history: readonly Submission[];

  // ── Capability accessors injected by the evaluator (§5.2). They let a card
  //    "walk the bay up to itself" without knowing about other cards. Each
  //    EvalContext is built for a specific slot (`cardIndex`), so these need no
  //    `self` argument — they resolve relative to the card being evaluated. ──
  /** Forgery-aware perceived letter count for the card at the current slot. */
  resolveWordLength(): number;
  /** Catalyst-aware vowel character indices for the card at the current slot. */
  vowelIndices(): number[];
  /** Catalyst-aware consonant character indices for the card at the current slot. */
  consonantIndices(): number[];
  /** Magnifying-Glass factor applied to the card at the current slot (1.0 = none). */
  magnification(): number;

  // ── Hook-only context (present when firing lifecycle hooks, not pure scoring) ──
  services?: RoomServices;
  effects?: EngineEffects;
  player?: PlayerState;
  players?: readonly PlayerState[];
  resolution?: WordResolution;
  /** The owner's live shot-clock controller (Prism refills it on a typo). */
  clock?: { refillToFull(): void };
}

export interface FoldResult {
  triggered: boolean;
  /** Running value after this card folds in. */
  value: number;
  /** Display chip for the score replay, e.g. "+12", "×1.5", "FX", "—". */
  valueText: string;
}

/** A permanent shot-clock adjustment the card applies when its owner's turn arms. */
export interface ClockModifier {
  /** Fractional delta applied first, e.g. -0.10 (Vault) or +0.30 (Heat Sink). */
  pctDelta?: number;
  /** Flat seconds delta applied after fractions. */
  flatDelta?: number;
}

/** Re-entrant scorer handed to Tax Write-Off so it can re-score a clean word. */
export type ScoreFn = (word: string) => number;

export interface ModifierCard {
  id: string; // matches the SVG symbol id
  name: string;
  family: CardFamily;
  op: CardOp;
  /** Static chip shown on the card face, e.g. "+10", "×1.5", "FX". */
  magnitudeText: string;
  description: string;
  /**
   * Hand-tuned per-card identity color (the `--gc-card-color` that tints the
   * gradient / icon box / watermark), distinct from the standardized family
   * accent (the border). Ported from the Blazor `CardStyles.CardColor`. Falls
   * back to the family accent when unset.
   */
  color?: string;
  /** Owner-clock modifier applied at turn arm (glass-cannon / utility cards). */
  clock?: ClockModifier;
  /** Reactive economy tag handled by match logic, not the scoring fold. */
  reactive?: "tax-collector";

  /**
   * Fold this card into the running score. FX cards return the value unchanged
   * with a "FX" chip. Returns `triggered:false` (chip "—") when its condition
   * is not met.
   */
  fold(value: number, ctx: EvalContext): FoldResult;

  // ── Capability hooks (all optional; presence = opting in) ──
  /** IShotClockOverride — pins the clock to a fixed value (Anchor Chain). */
  shotClockOverride?(ctx: EvalContext): number | null;
  /** IShotClockCap — lowers a longer clock, never raises (Hyper-Drive). */
  shotClockCap?(ctx: EvalContext): number | null;
  /** IBaseShotClockProvider — replaces the base before deltas. */
  baseShotClock?(ctx: EvalContext): number | null;
  /** ILetterCountModifier — perceived length for length-scoring cards after it (Forgery).
   *  Receives an EvalContext built for its OWN slot, so it stacks by calling
   *  ctx.resolveWordLength() (the count before it) and ctx.magnification(). */
  perceivedLength?(ctx: EvalContext): number;
  /** IVowelChecker — overrides vowel classification for cards after it (Catalyst). */
  isVowel?(ch: string): boolean;
  /** IConsonantChecker — overrides consonant classification for cards after it. */
  isConsonant?(ch: string): boolean;
  /** IWordLegalityRule — marks an otherwise-valid word illegal → taxed (Slow Burn). */
  illegalWord?(ctx: EvalContext): boolean;
  /** IOwnTaxPolicy — the score the owner keeps when their own word is taxed (IRS Agent → 0). */
  ownTaxScore?(ctx: EvalContext, wouldBe: number): number;
  /** IOwnTaxPolicy — suppresses opponents' tax-collector bounties on the owner's taxed word. */
  suppressesSiphon?: boolean;
  /** ITaxWriteOffPolicy — bonus added on top of a taxed word by re-scoring its first letter. */
  writeOffBonus?(ctx: EvalContext, score: ScoreFn): number;
  /** ISuccessionExemption — lets a word ignore the chain succession rule (Wildcard). */
  ignoresSuccession?(ctx: EvalContext): boolean;
  /** IAttackInterceptor — block + reflect an incoming automated attack (Titanium Mirror). */
  intercept?(owner: PlayerState, services: RoomServices): boolean;
  /** IInputMask — hides the owner's own input glyphs while typing (Blindfold). */
  hidesInput?(ctx: EvalContext): boolean;
  /** Magnifying Glass pushes a magnification onto its immediate-right neighbor. */
  submitMagnifications?(reg: EffectMagnifier, selfIndex: number): void;

  // ── Lifecycle hooks (default no-op; only override what a card needs) ──
  onEraStart?(ctx: EvalContext): void;
  onWordAccepted?(ctx: EvalContext): void;
  onTurnEnded?(ctx: EvalContext): void;
  onOpponentWordResolved?(ctx: EvalContext): void;
  onValidationFailed?(ctx: EvalContext): void;

  /** Room-state services this card relies on (IContributesRoomServices). */
  roomServices?: RoomServiceKey[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RARE_START = new Set(["q", "x", "z", "j"]);

const skip = (value: number): FoldResult => ({
  triggered: false,
  value,
  valueText: "—",
});

const fx = (value: number): FoldResult => ({
  triggered: true,
  value,
  valueText: "FX",
});

const add = (value: number, amount: number): FoldResult => ({
  triggered: true,
  value: value + amount,
  valueText: amount < 0 ? `−${Math.abs(amount)}` : `+${amount}`,
});

const mul = (value: number, factor: number): FoldResult => ({
  triggered: true,
  value: value * factor,
  valueText: `×${factor}`,
});

/** Round half-up and clamp to [0, MAX_WORD_SCORE] (ports ModifierMath.ClampScore).
 *  Used by the reactive economy (siphon / toll / chrono payouts). */
const clampScore = (n: number): number =>
  Math.min(MAX_WORD_SCORE, Math.max(0, Math.floor(n + 0.5)));

export { isVowel, RARE_START, skip, fx, add, mul, clampScore };
