/*
 * EngineEvaluator port (alpha-chain-gdd.md §5). Scores a word by walking the
 * player's Engine Bay strictly left → right as a sequential fold: the running
 * value seeds with the word length, then each triggered card folds itself in.
 * Placement order matters — a multiplier before an additive scales a smaller
 * base. The walk emits a per-card ScoreStep trace the UI replays.
 */

import { getCard } from "./cards/library";
import type { EvalContext } from "./cards/card";
import { isVowel, MAX_WORD_SCORE, MIN_SHOT_CLOCK_SECONDS } from "./settings";
import type { BayCard, ScoreBreakdown, ScoreStep } from "./types";

/** Round half-up (matches the C# MidpointRounding.AwayFromZero for positives). */
export const roundHalfUp = (n: number): number => Math.floor(n + 0.5);

/** Build the per-word analysis shared by every card. */
export function analyzeWord(
  word: string,
  prevWordLength: number,
  clockRemaining: number,
  clockTotal: number,
): Omit<EvalContext, "cardsToRight"> {
  const w = word.toLowerCase();
  let vowels = 0;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const ch of w) {
    if (isVowel(ch)) vowels++;
    seen.add(ch);
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let hasRepeat = false;
  for (const n of counts.values()) {
    if (n >= 2) {
      hasRepeat = true;
      break;
    }
  }
  return {
    word: w,
    length: w.length,
    vowelCount: vowels,
    consonantCount: w.length - vowels,
    distinctLetters: seen.size,
    hasRepeatLetter: hasRepeat,
    startsWith: w[0] ?? "",
    endsInVowel: w.length > 0 && isVowel(w[w.length - 1]),
    prevWordLength,
    clockRemaining,
    clockTotal,
  };
}

export interface ScoreOptions {
  prevWordLength: number;
  clockRemaining: number;
  clockTotal: number;
  /** True if the word is subject to the Zero-Point Tax (banned letter, not exempt). */
  taxed: boolean;
}

/** Score a word against a bay, producing the full breakdown. */
export function scoreWord(
  word: string,
  bay: readonly BayCard[],
  opts: ScoreOptions,
): ScoreBreakdown {
  const base = analyzeWord(
    word,
    opts.prevWordLength,
    opts.clockRemaining,
    opts.clockTotal,
  );
  const seed = base.length;
  let value = seed;
  const steps: ScoreStep[] = [];

  bay.forEach((slot, index) => {
    const card = getCard(slot.id);
    if (!card) return;
    const ctx: EvalContext = { ...base, cardsToRight: bay.length - 1 - index };
    const r = card.fold(value, ctx);
    value = r.value;
    steps.push({
      cardId: card.id,
      name: card.name,
      family: card.family,
      triggered: r.triggered,
      valueText: r.valueText,
      runningScore: roundHalfUp(Math.min(value, MAX_WORD_SCORE)),
    });
  });

  const finalBeforeTax = Math.min(roundHalfUp(value), MAX_WORD_SCORE);
  return {
    word: base.word,
    seed,
    steps,
    finalBeforeTax,
    taxed: opts.taxed,
    finalScore: opts.taxed ? 0 : finalBeforeTax,
  };
}

/**
 * The owner's armed shot clock after applying every card's clock modifier:
 * fractional deltas summed first, then flat seconds, floored at the 3s minimum.
 */
export function armedClockSeconds(
  baseSeconds: number,
  bay: readonly BayCard[],
): number {
  let pct = 0;
  let flat = 0;
  for (const slot of bay) {
    const mod = getCard(slot.id)?.clock;
    if (!mod) continue;
    pct += mod.pctDelta ?? 0;
    flat += mod.flatDelta ?? 0;
  }
  const armed = baseSeconds * (1 + pct) + flat;
  return Math.max(MIN_SHOT_CLOCK_SECONDS, Math.round(armed));
}
