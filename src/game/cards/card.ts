/*
 * Card model. A ModifierCard folds into the score via `fold()` and expresses
 * everything beyond pure scoring through optional capability fields (clock
 * modifiers, reactive tags). This keeps scoring.ts's loop closed to change as
 * the remaining 28 cards are added later — a new card "implements the fields"
 * rather than touching the evaluator.
 */

import { isVowel } from "../settings";
import type { CardFamily, CardOp } from "../types";

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
  valueText: `+${amount}`,
});

const mul = (value: number, factor: number): FoldResult => ({
  triggered: true,
  value: value * factor,
  valueText: `×${factor}`,
});

export { isVowel, RARE_START, skip, fx, add, mul };
