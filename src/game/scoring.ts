/*
 * EngineEvaluator port (alpha-chain-gdd.md §5). Scores a word by walking the
 * player's Engine Bay strictly left → right as a sequential fold: the running
 * value seeds with the word length, then each triggered card folds itself in.
 * Placement order matters — a multiplier before an additive scales a smaller
 * base. The walk emits a per-card ScoreStep trace the UI replays.
 */

import { getCard } from "./cards/library";
import { buildMagnifier } from "./cards/magnifier";
import { skip, type EvalContext, type ModifierCard } from "./cards/card";
import { isInertPreference } from "./picker/preference";
import type { EngineEffects, RoomServices } from "./cards/roomServices";
import { BASE_TIMEOUT_PENALTY, isVowel, MAX_WORD_SCORE, MIN_SHOT_CLOCK_SECONDS } from "./settings";
import type {
  BayCard,
  GameMode,
  PlayerState,
  ScoreBreakdown,
  ScoreStep,
  Submission,
} from "./types";

/** The per-word facts shared by every card, before bay-position context. */
export type WordAnalysis = Pick<
  EvalContext,
  | "word"
  | "length"
  | "vowelCount"
  | "consonantCount"
  | "distinctLetters"
  | "hasRepeatLetter"
  | "startsWith"
  | "endsInVowel"
  | "prevWordLength"
  | "clockRemaining"
  | "clockTotal"
>;

/** Character indices in `word` that classify as vowels under `classify`. */
const classifyIndices = (word: string, classify: (ch: string) => boolean): number[] => {
  const out: number[] = [];
  for (let i = 0; i < word.length; i++) if (classify(word[i])) out.push(i);
  return out;
};

/** Round half-up (matches the C# MidpointRounding.AwayFromZero for positives). */
export const roundHalfUp = (n: number): number => Math.floor(n + 0.5);

/** Build the per-word analysis shared by every card. */
export function analyzeWord(
  word: string,
  prevWordLength: number,
  clockRemaining: number,
  clockTotal: number,
): WordAnalysis {
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
  /**
   * Which mode's card values this evaluation scores with.
   *
   * REQUIRED, so no caller can silently score Picker with Classic's numbers — see `getCard`. Pass
   * `MatchController.effectiveMode`, never the raw `settings.gameMode`: a Picker match that fell
   * back for want of a word pool arms Classic's clock, so it must score on Classic's curves too.
   *
   * Reaches the bots for free through `opts.scoreOpts` (bots.ts), which is why bots.ts needs no
   * mode of its own.
   */
  mode: GameMode;
  /** Base shot-clock seconds for the match (defaults to clockTotal). */
  baseClockSeconds?: number;
  /** Current era, 1-based. Defaults to 1. */
  era?: number;
  /** Owner's bay slot capacity (Booster Pack scales by it). Defaults to bayLength. */
  slots?: number;
  /** Words submitted so far this match (Blueprint / Scavenger). Defaults to []. */
  history?: readonly Submission[];
  // ── Hook-only context (threaded by match.ts for capability checks + lifecycle) ──
  services?: RoomServices;
  effects?: EngineEffects;
  player?: PlayerState;
  players?: readonly PlayerState[];
  clock?: { refillToFull(): void };
}

/** A bay resolved against a word, with the per-slot context factory both the
 *  scoring fold and the capability checks (legality, succession, tax policy)
 *  share. All accessors key on SLOT INDEX, never the shared card singleton. */
export interface BayEvaluator {
  resolved: (ModifierCard | undefined)[];
  ctxFor(index: number): EvalContext;
}

export function makeBayEvaluator(
  word: string,
  bay: readonly BayCard[],
  opts: ScoreOptions,
): BayEvaluator {
  const base = analyzeWord(word, opts.prevWordLength, opts.clockRemaining, opts.clockTotal);
  const resolved = bay.map((slot) => getCard(slot.id, opts.mode));
  const reg = buildMagnifier(resolved);

  /* Preference Cards are invisible to BAY-SIZE scoring: they must not count toward bay length or
   * "cards to the right", or Dividend (+2 per card in your bay) and Booster Pack (+2 per card to
   * its right) would silently inflate — Booster Pack doubly so, since bubbling puts every
   * Preference Card to its left.
   *
   * This is done by masking the three SIZE channels, NOT by filtering the bay array, which is what
   * it first looks like it should be. Filtering would renumber every slot, and slot index is
   * load-bearing in four separate places: CardBanService keys personal bans by `cardIndex`, The
   * Flywheel excludes itself with `i !== c.cardIndex`, the magnifier registry maps a glass at `i`
   * onto `i + 1`, and both <ac-score-replay> and the HUD's Offer projection align `steps[]` with
   * `player.bay` one-to-one. A shorter array would quietly break all four, and each would fail as a
   * wrong number rather than an error.
   *
   * `bayCardIds` deliberately stays the FULL list: its only reader is The Flywheel, which already
   * self-filters to multiplier cards, so the inert (FX) Preference Cards are invisible to it
   * anyway — and keeping it full is what preserves its `i !== c.cardIndex` self-exclusion. */
  const counts = resolved.map((card) => (isInertPreference(card) ? 0 : 1));
  const scoringCount = counts.reduce((sum: number, n) => sum + n, 0);
  /** Scoring cards strictly to the right of `index`. */
  const scoringRightOf = (index: number): number =>
    counts.reduce((sum: number, n, i) => (i > index ? sum + n : sum), 0);

  // Perceived letter count seen by the card at `index` (Forgery stacks because
  // its own perceivedLength reads perceivedLengthAt(forgeryIndex) recursively).
  const perceivedLengthAt = (index: number): number => {
    for (let j = index - 1; j >= 0; j--) {
      const provider = resolved[j];
      if (provider?.perceivedLength) return provider.perceivedLength(ctxFor(j));
    }
    return base.length;
  };
  const vowelClassifierAt = (index: number): ((ch: string) => boolean) => {
    for (let j = index - 1; j >= 0; j--) {
      const c = resolved[j];
      if (c?.isVowel) return (ch) => c.isVowel!(ch);
    }
    return isVowel;
  };
  const consonantClassifierAt = (index: number): ((ch: string) => boolean) => {
    for (let j = index - 1; j >= 0; j--) {
      const c = resolved[j];
      if (c?.isConsonant) return (ch) => c.isConsonant!(ch);
    }
    return (ch) => !isVowel(ch);
  };

  const ctxFor = (index: number): EvalContext => ({
    ...base,
    cardsToRight: scoringRightOf(index),
    cardIndex: index,
    bayLength: scoringCount,
    era: opts.era ?? 1,
    // The `slots` fallback tracks the masked count too, so a caller that omits slots (tests, the
    // clock context) sees the same bay the size-reading cards do.
    slots: opts.slots ?? scoringCount,
    baseClockSeconds: opts.baseClockSeconds ?? opts.clockTotal,
    history: opts.history ?? [],
    bayCardIds: bay.map((slot) => slot.id),
    resolveWordLength: () => perceivedLengthAt(index),
    vowelIndices: () => classifyIndices(base.word, vowelClassifierAt(index)),
    consonantIndices: () => classifyIndices(base.word, consonantClassifierAt(index)),
    magnification: () => reg.getMagnification(index),
    services: opts.services,
    effects: opts.effects,
    player: opts.player,
    players: opts.players,
    clock: opts.clock,
  });

  return { resolved, ctxFor };
}

/** Score a word against a bay, producing the full breakdown. */
export function scoreWord(
  word: string,
  bay: readonly BayCard[],
  opts: ScoreOptions,
): ScoreBreakdown {
  const { resolved, ctxFor } = makeBayEvaluator(word, bay, opts);
  const seed = word.toLowerCase().length;
  let value = seed;
  const steps: ScoreStep[] = [];

  resolved.forEach((card, index) => {
    if (!card) return;
    const ctx = ctxFor(index);
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
    word: word.toLowerCase(),
    seed,
    steps,
    finalBeforeTax,
    taxed: opts.taxed,
    finalScore: opts.taxed ? 0 : finalBeforeTax,
  };
}

/**
 * The penalty a player suffers when their shot clock expires, as a breakdown the
 * SAME engine-replay animates (so the UI shows which cards hurt and by how much).
 * Mirrors `scoreWord`: seeds at −BASE_TIMEOUT_PENALTY (the flat base loss), then
 * folds each card's `timeoutFold` left → right (a card without one is an inert,
 * skipped step). One step per bay slot keeps the array aligned 1:1 with the
 * replay fan. `finalScore` is the net signed delta (usually negative) the caller
 * adds to the owner's score. There is no word, so the bay is evaluated against "".
 */
export function scoreTimeout(bay: readonly BayCard[], opts: ScoreOptions): ScoreBreakdown {
  const { resolved, ctxFor } = makeBayEvaluator("", bay, opts);
  const seed = -BASE_TIMEOUT_PENALTY;
  let value = seed;
  const steps: ScoreStep[] = [];

  resolved.forEach((card, index) => {
    if (!card) return;
    const ctx = ctxFor(index);
    const r = card.timeoutFold ? card.timeoutFold(value, ctx) : skip(value);
    value = r.value;
    steps.push({
      cardId: card.id,
      name: card.name,
      family: card.family,
      triggered: r.triggered,
      valueText: r.valueText,
      runningScore: roundHalfUp(value),
    });
  });

  let finalScore = roundHalfUp(value);
  // A card may negate the timeout loss entirely (Insurance): floor the net at 0 so it
  // never matters whether a glass-cannon drain sits to the right of that card.
  if (finalScore < 0 && resolved.some((c) => c?.negatesTimeoutLoss)) finalScore = 0;
  return { word: "", seed, steps, finalBeforeTax: finalScore, taxed: false, finalScore };
}

// ── Whole-bay capability helpers (used by match.ts; mirror the C# extensions) ──

/** Any card marks the word illegal → it takes the Zero-Point Tax (Slow Burn). */
export function bayViolatesLegality(ev: BayEvaluator): boolean {
  return ev.resolved.some((c, i) => c?.illegalWord?.(ev.ctxFor(i)) ?? false);
}

/** Any card grants a Succession exemption right now (Wildcard, guard-aware). */
export function baySuccessionExempt(ev: BayEvaluator): boolean {
  return ev.resolved.some((c, i) => c?.ignoresSuccession?.(ev.ctxFor(i)) ?? false);
}

/** The owner's own-tax policy (IRS Agent): the kept score + whether siphons are suppressed. */
export function bayOwnTaxPolicy(
  ev: BayEvaluator,
): { score(wouldBe: number): number; suppress: boolean } | null {
  for (let i = 0; i < ev.resolved.length; i++) {
    const c = ev.resolved[i];
    if (c?.ownTaxScore) {
      const idx = i;
      return {
        score: (wouldBe) => c.ownTaxScore!(ev.ctxFor(idx), wouldBe),
        suppress: !!c.suppressesSiphon,
      };
    }
  }
  return null;
}

/** Sum of every Tax Write-Off bonus in the bay (each re-scores the first letter
 *  clean through its own slot). Stacks: N copies salvage N times. */
export function bayWriteOffBonus(ev: BayEvaluator, scoreFn: (word: string) => number): number {
  let bonus = 0;
  for (let i = 0; i < ev.resolved.length; i++) {
    const c = ev.resolved[i];
    if (c?.writeOffBonus) bonus += c.writeOffBonus(ev.ctxFor(i), scoreFn);
  }
  return bonus;
}

/** Whether any card hides the owner's own input (Blindfold). */
export function bayHidesInput(ev: BayEvaluator): boolean {
  return ev.resolved.some((c) => c?.hidesInput?.() ?? false);
}

/** Fire a lifecycle hook across a bay, in slot order (mutations land via ctx). */
export function fireBayHook(
  ev: BayEvaluator,
  hook: "onEraStart" | "onWordAccepted" | "onTurnEnded" | "onOpponentWordResolved",
  extra?: Partial<EvalContext>,
): void {
  ev.resolved.forEach((c, i) => {
    const fn = c?.[hook];
    if (fn) fn.call(c, { ...ev.ctxFor(i), ...extra });
  });
}

/**
 * The owner's armed shot clock (ports AlphaChainGameState.ComputeArmedShotClockSeconds):
 *   1. An override (Anchor Chain) pins the clock — smallest wins — ignoring everything else.
 *   2. The base is the smallest base-clock replacement, else `baseSeconds`.
 *   3. Per-owner clock effects fold in: fractions summed (each scaled by a Magnifying Glass
 *      on its left), then flat seconds.
 *   4. A cap (Hyper-Drive's 5s) lowers a longer clock but never raises a shorter one.
 *   5. Floored at the 3s minimum.
 *
 * `mode` resolves the bay's cards, so a per-mode `clock` cost applies here. This is the one engine
 * path that resolves cards outside `ScoreOptions`, which is why it takes the mode directly.
 */
export function armedClockSeconds(
  baseSeconds: number,
  bay: readonly BayCard[],
  mode: GameMode,
): number {
  const resolved = bay.map((slot) => getCard(slot.id, mode));
  const reg = buildMagnifier(resolved);
  // Clock capabilities ignore the word, so a minimal empty-word context suffices.
  const ctx: EvalContext = {
    ...analyzeWord("", 0, 0, baseSeconds),
    cardsToRight: 0,
    cardIndex: 0,
    bayLength: bay.length,
    era: 1,
    baseClockSeconds: baseSeconds,
    history: [],
    resolveWordLength: () => 0,
    vowelIndices: () => [],
    consonantIndices: () => [],
    magnification: () => 1,
  };

  // 1. Override (smallest wins) — pins the clock, ignoring effects + caps.
  let override: number | null = null;
  for (const c of resolved) {
    const o = c?.shotClockOverride?.(ctx);
    if (o != null) override = override == null ? o : Math.min(override, o);
  }
  if (override != null) return Math.max(MIN_SHOT_CLOCK_SECONDS, Math.round(override));

  // 2. Base (smallest replacement, else the match base).
  let base = baseSeconds;
  for (const c of resolved) {
    const b = c?.baseShotClock?.(ctx);
    if (b != null) base = Math.min(base, b);
  }

  // 3. Clock effects: magnified fractions, then magnified flat seconds.
  let fraction = 0;
  let flat = 0;
  resolved.forEach((c, i) => {
    if (!c?.clock) return;
    const mag = reg.getMagnification(i);
    fraction += (c.clock.pctDelta ?? 0) * mag;
    flat += (c.clock.flatDelta ?? 0) * mag;
  });
  let armed = Math.round(base * (1 + fraction) + Math.round(flat));

  // 4. Cap (smallest) — lowers only.
  let cap: number | null = null;
  for (const c of resolved) {
    const k = c?.shotClockCap?.(ctx);
    if (k != null) cap = cap == null ? k : Math.min(cap, k);
  }
  if (cap != null) armed = Math.min(armed, cap);

  // 5. Floor.
  return Math.max(MIN_SHOT_CLOCK_SECONDS, armed);
}
