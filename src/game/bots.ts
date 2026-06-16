/*
 * Bot opponents. Given the required start letter, a bot queries the dictionary
 * first-letter index, filters out used words (and, when it can, the banned
 * letter to dodge the tax), then picks a word in a difficulty-tuned length band.
 * Pure logic — the "thinking" delay before it submits is added by the driver.
 */

import type { Dictionary } from "./dictionary";
import type { BotDifficulty } from "./types";

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

export function chooseBotWord(dict: Dictionary, opts: BotPick): string | null {
  const rng = opts.rng ?? Math.random;
  const [lo, hi] = LENGTH_BAND[opts.difficulty];

  const lettersToTry = opts.requiredLetter
    ? [opts.requiredLetter.toLowerCase()]
    : shuffle(ALPHABET, rng);

  for (const letter of lettersToTry) {
    const pool = dict.wordsStartingWith(letter);
    if (pool.length === 0) continue;

    const fresh = (w: string) => !opts.usedWords.has(w);
    const clean = (w: string) => opts.bannedLetter === "" || !w.includes(opts.bannedLetter);

    // Prefer: in-band length AND clean of the banned letter.
    const inBand = (w: string) => w.length >= lo && w.length <= hi;
    const tiers = [
      (w: string) => fresh(w) && clean(w) && inBand(w),
      (w: string) => fresh(w) && clean(w),
      (w: string) => fresh(w), // last resort: may eat the tax
    ];

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

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
