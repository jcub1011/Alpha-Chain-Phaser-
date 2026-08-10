/*
 * Bot opponents. Given the required start letter, a bot queries the dictionary
 * first-letter index, filters out used words (and, when it can, the banned
 * letter to dodge the tax), then picks a word in a difficulty-tuned length band.
 * Pure logic — the "thinking" delay before it submits is added by the driver.
 */

import { getCard } from "./cards/library";
import { bubblePreferences, isInertPreference } from "./picker/preference";
import { scoreWord, type ScoreOptions } from "./scoring";
import type { Dictionary } from "./dictionary";
import { shuffle } from "./rng";
import { CardOp, type BayCard, type BotDifficulty } from "./types";

const LENGTH_BAND: Record<BotDifficulty, [number, number]> = {
  easy: [3, 5],
  medium: [4, 7],
  hard: [6, 11],
};

/** Per-difficulty seconds the bot "thinks" before submitting. */
export const BOT_THINK_SECONDS: Record<BotDifficulty, [number, number]> = {
  easy: [2.5, 5.0],
  medium: [1.8, 3.8],
  hard: [1.2, 2.6],
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

export interface BotPick {
  requiredLetter: string; // "" = free choice
  usedWords: Set<string>;
  bannedLetter: string; // "" = none
  difficulty: BotDifficulty;
  rng?: () => number;
}

/** Shared candidate-gathering setup both pickers walk: the per-letter pools to scan
 *  (the required letter, or the shuffled alphabet) and the fresh → clean → in-band
 *  acceptance tiers, tried in order from strictest to loosest (last resort may eat the tax). */
function botCandidateTiers(opts: BotPick, rng: () => number) {
  const [lo, hi] = LENGTH_BAND[opts.difficulty];
  const lettersToTry = opts.requiredLetter
    ? [opts.requiredLetter.toLowerCase()]
    : shuffle(ALPHABET, rng);
  const fresh = (w: string) => !opts.usedWords.has(w);
  const clean = (w: string) => opts.bannedLetter === "" || !w.includes(opts.bannedLetter);
  const inBand = (w: string) => w.length >= lo && w.length <= hi;
  return {
    lettersToTry,
    tiers: [
      (w: string) => fresh(w) && clean(w) && inBand(w),
      (w: string) => fresh(w) && clean(w),
      (w: string) => fresh(w),
    ],
  };
}

export function chooseBotWord(dict: Dictionary, opts: BotPick): string | null {
  const rng = opts.rng ?? Math.random;
  const { lettersToTry, tiers } = botCandidateTiers(opts, rng);

  for (const letter of lettersToTry) {
    const pool = dict.wordsStartingWith(letter);
    if (pool.length === 0) continue;
    for (const accept of tiers) {
      const pick = sampleWhere(pool, accept, rng);
      if (pick) return pick;
    }
  }
  return null;
}

function sampleWhere(
  pool: readonly string[],
  accept: (w: string) => boolean,
  rng: () => number,
): string | null {
  // Reservoir sample one matching item in a single pass (avoids allocating).
  let chosen: string | null = null;
  let seen = 0;
  for (const w of pool) {
    if (!accept(w)) continue;
    seen++;
    if (rng() < 1 / seen) chosen = w;
  }
  return chosen;
}

// ── Card-aware bots (test-harness fidelity, NOT a balance target) ─────────────
// Bots score several candidate words through their OWN bay and pick the best, and
// order/trim their bay sensibly during optimize. All logic here is pure: any
// randomness comes from the injected `rng` (the net layer supplies it), never
// Math.random inside the deterministic game core.

/** How many candidate words each difficulty scores through the bay before picking
 *  (0 = naive: fall back to the plain length-band `chooseBotWord`). */
export const BOT_CANDIDATE_COUNT: Record<BotDifficulty, number> = {
  easy: 0,
  medium: 8,
  hard: 20,
};

export interface BotScoredPick extends BotPick {
  /** The bot's current engine bay, evaluated to rank candidate words. */
  bay: readonly BayCard[];
  /** Pure scoring context (taxed is decided per candidate). */
  scoreOpts: Omit<ScoreOptions, "taxed">;
  /** Distinct legal candidates to gather + score (see BOT_CANDIDATE_COUNT). */
  candidateCount: number;
}

/** Reservoir-sample up to `k` distinct words matching `accept`, adding them to
 *  `out` (skips words already in `out`). Single pass, no full sort. */
function sampleManyWhere(
  pool: readonly string[],
  accept: (w: string) => boolean,
  k: number,
  rng: () => number,
  out: Set<string>,
): void {
  if (k <= 0) return;
  const reservoir: string[] = [];
  let seen = 0;
  for (const w of pool) {
    if (out.has(w) || !accept(w)) continue;
    seen++;
    if (reservoir.length < k) reservoir.push(w);
    else {
      const j = Math.floor(rng() * seen);
      if (j < k) reservoir[j] = w;
    }
  }
  for (const w of reservoir) out.add(w);
}

/**
 * Card-aware word choice: gather up to `candidateCount` distinct legal candidates
 * (preferring clean + in-band, then clean, then any-fresh), score each through the
 * bot's own bay, and return the highest-scoring one (ties broken randomly for
 * variety). Falls back to the naive `chooseBotWord` for easy bots or when no
 * candidate is found.
 */
export function chooseBotWordScored(dict: Dictionary, opts: BotScoredPick): string | null {
  const rng = opts.rng ?? Math.random;
  if (opts.candidateCount <= 0) return chooseBotWord(dict, opts);

  const { lettersToTry, tiers } = botCandidateTiers(opts, rng);

  const candidates = new Set<string>();
  for (const letter of lettersToTry) {
    const pool = dict.wordsStartingWith(letter);
    if (pool.length === 0) continue;
    for (const accept of tiers) {
      sampleManyWhere(pool, accept, opts.candidateCount - candidates.size, rng, candidates);
      if (candidates.size >= opts.candidateCount) break;
    }
    if (candidates.size >= opts.candidateCount) break;
  }
  if (candidates.size === 0) return chooseBotWord(dict, opts);
  return bestScoredCandidate(candidates, opts, rng);
}

/**
 * Rank an already-gathered candidate set through a bay and return the best word.
 *
 * Split out from `chooseBotWordScored` because Picker replaces only the GATHERING half — the
 * Offer already is the candidate set, so a Picker bot needs this half verbatim and none of the
 * dictionary walking above. Ties break randomly (reservoir) so bots don't play identically when
 * several candidates score the same.
 */
export function bestScoredCandidate(
  candidates: Iterable<string>,
  opts: Pick<BotScoredPick, "bay" | "scoreOpts" | "bannedLetter">,
  rng: () => number = Math.random,
): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  let tieSeen = 0;
  for (const w of candidates) {
    const taxed = opts.bannedLetter !== "" && w.includes(opts.bannedLetter);
    const score = scoreWord(w, opts.bay, { ...opts.scoreOpts, taxed }).finalScore;
    if (score > bestScore) {
      bestScore = score;
      best = w;
      tieSeen = 1;
    } else if (score === bestScore) {
      tieSeen++;
      if (rng() < 1 / tieSeen) best = w; // reservoir tie-break for variety
    }
  }
  return best;
}

/** Engine-ordering rank: additives left, FX in the middle, multipliers right —
 *  so multipliers scale the accumulated base (mirrors the left→right fold). */
const OP_RANK: Record<string, number> = {
  [CardOp.Additive]: 0,
  [CardOp.Fx]: 1,
  [CardOp.Multiplicative]: 2,
};

/** A representative mid-length probe word used to value cards when trimming. */
const PROBE_WORD = "planets";

/**
 * Order + trim a bot's bay for the optimize phase. Sorts by op-rank (additives
 * left → multipliers right) and, when the bay exceeds `slots`, repeatedly drops
 * the card whose marginal contribution to a probe word's score is smallest.
 * Pure + deterministic. Returns ordered `uid` arrays for `setPlayerBay`.
 */
export function planBotBay(
  bay: readonly BayCard[],
  slots: number,
  scoreOpts: Omit<ScoreOptions, "taxed">,
): { engine: string[]; discard: string[] } {
  const isPref = (c: BayCard): boolean => isInertPreference(getCard(c.id));
  const rankOf = (id: string) => OP_RANK[getCard(id)?.op ?? CardOp.Fx] ?? 1;
  // Stable sort by op-rank (preserve original order within a rank).
  const kept = bay
    .map((card, index) => ({ card, index }))
    .sort((a, b) => rankOf(a.card.id) - rankOf(b.card.id) || a.index - b.index)
    .map((x) => x.card);

  const scoreOf = (cards: BayCard[]): number =>
    scoreWord(PROBE_WORD, cards, { ...scoreOpts, taxed: false }).finalScore;

  /* A Preference Card contributes NOTHING to scoreWord — it shapes the Offer, which the probe word
   * knows nothing about — so its marginal value is exactly 0. Left alone the trim loop would drop
   * every one of them first, deterministically, on the bot's very first optimize, and bots would
   * never be seen holding the family at all.
   *
   * So they are valued at a flat notional instead. The number is a heuristic, not a measurement:
   * high enough that a bot keeps one over a card that does nothing for the probe word (a
   * conditional multiplier the probe never triggers), low enough that it never displaces a real
   * contributor. And only ONE is protected — a bot that filled its bay with shape filters would
   * have a beautifully-shaped Offer and nothing to score it with. */
  const PREFERENCE_NOTIONAL = 6;
  let prefKept = 0;
  const valueOf = (i: number, full: number): number => {
    if (isPref(kept[i])) return prefKept++ === 0 ? PREFERENCE_NOTIONAL : 0;
    return full - scoreOf(kept.filter((_, j) => j !== i));
  };

  while (kept.length > slots) {
    const full = scoreOf(kept);
    let worstIdx = 0;
    let worstMarginal = Infinity;
    prefKept = 0;
    for (let i = 0; i < kept.length; i++) {
      const marginal = valueOf(i, full);
      if (marginal < worstMarginal) {
        worstMarginal = marginal;
        worstIdx = i;
      }
    }
    kept.splice(worstIdx, 1);
  }

  /* Bubble AFTER the trim, through the same helper the engine and the optimize UI use. Doing it
   * via OP_RANK instead would not work: the ranks place FX mid-bay, between additives and
   * multipliers, so a Preference Card would land in the middle of the scoring chain and the
   * authority would immediately reorder it — the bot's plan and the stored bay would disagree. */
  const ordered = bubblePreferences(kept, isPref);
  kept.length = 0;
  kept.push(...ordered);

  const keptSet = new Set(kept);
  const uidOf = (c: BayCard): string | undefined => c.uid;
  const engine = kept.map(uidOf).filter((u): u is string => !!u);
  const discard = bay
    .filter((c) => !keptSet.has(c))
    .map(uidOf)
    .filter((u): u is string => !!u);
  return { engine, discard };
}
