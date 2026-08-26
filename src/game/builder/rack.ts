/*
 * Word Builder Tile Generator — the reverse-seeded Golden Seed pipeline.
 *
 * Implements Word Builder Mode's tile rack generation and sub-word profiler as specified in
 * docs/implementation/word-builder-implementation-revision.md.
 *
 * PURITY & SANDBOX CONSTRAINTS:
 * Bundled into authority.js and executed in the Jint sandbox. No Date, no fetch, no DOM.
 * All RNG is injected via dependency parameters.
 *
 * PIPELINE STAGES:
 * 1. Golden Seed Selection: pick a 7-9 letter word starting with the required letter, scored for
 *    combinatorial fertility (common vowels and consonants).
 * 2. Tile Decomposition: extract morpheme chunks (-ING, -ED, -TION, etc.) and single letters.
 * 3. Catalyst Injection: pad rack to target capacity (default 9-10 tiles) while maintaining target
 *    vowel ratio (35%-45%) and high-utility inflections (S, D, R, E, Y, -ED, -ING).
 * 4. Sub-Word Profiler & Diversity Guardrail: verify Diversity Contract (>= 1 word 7+L, >= 2 words 4-6L,
 *    >= 2 distinct ending letters) via bitmask/frequency scanning.
 */

import { RARE_START } from "../cards/card";
import { isVowel } from "../settings";
import type { PoolIndex } from "../picker/offer";
import type { WordPool } from "../picker/wordPool";

/** A single tile on a player's rack. */
export interface Tile {
  /** Unique tile identifier within the rack (e.g. "t0", "t1"). */
  id: string;
  /** Lowercased text payload (e.g. "c", "re", "ing"). UI renders uppercase. */
  text: string;
  /** True if this tile represents a multi-letter chunk/morpheme. */
  isChunk: boolean;
}

/** Configuration and context for generating a rack. */
export interface RackRequest {
  pool: WordPool;
  index: PoolIndex;
  /** Required first letter of the word ("" = free choice). */
  requiredLetter: string;
  /** Words already played this match to exclude from seed selection. */
  usedWords: ReadonlySet<string>;
  /** Target rack capacity (default: 9). Modified by Wide Net (+2) and Tunnel Vision (-2). */
  rackSize?: number;
  /** Injected RNG returning [0, 1). */
  rng: () => number;
  /** Active banned letters (taxed or personal bans) to avoid if Sentinel or shaping applies. */
  bannedLetters?: readonly string[];
  /** Shaping flags from Preference / Lens Cards. */
  shaping?: RackShaping;
}

/** Shaping modifiers from active Preference Cards. */
export interface RackShaping {
  /** Sieve: Seed word must be at least 8 letters. */
  minSeedLength?: number;
  /** Tide: Rack must maintain >= 50% vowel ratio. */
  highVowelRatio?: boolean;
  /** Prospector: Rack guaranteed >= 1 rare letter tile (Q, X, Z, J). */
  guaranteeRare?: boolean;
  /** Sentinel: Rack guaranteed to contain no banned letters. */
  excludeBannedLetters?: boolean;
  /** Tile slot delta (e.g. +2 Wide Net, -2 Tunnel Vision). */
  slotDelta?: number;
}

/** Result of rack generation. */
export interface RackResult {
  /** The generated tiles for the player's rack. */
  tiles: Tile[];
  /** The Golden Seed word used to guarantee solvability. */
  seedWord: string;
  /** Number of valid sub-words discovered by the profiler. */
  subWordCount: number;
  /** Whether the rack passed the full Diversity Contract. */
  diversityPassed: boolean;
}

/** Default rack size if unspecified. */
export const DEFAULT_RACK_SIZE = 9;

/** Minimum and maximum allowable rack sizes after modifiers. */
export const MIN_RACK_SIZE = 6;
export const MAX_RACK_SIZE = 12;

/** Common morpheme chunk affixes for extraction. Ordered longest-first for greedy matching. */
export const MORPHEME_SUFFIXES: readonly string[] = [
  "tion",
  "sion",
  "ment",
  "ness",
  "able",
  "ible",
  "less",
  "ence",
  "ance",
  "ally",
  "ful",
  "ous",
  "ive",
  "ism",
  "ist",
  "ity",
  "ent",
  "ant",
  "ing",
  "est",
  "ers",
  "ies",
  "ed",
  "ly",
  "es",
  "er",
  "al",
  "ic",
  "en",
  "ty",
  "ry",
];

export const ROOT_CHUNKS: readonly string[] = [
  // 3-letter common roots / vowel patterns
  "and",
  "all",
  "art",
  "ear",
  "air",
  "our",
  "str",
  "thr",
  "igh",
  "ore",
  "are",
  "ere",
  "ire",
  "ure",
  "ate",
  "ite",
  "one",
  "ine",
  "ane",
  "ain",
  "ent",
  // 2-letter vowel teams
  "ea",
  "ee",
  "oo",
  "ou",
  "ai",
  "ay",
  "oa",
  "oi",
  "oy",
  "au",
  "aw",
  // 2-letter consonant digraphs & blends
  "th",
  "sh",
  "ch",
  "ph",
  "qu",
  "ck",
  "st",
  "sp",
  "sk",
  "sl",
  "sm",
  "sn",
  "sw",
  "bl",
  "cl",
  "fl",
  "gl",
  "pl",
  "br",
  "cr",
  "dr",
  "fr",
  "gr",
  "pr",
  "tr",
  "nd",
  "nt",
  "nk",
  "mp",
  "lt",
  "ft",
  "ct",
  "ar",
  "or",
  "ir",
  "ur",
  "an",
  "en",
  "in",
  "on",
  "un",
];

export const MORPHEME_PREFIXES: readonly string[] = [
  "dis",
  "pre",
  "pro",
  "con",
  "re",
  "un",
  "de",
  "in",
];

/** Universal catalyst consonants and inflections. */
const CATALYST_CONSONANTS: readonly string[] = ["s", "d", "r", "t", "n", "l", "y", "m", "p", "c"];
const CATALYST_VOWELS: readonly string[] = ["a", "e", "i", "o", "u"];
const CATALYST_CHUNKS: readonly string[] = [
  "ed",
  "ing",
  "es",
  "ly",
  "er",
  "st",
  "re",
  "un",
  "th",
  "sh",
  "ch",
  "ea",
  "an",
  "in",
  "on",
  "ar",
  "or",
];
const RARE_LETTERS: readonly string[] = ["q", "x", "z", "j"];

/** High-utility consonants given positive weight in fertility scoring. */
const FERTILE_LETTERS = new Set(["r", "s", "t", "l", "n", "d", "e", "a", "i", "o"]);

/**
 * In-place Fisher-Yates shuffle using deterministic injected RNG.
 */
export function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

/**
 * Score a candidate seed word for combinatorial fertility.
 * Words with diverse, common consonants and vowels score higher because they yield
 * rich sub-word anagram spaces.
 */
export function scoreSeedFertility(word: string, bannedLetters: ReadonlySet<string>): number {
  let score = 0;
  const seen = new Set<string>();

  for (const ch of word) {
    if (bannedLetters.has(ch)) score -= 20;
    if (FERTILE_LETTERS.has(ch)) score += 3;
    if (isVowel(ch)) score += 2;
    if (RARE_START.has(ch)) score -= 2;
    if (seen.has(ch)) score -= 1.5; // Slight penalty for duplicate letters
    seen.add(ch);
  }

  return Math.max(1, score);
}

/**
 * Decompose a seed word into a rich combination of morpheme chunks, root phonograms, and single letters.
 * The first letter (the Succession letter) is ALWAYS preserved as a single-letter tile so the player
 * is never locked into multi-letter prefixes for their initial letter.
 */
export function decomposeSeed(seed: string): { text: string; isChunk: boolean }[] {
  const s = seed.toLowerCase();
  if (s.length === 0) return [];
  if (s.length === 1) return [{ text: s, isChunk: false }];

  const result: { text: string; isChunk: boolean }[] = [];
  // 1. Succession letter (always single-letter tile)
  result.push({ text: s[0], isChunk: false });

  let rest = s.slice(1);
  let suffixChunk: { text: string; isChunk: boolean } | null = null;

  // 2. Extract standard morpheme suffix from tail if present
  for (const suf of MORPHEME_SUFFIXES) {
    if (rest.endsWith(suf) && rest.length - suf.length >= 1) {
      suffixChunk = { text: suf, isChunk: true };
      rest = rest.slice(0, rest.length - suf.length);
      break;
    }
  }

  // 3. Segment the middle portion into root chunks and single letters
  let pos = 0;
  let chunkCount = suffixChunk ? 1 : 0;
  const MAX_CHUNKS_PER_SEED = 2;

  while (pos < rest.length) {
    let matchedChunk: string | null = null;

    if (chunkCount < MAX_CHUNKS_PER_SEED) {
      for (const root of ROOT_CHUNKS) {
        if (rest.startsWith(root, pos) && rest.length - pos >= root.length) {
          matchedChunk = root;
          break;
        }
      }
    }

    if (matchedChunk) {
      result.push({ text: matchedChunk, isChunk: true });
      pos += matchedChunk.length;
      chunkCount++;
    } else {
      result.push({ text: rest[pos], isChunk: false });
      pos++;
    }
  }

  if (suffixChunk) {
    result.push(suffixChunk);
  }

  return result;
}

/**
 * Test whether a word can be formed by a multiset partition of available tile texts.
 */
export function canConstructWordFromTiles(
  word: string,
  tiles: readonly (string | Tile)[],
): boolean {
  const target = word.toLowerCase();
  const tileTexts = tiles.map((t) => (typeof t === "string" ? t.toLowerCase() : t.text.toLowerCase()));

  // Quick total length check
  let totalLength = 0;
  for (const t of tileTexts) totalLength += t.length;
  if (target.length > totalLength || target.length === 0) return false;

  // DFS exact cover matching, memoized on (targetOffset, usedMask). Without the memo, k copies of
  // one letter make every ordering of those copies a distinct search path to the SAME state, so a
  // failing target degrades toward O(k!) — and 5-6 identical tiles is reachable, because the vowel
  // balancer injects random vowels and Tide pushes the rack toward 50% vowels. Memoizing bounds it
  // at target.length × 2^n states. submitWord runs this on every commit, and subWordFinder on every
  // candidate that survives the frequency check on a chunked rack.
  const failed = new Set<number>();
  function match(targetOffset: number, usedMask: number): boolean {
    if (targetOffset === target.length) return true;
    const key = targetOffset * (1 << tileTexts.length) + usedMask;
    if (failed.has(key)) return false;

    for (let i = 0; i < tileTexts.length; i++) {
      if ((usedMask & (1 << i)) !== 0) continue;
      const t = tileTexts[i];
      if (target.startsWith(t, targetOffset)) {
        if (match(targetOffset + t.length, usedMask | (1 << i))) {
          return true;
        }
      }
    }
    failed.add(key);
    return false;
  }

  return match(0, 0);
}

/**
 * Return the exact subset of Tile objects used to spell a word, or null if impossible.
 */
export function findTileDecomposition(word: string, rack: readonly Tile[]): Tile[] | null {
  const target = word.toLowerCase();
  const result: Tile[] = [];

  // Memoized on (targetOffset, usedMask), for the same reason canConstructWordFromTiles is: with
  // duplicate tiles every ordering of the duplicates reaches the same state, so a failing target
  // degrades toward O(k!). Only FAILURES are cached — a success returns straight out with `result`
  // holding the decomposition, so a cached success could never be replayed into it anyway.
  const failed = new Set<number>();
  function match(targetOffset: number, usedMask: number): boolean {
    if (targetOffset === target.length) return true;
    const key = targetOffset * (1 << rack.length) + usedMask;
    if (failed.has(key)) return false;

    for (let i = 0; i < rack.length; i++) {
      if ((usedMask & (1 << i)) !== 0) continue;
      const tile = rack[i];
      const text = tile.text.toLowerCase();
      if (target.startsWith(text, targetOffset)) {
        result.push(tile);
        if (match(targetOffset + text.length, usedMask | (1 << i))) {
          return true;
        }
        result.pop();
      }
    }
    failed.add(key);
    return false;
  }

  if (match(0, 0)) return result;
  return null;
}

/**
 * Compute 26-element letter frequency vector and 32-bit presence bitmask for a tile collection.
 */
function rackLetterProfile(tiles: readonly { text: string }[]): {
  counts: Int32Array;
  mask: number;
  totalLetters: number;
  vowelCount: number;
} {
  const counts = new Int32Array(26);
  let mask = 0;
  let totalLetters = 0;
  let vowelCount = 0;

  for (const tile of tiles) {
    for (let i = 0; i < tile.text.length; i++) {
      const code = tile.text.charCodeAt(i) - 97;
      if (code >= 0 && code < 26) {
        counts[code]++;
        mask |= 1 << code;
        totalLetters++;
        const ch = tile.text[i];
        if (isVowel(ch)) vowelCount++;
      }
    }
  }

  return { counts, mask, totalLetters, vowelCount };
}

/**
 * Ultra-fast sub-word finder. Scans the starting-letter pool for words buildable from the rack.
 */
export function subWordFinder(
  rack: readonly Tile[],
  pool: WordPool,
  index: PoolIndex,
  requiredLetter: string,
  options: {
    usedWords?: ReadonlySet<string>;
    maxResults?: number;
    minLen?: number;
    maxLen?: number;
  } = {},
): string[] {
  const { counts: rackCounts, mask: rackMask, totalLetters } = rackLetterProfile(rack);
  const minLen = Math.max(2, options.minLen ?? 2);
  const maxLen = Math.min(totalLetters, options.maxLen ?? totalLetters);
  const maxResults = options.maxResults ?? Infinity;
  const used = options.usedWords ?? new Set<string>();

  const hasChunks = rack.some((t) => t.isChunk);
  const found: string[] = [];

  const lettersToScan = requiredLetter
    ? [requiredLetter.toLowerCase()]
    : index.startLetters();

  for (const startLetter of lettersToScan) {
    const lengths = index.lengthsFor(startLetter);
    for (const len of lengths) {
      if (len < minLen || len > maxLen) continue;

      const r = index.range(startLetter, len);
      for (let i = r.start; i < r.end; i++) {
        const word = pool.pickOfLength(len, i);
        if (!word || used.has(word)) continue;

        // 1. Bitmask check
        let wordMask = 0;
        let possible = true;
        for (let c = 0; c < word.length; c++) {
          const code = word.charCodeAt(c) - 97;
          if (code < 0 || code >= 26) {
            possible = false;
            break;
          }
          wordMask |= 1 << code;
        }
        if (!possible || (wordMask & ~rackMask) !== 0) continue;

        // 2. Letter frequency check
        const wordCounts = new Int32Array(26);
        for (let c = 0; c < word.length; c++) {
          const code = word.charCodeAt(c) - 97;
          wordCounts[code]++;
          if (wordCounts[code] > rackCounts[code]) {
            possible = false;
            break;
          }
        }
        if (!possible) continue;

        // 3. Tile partition check if chunk tiles exist
        if (hasChunks && !canConstructWordFromTiles(word, rack)) {
          continue;
        }

        found.push(word);
        if (found.length >= maxResults) return found;
      }
    }
  }

  return found;
}

/** Below this many buildable-length pool words, a first letter cannot fill varied racks.
 *
 *  Measured against the shipped Reduced list (`words-common.txt`): every letter at or above this
 *  count produced 0.0% of racks with <= 2 buildable words at both rackSize 9 and 7, while the
 *  letters below it are the entire failure tail — `x` has exactly ONE word in the Reduced list, so
 *  100% of `x` racks hold a single buildable word, and `z` (13) reaches 62% of racks with <= 2 at
 *  rackSize 7. The full list's thinnest letter is 519, so it never trips this. */
const MIN_SUCCESSION_POOL_WORDS = 60;

/** A letter must also hold less than this share of its pool's per-letter average to count as a dead
 *  end. Guards the absolute floor above against SMALL pools: in a hand-built pool of twenty words
 *  every letter is under 60, and waiving Succession there would not rescue a turn — it would just
 *  delete the chain rule. A dead end is a letter that is thin *for its own pool*, not merely thin. */
const DEAD_END_POOL_SHARE = 0.5;

/**
 * Whether `letter` has enough pool words to seed a rack a player can actually work with.
 *
 * Succession dead ends are a Word Builder-only hazard, and the reason is `subWordFinder`: it only
 * returns words STARTING with the required letter, so a chain that lands on `x` leaves a rack whose
 * only buildable word is the Golden Seed itself. On a 25s clock — 15s in Sudden Death — that is a
 * near-certain timeout, and an elimination in Survival. Classic never calls this: there the player
 * types freely and a thin letter costs them nothing but difficulty.
 *
 * Counted over lengths a rack of `rackSize` could actually spell, so the same letter can support a
 * 9-tile rack and not a 7-tile one — which is exactly what the measurements show.
 *
 * This is the rack-path equivalent of the letter-starvation lookahead the retired Offer generator
 * carried (picker/offer.ts, "problem 3"). That protection was never ported when racks replaced
 * Offers, which is why it had to be rebuilt here.
 */
export function letterSupportsRack(
  index: PoolIndex,
  letter: string,
  rackSize: number,
): boolean {
  if (!letter) return true; // "" is free choice, which is always playable
  const buildable = (l: string): number => {
    let n = 0;
    for (const len of index.lengthsFor(l)) {
      if (len < 2 || len > rackSize) continue;
      const r = index.range(l, len);
      n += r.end - r.start;
    }
    return n;
  };

  const count = buildable(letter.toLowerCase());
  if (count >= MIN_SUCCESSION_POOL_WORDS) return true;

  // Thin in absolute terms. Only a dead end if it is also thin for this pool — see
  // DEAD_END_POOL_SHARE. Compared against the per-letter mean over letters that appear at all.
  const starts = index.startLetters();
  if (starts.length === 0) return true;
  let total = 0;
  for (const l of starts) total += buildable(l);
  return count >= (total / starts.length) * DEAD_END_POOL_SHARE;
}

/**
 * Diversity Contract Verification:
 * 1. >= 1 word of length >= 7 (High-ceiling engine path)
 * 2. >= 2 words of length 4-6 (Mid-range / safe path)
 * 3. >= 2 distinct ending letters (Tactical Succession choices)
 */
export function verifyRackDiversity(
  rack: readonly Tile[],
  pool: WordPool,
  index: PoolIndex,
  requiredLetter: string,
  usedWords: ReadonlySet<string> = new Set(),
): { valid: boolean; words: string[]; distinctEndings: number } {
  const words = subWordFinder(rack, pool, index, requiredLetter, { usedWords });

  let countLong = 0;
  let countMid = 0;
  const endings = new Set<string>();

  for (const w of words) {
    if (w.length >= 7) countLong++;
    else if (w.length >= 4 && w.length <= 6) countMid++;
    if (w.length > 0) endings.add(w[w.length - 1]);
  }

  const valid = countLong >= 1 && countMid >= 2 && endings.size >= 2;
  return { valid, words, distinctEndings: endings.size };
}

/**
 * Pick a Golden Seed word for the given required letter.
 */
export function selectGoldenSeed(
  pool: WordPool,
  index: PoolIndex,
  requiredLetter: string,
  usedWords: ReadonlySet<string>,
  shaping: RackShaping | undefined,
  bannedLetters: ReadonlySet<string>,
  targetRackSize: number,
  rng: () => number,
): string | null {
  const startLetters = requiredLetter ? [requiredLetter.toLowerCase()] : index.startLetters();
  const minLen = Math.min(shaping?.minSeedLength ?? 6, targetRackSize);
  const maxLen = Math.max(minLen, Math.min(8, targetRackSize));

  // Gather candidate seeds
  const candidates: { word: string; score: number }[] = [];

  for (const letter of startLetters) {
    for (let len = minLen; len <= maxLen; len++) {
      const r = index.range(letter, len);
      if (r.end <= r.start) continue;

      // Sample candidates from this range
      const sampleCount = Math.min(r.end - r.start, 15);
      for (let s = 0; s < sampleCount; s++) {
        const idx = r.start + Math.floor(rng() * (r.end - r.start));
        const w = pool.pickOfLength(len, idx);
        if (!w || usedWords.has(w)) continue;
        if (shaping?.excludeBannedLetters && [...w].some((ch) => bannedLetters.has(ch))) {
          continue;
        }

        const score = scoreSeedFertility(w, bannedLetters);
        candidates.push({ word: w, score });
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: sweep any available length in the pool
    for (const letter of startLetters) {
      for (const len of index.lengthsFor(letter)) {
        const r = index.range(letter, len);
        for (let i = r.start; i < r.end; i++) {
          const w = pool.pickOfLength(len, i);
          if (w && !usedWords.has(w)) return w;
        }
      }
    }
    return null;
  }

  // Weighted random selection based on fertility score
  let totalScore = 0;
  for (const c of candidates) totalScore += c.score;
  let pick = rng() * totalScore;

  for (const c of candidates) {
    pick -= c.score;
    if (pick <= 0) return c.word;
  }

  return candidates[candidates.length - 1].word;
}

/**
 * Generate a complete Tile Rack for the active player's turn.
 */
export function generateRack(req: RackRequest): RackResult {
  const {
    pool,
    index,
    requiredLetter,
    usedWords,
    rng,
    shaping,
  } = req;

  const bannedSet = new Set((req.bannedLetters ?? []).map((l) => l.toLowerCase()));
  const targetRackSize = Math.max(
    MIN_RACK_SIZE,
    Math.min(
      MAX_RACK_SIZE,
      (req.rackSize ?? DEFAULT_RACK_SIZE) + (shaping?.slotDelta ?? 0),
    ),
  );

  const targetVowelRatio = shaping?.highVowelRatio ? 0.5 : 0.4;
  let bestRack: Tile[] | null = null;
  let bestWords: string[] = [];
  let bestSeed = "";

  const MAX_ATTEMPTS = 12;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 1. Select Golden Seed
    const seedWord = selectGoldenSeed(
      pool,
      index,
      requiredLetter,
      usedWords,
      shaping,
      bannedSet,
      targetRackSize,
      rng,
    );

    if (!seedWord) break;

    // 2. Decompose Seed into Tiles
    const seedTiles = decomposeSeed(seedWord);
    const tiles: { text: string; isChunk: boolean }[] = [...seedTiles];

    // 3. Catalyst Injection & Vowel Balancing
    while (tiles.length < targetRackSize) {
      const profile = rackLetterProfile(tiles);
      const currentVowelRatio = profile.vowelCount / Math.max(1, profile.totalLetters);

      let newTileText: string;
      let isChunk = false;

      if (shaping?.guaranteeRare && !tiles.some((t) => RARE_LETTERS.some((r) => t.text.includes(r)))) {
        // Inject rare letter for Prospector
        const availableRares = shaping.excludeBannedLetters
          ? RARE_LETTERS.filter((r) => !bannedSet.has(r))
          : RARE_LETTERS;
        newTileText = availableRares[Math.floor(rng() * availableRares.length)] ?? "z";
      } else if (currentVowelRatio < targetVowelRatio) {
        // Need vowel
        const vowels = shaping?.excludeBannedLetters
          ? CATALYST_VOWELS.filter((v) => !bannedSet.has(v))
          : CATALYST_VOWELS;
        newTileText = vowels[Math.floor(rng() * vowels.length)] ?? "e";
      } else {
        // Need consonant / catalyst chunk
        const roll = rng();
        if (roll < 0.28 && tiles.length <= targetRackSize - 1) {
          const chunks = shaping?.excludeBannedLetters
            ? CATALYST_CHUNKS.filter((c) => ![...c].some((ch) => bannedSet.has(ch)))
            : CATALYST_CHUNKS;
          newTileText = chunks[Math.floor(rng() * chunks.length)] ?? "s";
          isChunk = true;
        } else {
          const consonants = shaping?.excludeBannedLetters
            ? CATALYST_CONSONANTS.filter((c) => !bannedSet.has(c))
            : CATALYST_CONSONANTS;
          newTileText = consonants[Math.floor(rng() * consonants.length)] ?? "s";
        }
      }

      tiles.push({ text: newTileText, isChunk });
    }

    // 4. Shuffle tiles thoroughly so the seed word is non-sequential
    shuffleArray(tiles, rng);

    // 5. Build Tile objects with stable IDs
    const finalTiles: Tile[] = tiles.map((t, idx) => ({
      id: `t${idx}`,
      text: t.text,
      isChunk: t.isChunk,
    }));

    // 6. Sub-Word Diversity Check
    const diversity = verifyRackDiversity(finalTiles, pool, index, requiredLetter, usedWords);

    if (diversity.valid) {
      return {
        tiles: finalTiles,
        seedWord,
        subWordCount: diversity.words.length,
        diversityPassed: true,
      };
    }

    if (!bestRack || diversity.words.length > bestWords.length) {
      bestRack = finalTiles;
      bestWords = diversity.words;
      bestSeed = seedWord;
    }
  }

  // Fallback to best rack generated
  return {
    tiles: bestRack ?? [
      { id: "t0", text: requiredLetter || "a", isChunk: false },
      { id: "t1", text: "t", isChunk: false },
      { id: "t2", text: "e", isChunk: false },
    ],
    seedWord: bestSeed,
    subWordCount: bestWords.length,
    diversityPassed: false,
  };
}
