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
 * 1. Golden Seed Selection: pick a 6-8 letter word starting with the required letter (shorter when
 *    the rack is smaller than that, longer under Sieve), scored for combinatorial fertility.
 * 2. Tile Decomposition: extract morpheme chunks (-ING, -ED, -TION, etc.) and single letters.
 * 3. Catalyst Injection: pad rack to target capacity (default 9-10 tiles) while maintaining target
 *    vowel ratio (35%-45%) and high-utility inflections (S, D, R, E, Y, -ED, -ING).
 * 4. Sub-Word Profiler & Diversity Guardrail: verify Diversity Contract (>= 1 word 7+L, >= 2 words 4-6L,
 *    >= 2 distinct ending letters) via bitmask/frequency scanning.
 */

import { RARE_START } from "../cards/card";
import { isVowel, MAX_BUILDER_RACK_SIZE, MIN_BUILDER_RACK_SIZE } from "../settings";
import { MAX_OFFER_LENGTH, MIN_OFFER_LENGTH, type PoolIndex } from "../picker/offer";
import type { WordPool } from "../picker/wordPool";

/** The largest tile count the exact-cover DFS below can memoize.
 *
 *  Both `canConstructWordFromTiles` and `findTileDecomposition` key their memo on
 *  `offset * (1 << n) + mask`, which is a perfect hash only while `1 << n` stays a positive power of
 *  two — at n = 31 a JS bitmask goes negative and distinct states start colliding, which would make
 *  the DFS report a buildable word as unbuildable. MAX_RACK_SIZE is held at or below this, and both
 *  functions are exported and take arbitrary tile arrays, so they check rather than assume. */
const TILE_MASK_LIMIT = 30;

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
  /** Override the per-draw examination ceiling (see RACK_SCAN_BUDGET). Diagnostics and tests. */
  scanBudget?: number;
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
  /** Pool candidates the diversity verifier examined, summed over every attempt this draw made.
   *  Diagnostics, and what lets a test pin bounded scanning deterministically instead of with a wall
   *  clock — the cost this generator has to control is candidates walked, not milliseconds. */
  examined: number;
  /** Preference Card guarantees this rack could not honour — a rack too small to spare a slot, or a
   *  Sentinel ban that outranked them. Empty in the ordinary case. Surfaced rather than swallowed so
   *  the impossible case is observable instead of looking like a working guarantee. */
  unmetGuarantees: ("rare" | "vowels")[];
}

/** Default rack size if unspecified. */
export const DEFAULT_RACK_SIZE = 9;

/** Minimum and maximum allowable rack sizes after modifiers. Aliases of the lobby's own bounds, so
 *  the band this clamps to and the range a host may pick from cannot drift apart — see
 *  MIN_BUILDER_RACK_SIZE for why that mattered, and for why the ceiling is where it is (the memo key
 *  in canConstructWordFromTiles below is a bitmask in a JS number). */
export const MIN_RACK_SIZE = MIN_BUILDER_RACK_SIZE;
export const MAX_RACK_SIZE = MAX_BUILDER_RACK_SIZE;

/**
 * The rack size a draw will ACTUALLY use: the requested base plus the holder's Preference Card
 * slot delta (Wide Net +2, Tunnel Vision -2), clamped to the allowable band.
 *
 * Exported because the base setting alone is not the rack anyone gets, and two callers need the
 * same answer: `generateRack` sizes its draw with it, and `MatchController.nextRequiredLetter`
 * asks `letterSupportsRack` about the rack the NEXT player will hold — a letter that clears the
 * bar at 9 tiles can still be a dead end at 7.
 */
export function effectiveRackSize(rackSize?: number, slotDelta?: number): number {
  return Math.max(
    MIN_RACK_SIZE,
    Math.min(MAX_RACK_SIZE, (rackSize ?? DEFAULT_RACK_SIZE) + (slotDelta ?? 0)),
  );
}

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
  const tileTexts = tiles.map((t) =>
    typeof t === "string" ? t.toLowerCase() : t.text.toLowerCase(),
  );
  return matchAgainstTexts(word.toLowerCase(), tileTexts);
}

/** The exact-cover DFS behind {@link canConstructWordFromTiles}, over tile texts that are ALREADY
 *  lowercased.
 *
 *  Split out so a scanning caller can lower the rack ONCE rather than per candidate. subWordFinder
 *  reaches this for every word that survives the frequency check on a chunked rack — and a chunked
 *  rack is the normal case, since decomposeSeed extracts chunks and catalyst injection adds one at
 *  28% per slot — so the `tiles.map(...toLowerCase())` it used to redo each time was pure garbage on
 *  a 40k-word bucket. */
function matchAgainstTexts(target: string, tileTexts: readonly string[]): boolean {
  if (tileTexts.length > TILE_MASK_LIMIT) {
    throw new Error(
      `canConstructWordFromTiles: ${tileTexts.length} tiles exceeds TILE_MASK_LIMIT ` +
        `(${TILE_MASK_LIMIT}); the memo key would collide silently`,
    );
  }

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
  if (rack.length > TILE_MASK_LIMIT) {
    throw new Error(
      `findTileDecomposition: ${rack.length} tiles exceeds TILE_MASK_LIMIT (${TILE_MASK_LIMIT}); ` +
        `the memo key would collide silently`,
    );
  }

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

/** A work budget for a bounded pool scan, decremented IN PLACE so one object threads through
 *  several probes: the caller reads back how much was consumed and whether it ran out. */
export interface ScanBudget {
  remaining: number;
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
    /** Stop as soon as this returns true, evaluated after each accepted word. Lets a caller stop on
     *  a property of the SET found ("a second distinct ending letter") rather than on a count. */
    stopWhen?: (word: string, found: readonly string[]) => boolean;
    /** Cap on pool candidates EXAMINED — not returned.
     *
     *  Use this, not `maxResults`, to bound an open-ended scan: `index.lengthsFor` yields the short
     *  buckets first and the only other bail is post-push, so a result cap truncates by ASCENDING
     *  LENGTH and silently starves any caller that cares about long words. A budget bounds the work
     *  without biasing which words come back. */
    budget?: ScanBudget;
  } = {},
): string[] {
  const { counts: rackCounts, mask: rackMask, totalLetters } = rackLetterProfile(rack);
  // Floored at the shortest length PoolIndex actually indexes. The old floor of 2 was unreachable:
  // `lengthsFor` never yields below MIN_OFFER_LENGTH and `range` returns an empty span there, so a
  // caller asking for 2-letter words silently got none.
  const minLen = Math.max(MIN_OFFER_LENGTH, options.minLen ?? MIN_OFFER_LENGTH);
  const maxLen = Math.min(totalLetters, options.maxLen ?? totalLetters);
  const maxResults = options.maxResults ?? Infinity;
  const used = options.usedWords ?? new Set<string>();

  const hasChunks = rack.some((t) => t.isChunk);
  // Lowered ONCE for the whole scan rather than per candidate (see matchAgainstTexts).
  const rackTexts = hasChunks ? rack.map((t) => t.text.toLowerCase()) : [];
  const found: string[] = [];

  // One reused frequency buffer instead of a fresh Int32Array per candidate. Only the codes this
  // word touched are reset, so the cost is the word's length rather than a 26-slot zero-fill plus
  // an allocation — on the innermost loop of every candidate that survives the bitmask check, and
  // it matters most exactly where this scan hurts: the server's Jint sandbox, where there is no JIT
  // and an allocation is comparatively far more expensive.
  const wordCounts = new Int32Array(26);

  // A buildable word must BEGIN with the first character of some tile. Without chunks every tile is
  // a single letter, so the frequency check already demands `w[0]` be one of them; with chunks
  // `matchAgainstTexts` additionally has to place a tile at offset 0, which is the same condition.
  // So a start letter no tile begins names a bucket that provably cannot yield a word, and walking
  // it is pure loss — which is what a free-letter scan did for ~18 of the 26 letters, on the
  // shot-clock tick, inside Jint. Exact, not heuristic: it only ever skips buckets whose every
  // candidate the checks below would have rejected one at a time.
  const tileInitials = new Set<string>();
  for (const t of rack) if (t.text.length > 0) tileInitials.add(t.text[0].toLowerCase());

  const lettersToScan = (
    requiredLetter ? [requiredLetter.toLowerCase()] : index.startLetters()
  ).filter((l) => tileInitials.has(l));

  const stopWhen = options.stopWhen;
  // Tracked locally and written back once at the single exit, so no early return can skip the
  // write-back and leave a threaded budget lying about what it spent.
  let remaining = options.budget ? options.budget.remaining : Infinity;
  let stopped = false;

  for (const startLetter of lettersToScan) {
    if (stopped) break;
    const lengths = index.lengthsFor(startLetter);
    for (const len of lengths) {
      if (stopped) break;
      if (len < minLen || len > maxLen) continue;

      const r = index.range(startLetter, len);
      for (let i = r.start; i < r.end; i++) {
        const word = pool.pickOfLength(len, i);
        if (!word) continue;
        if (remaining <= 0) {
          stopped = true;
          break;
        }
        // Charged before the `used` filter: skipping an already-played word is still work done.
        remaining--;
        if (used.has(word)) continue;

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
        let upto = 0;
        for (; upto < word.length; upto++) {
          const code = word.charCodeAt(upto) - 97;
          if (++wordCounts[code] > rackCounts[code]) {
            possible = false;
            upto++; // this letter was counted, so it must be reset too
            break;
          }
        }
        for (let c = 0; c < upto; c++) wordCounts[word.charCodeAt(c) - 97] = 0;
        if (!possible) continue;

        // 3. Tile partition check if chunk tiles exist
        if (hasChunks && !matchAgainstTexts(word, rackTexts)) {
          continue;
        }

        found.push(word);
        if (stopWhen && stopWhen(word, found)) {
          stopped = true;
          break;
        }
        if (found.length >= maxResults) {
          stopped = true;
          break;
        }
      }
    }
  }

  if (options.budget) options.budget.remaining = remaining;
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
 * Counted over indexed lengths a rack of `rackSize` could actually spell (MIN_OFFER_LENGTH and up —
 * the pool holds nothing shorter), so the same letter can support a
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
      if (len < MIN_OFFER_LENGTH || len > rackSize) continue;
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
  // `buildable` summed over every start letter IS the whole of each length bucket in the window —
  // the per-letter ranges partition it — so the total costs a handful of memoized `countOfLength`
  // crossings (`range("", len)` is the whole bucket, never a binary search) instead of
  // `lengthsFor` x 26, which is ~5,900 pool calls. That mattered because this runs on the SUBMIT
  // tick inside Jint, where the authority gets 250ms per call before the lobby is killed.
  //
  // Exact for an a-z pool, which both shipped lists are; a pool with non-letter initials would
  // over-count slightly, and that only makes a thin letter likelier to be waived — the safe
  // direction for a threshold that already carries a 0.5 share.
  let total = 0;
  for (let len = MIN_OFFER_LENGTH; len <= Math.min(rackSize, MAX_OFFER_LENGTH); len++) {
    const r = index.range("", len);
    total += r.end - r.start;
  }
  return count >= (total / starts.length) * DEAD_END_POOL_SHARE;
}

/* Diversity Contract clause thresholds. Each clause has its OWN length window, and that is the
 * whole reason the verifier below can be bounded without going approximate: a `maxResults` cap set
 * to a clause's threshold, on a probe restricted to that clause's window, cannot false-negative.
 * A cap SHARED across the windows can and does — see subWordFinder's `budget` doc. */
const DIVERSITY_LONG_LEN = 7;
const DIVERSITY_MID_MIN = 4;
const DIVERSITY_MID_MAX = 6;
const DIVERSITY_MID_NEEDED = 2;
const DIVERSITY_ENDINGS_NEEDED = 2;
const DIVERSITY_MAX_PROGRESS = 1 + DIVERSITY_MID_NEEDED + DIVERSITY_ENDINGS_NEEDED;

/** Candidates the bounded verifier may examine per rack before giving up on the contract.
 *
 *  Chosen to be UNREACHABLE on the shipped Reduced list, which is what preserves outcome identity:
 *  `words-common.txt`'s fattest starting letter (`c`, 947 words) sums to 1,870 examinations across
 *  the three probe windows (300 mid + 623 long + 947 endings), so no Reduced draw can exhaust this
 *  and no Reduced verdict — and therefore no rng draw downstream of one — can change. Any value
 *  >= 1,900 is Reduced-neutral; below that, identity is forfeit and the shared-stream tests in
 *  rack.test.ts will drift.
 *
 *  It earns its keep on the Full list, where a census of one starting letter costs 7,000-23,000
 *  examinations against a 7-tile rack and the old code paid that up to 12 times per draw, on the
 *  turn-arm path, inside the server's Jint sandbox where there is no JIT.
 *
 *  Measured over 400 Full-list draws at Sudden Death's rack size of 7: p50 132 examinations, p90
 *  1,004, and the budget binds on 1.5% of draws. Those 1.5% fall back to a best-effort rack — still
 *  seeded, still buildable, just not contract-verified — which is the intended trade, since they are
 *  exactly the draws where verifying costs the most. Raising this buys a fraction of a percent of
 *  rack quality for a proportional rise in the worst case. */
const DIVERSITY_EXAMINE_BUDGET = 4000;

/** Pool candidates ONE draw may examine, summed across every attempt's diversity probes.
 *
 *  DIVERSITY_EXAMINE_BUDGET bounds a single verification; this bounds the TURN, which is the unit
 *  the server actually has to fit. A draw used to hand each of its MAX_ATTEMPTS attempts a fresh
 *  budget, so one turn-arm could spend 48,000 examinations — and measured under real Jint that is
 *  where the remaining time went once the free-letter fan-out was gone. Examinations are the right
 *  unit because they bound BOTH costs: each one is a sandbox crossing AND the per-candidate bitmask
 *  / frequency / exact-cover work, and on a chunked rack the latter dominates.
 *
 *  Sized from the suites: the p50 draw examines ~194 and p90 ~2,295, so this leaves the ordinary
 *  draw untouched and binds only on the tail — which is exactly where verifying costs the most and
 *  buys the least. Exhaustion returns the best-progress rack, still seeded and still buildable,
 *  just not contract-verified — an outcome generateRack already produces and rack.test.ts pins. */
export const RACK_SCAN_BUDGET = 3000;

export interface RackDiversity {
  valid: boolean;
  /** A SAMPLE, not a census: capped at roughly what the contract needs, unless `exhaustive` was
   *  set. Use it to tell "some words exist" from "none do", not to measure how many. */
  words: string[];
  /** Capped the same way — ">= 2" is meaningful, the exact value above 2 is not. */
  distinctEndings: number;
  /** Pool candidates examined. Diagnostics, and what lets a test pin bounded work deterministically
   *  instead of with a wall clock. */
  examined: number;
  /** The budget ran out, so a `valid: false` here may be a false negative. Never true on Reduced. */
  budgetExhausted: boolean;
  /** How many of the contract's clause-units are satisfied, 0..DIVERSITY_MAX_PROGRESS. `valid` is
   *  exactly `progress === DIVERSITY_MAX_PROGRESS`. This is the ranking key for the least-bad
   *  fallback rack, which total sub-word count could only ever proxy for. */
  progress: number;
}

/**
 * Diversity Contract Verification:
 * 1. >= 1 word of length >= 7 (High-ceiling engine path)
 * 2. >= 2 words of length 4-6 (Mid-range / safe path)
 * 3. >= 2 distinct ending letters (Tactical Succession choices)
 *
 * Verified with three bounded probes rather than one unbounded scan. The contract needs at most a
 * handful of words, but the scan it used to run walked EVERY buildable word in the required letter's
 * bucket — 947 on the Reduced list, 40,310 on the Full one that Sudden Death selects — and
 * generateRack repeats it up to MAX_ATTEMPTS times per turn.
 */
export function verifyRackDiversity(
  rack: readonly Tile[],
  pool: WordPool,
  index: PoolIndex,
  requiredLetter: string,
  usedWords: ReadonlySet<string> = new Set(),
  options: {
    /** The Golden Seed this rack was decomposed from. Always buildable from the rack, always
     *  unplayed, always starts with the required letter — so it is a word the unbounded scan would
     *  have returned, and priming with it is exact rather than a shortcut. */
    seedWord?: string;
    /** Reproduce the old unbounded single scan. For tests and diagnostics ONLY — it is the oracle
     *  the bounded path is verified against. generateRack never sets it. */
    exhaustive?: boolean;
    budget?: ScanBudget;
  } = {},
): RackDiversity {
  // MAX_SAFE_INTEGER rather than Infinity for the exhaustive default, so `examined` below stays a
  // real count instead of Infinity - Infinity.
  const budget: ScanBudget = options.budget ?? {
    remaining: options.exhaustive ? Number.MAX_SAFE_INTEGER : DIVERSITY_EXAMINE_BUDGET,
  };
  const startedWith = budget.remaining;

  // A rack that physically cannot spell DIVERSITY_LONG_LEN letters must not be held to the long
  // clause — with the floor at MIN_RACK_SIZE that is reachable. When the relaxed threshold drops
  // into the mid band the two windows overlap and one word can satisfy both clauses; that is
  // deliberate, since demanding distinct words would make the contract unsatisfiable exactly where
  // the rack is already too thin to offer any.
  const longLen = Math.min(DIVERSITY_LONG_LEN, rackLetterProfile(rack).totalLetters);

  const words: string[] = [];
  const seen = new Set<string>();
  const endings = new Set<string>();
  let countLong = 0;
  let countMid = 0;

  const add = (w: string): void => {
    if (!seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
    if (w.length > 0) endings.add(w[w.length - 1]);
  };

  const finish = (): RackDiversity => {
    const progress =
      Math.min(countLong, 1) +
      Math.min(countMid, DIVERSITY_MID_NEEDED) +
      Math.min(endings.size, DIVERSITY_ENDINGS_NEEDED);
    return {
      valid: progress === DIVERSITY_MAX_PROGRESS,
      words,
      distinctEndings: endings.size,
      examined: startedWith - budget.remaining,
      budgetExhausted: budget.remaining <= 0,
      progress,
    };
  };

  if (options.exhaustive) {
    for (const w of subWordFinder(rack, pool, index, requiredLetter, { usedWords, budget })) {
      if (w.length >= longLen) countLong++;
      if (w.length >= DIVERSITY_MID_MIN && w.length <= DIVERSITY_MID_MAX) countMid++;
      add(w);
    }
    return finish();
  }

  // Prime from the seed. A 7+ letter seed settles the long clause with ZERO scanning, and at the
  // default rack size the seed band is 6-8 with fertility scoring favouring length, so this is the
  // common case — which means the one genuinely expensive probe is usually skipped outright.
  const seed = options.seedWord;
  if (
    seed &&
    seed.length >= longLen &&
    !usedWords.has(seed) &&
    (requiredLetter === "" || seed.startsWith(requiredLetter.toLowerCase()))
  ) {
    countLong = 1;
    add(seed);
  }

  // Mid band: cheapest and densest, so it goes first and usually supplies both endings too.
  const mid = subWordFinder(rack, pool, index, requiredLetter, {
    usedWords,
    minLen: DIVERSITY_MID_MIN,
    maxLen: DIVERSITY_MID_MAX,
    maxResults: DIVERSITY_MID_NEEDED,
    budget,
  });
  countMid = mid.length;
  for (const w of mid) add(w);

  if (countLong === 0) {
    const long = subWordFinder(rack, pool, index, requiredLetter, {
      usedWords,
      minLen: longLen,
      maxResults: 1,
      budget,
    });
    countLong = long.length;
    for (const w of long) add(w);
  }

  // Endings: only when the words already found do not carry two, which is uncommon. `stopWhen` makes
  // this exact — it stops on the FIRST word with an unseen ending, so it returns one iff the
  // unbounded scan would have found one. Tallied into `endings` alone: countLong and countMid come
  // from their own probes, so nothing here can double-count toward those clauses.
  if (endings.size < DIVERSITY_ENDINGS_NEEDED) {
    const extra = subWordFinder(rack, pool, index, requiredLetter, {
      usedWords,
      budget,
      stopWhen: (w) => !endings.has(w[w.length - 1]),
    });
    for (const w of extra) {
      if (endings.has(w[w.length - 1])) continue;
      add(w);
    }
  }

  return finish();
}

/** Stand-in for "this player has no ban worth weighing" — see the call site in selectGoldenSeed. */
const NO_BANS: ReadonlySet<string> = new Set();

/** A tile under construction. `fromSeed` marks the output of decomposeSeed, and is what makes the
 *  guarantee repair below safe: generateRack promises the seed stays buildable from the finished
 *  rack, so the repair may overwrite catalyst tiles and nothing else. Dropped when the array is
 *  mapped to Tile[]. */
interface DraftTile {
  text: string;
  isChunk: boolean;
  fromSeed: boolean;
}

/** The catalyst options a player is actually allowed, which is all of them unless they hold Sentinel.
 *  Separated from the draw so a caller can test for an empty list WITHOUT consuming an rng call —
 *  the old `?? "z"` / `?? "e"` / `?? "s"` fallbacks drew from an empty array (burning a draw and
 *  yielding undefined) and then injected the very letter the ban forbade, quietly defeating the card
 *  whose entire promise is that it will not appear. */
function allowedCatalysts(
  candidates: readonly string[],
  bannedSet: ReadonlySet<string>,
  filterBans: boolean,
): readonly string[] {
  if (!filterBans) return candidates;
  return candidates.filter((c) => ![...c].some((ch) => bannedSet.has(ch)));
}

/** Terminal catalyst: the first letter nobody has banned. Deterministic and rng-free, so reaching it
 *  cannot shift the stream. Only a fully banned alphabet falls through to "s", and at that point the
 *  rack is taxed whatever goes in. */
function firstUnbannedLetter(bannedSet: ReadonlySet<string>): string {
  for (let c = 0; c < 26; c++) {
    const ch = String.fromCharCode(97 + c);
    if (!bannedSet.has(ch)) return ch;
  }
  return "s";
}

function hasRareTile(tiles: readonly { text: string }[]): boolean {
  return tiles.some((t) => RARE_LETTERS.some((r) => t.text.includes(r)));
}

function vowelShare(tiles: readonly { text: string }[]): number {
  const p = rackLetterProfile(tiles);
  return p.vowelCount / Math.max(1, p.totalLetters);
}

/** The catalyst tile whose replacement by a single vowel buys the most vowel share — i.e. the one
 *  carrying the most consonant letters, earliest index winning ties so the choice stays
 *  deterministic. Rare-bearing tiles are excluded so a vowel repair can never undo a rare one. */
function bestVowelSwapIndex(tiles: readonly DraftTile[]): number {
  let best = -1;
  let bestConsonants = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.fromSeed) continue;
    if (RARE_LETTERS.some((r) => t.text.includes(r))) continue;
    let consonants = 0;
    for (const ch of t.text) if (!isVowel(ch)) consonants++;
    if (consonants > bestConsonants) {
      best = i;
      bestConsonants = consonants;
    }
  }
  return best;
}

function lastCatalystIndex(tiles: readonly DraftTile[]): number {
  for (let i = tiles.length - 1; i >= 0; i--) if (!tiles[i].fromSeed) return i;
  return -1;
}

/** Pool candidates the exhausted-letter fallback sweep may examine before giving up.
 *
 *  The sweep is the one part of seed selection that walks a bucket rather than sampling it, so it
 *  is the one part whose cost scales with the dictionary: a whole starting letter is 947 words on
 *  the Reduced list and ~40,000 on the Full one, and it runs inside a 250ms Jint call. Reaching
 *  the cap returns the taxed fallback (or null), which is the same answer the sweep gives when it
 *  finds nothing — and `generateRack` re-rolls the letter on the next attempt either way. */
const SEED_FALLBACK_EXAMINE_BUDGET = 1500;

/**
 * Resolve a free ("") required letter to ONE concrete start letter, weighted by how many words the
 * pool actually holds in the seed-length window this draw is about to sample.
 *
 * WHY THIS EXISTS. Every era opens on a free letter (`beginEra`, match.ts) and so does every
 * Wildcard draw, and the generator used to answer `""` by fanning out over all 26 start letters —
 * `index.startLetters()` (~5,900 pool calls before any work at all), then 26x the seed sampling,
 * then a 26-bucket `subWordFinder` sweep. That is a 15-60x spike landed on the single tick that
 * also runs `beginEra` -> `armCurrentTurn` -> `generateRack`, and under Jint it exceeded the
 * server's 250ms per-call timeout and killed the lobby outright.
 *
 * The trick is that a word drawn uniformly from a length bucket already carries a support-weighted
 * start letter in its first character, so ONE rng draw and ONE pool crossing buy the same
 * distribution the fan-out was approximating. Everything downstream then runs the ordinary
 * constrained path, which is why a free draw now costs what a normal turn costs.
 *
 * Returns "" when the window is empty, which puts the caller back on the old all-letters path —
 * the degenerate hand-built pools in the tests reach exactly that.
 */
function resolveSeedLetter(
  pool: WordPool,
  index: PoolIndex,
  minLen: number,
  maxLen: number,
  rng: () => number,
): string {
  let total = 0;
  for (let len = minLen; len <= maxLen; len++) {
    const r = index.range("", len);
    total += r.end - r.start;
  }
  if (total <= 0) return "";

  // One draw, walked into the concatenated buckets: a letter's probability is exactly its share of
  // the window, so a thin letter stays reachable without being over-represented the way sampling a
  // fixed 15 per (letter, length) used to make it.
  let offset = Math.floor(rng() * total);
  for (let len = minLen; len <= maxLen; len++) {
    const r = index.range("", len);
    const n = r.end - r.start;
    if (offset >= n) {
      offset -= n;
      continue;
    }
    const w = pool.pickOfLength(len, r.start + offset);
    const ch = w ? w[0] : "";
    return ch >= "a" && ch <= "z" ? ch : "";
  }
  return "";
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
  /** Tiles the catalyst loop must be left room to inject for an active guarantee.
   *
   *  Reserved against seed LETTERS, which is conservative in the safe direction: decomposeSeed emits
   *  at most one tile per letter, so a seed of `targetRackSize - reservedSlots` letters can never
   *  occupy more than that many slots, and a chunky seed frees extra slots for nothing. Yields to
   *  `minLen`, so Sieve's guarantee outranks Prospector's and Tide's. */
  reservedSlots = 0,
  /** The DRAW's remaining examination allowance, threaded in by generateRack so the fallback sweep
   *  cannot spend a fresh SEED_FALLBACK_EXAMINE_BUDGET on each of its twelve attempts. Omitted by a
   *  direct caller, which then gets one sweep's worth. */
  budget?: ScanBudget,
): string | null {
  // Floored at the shortest length the pool actually indexes. Below it the whole search window is
  // empty, and at the smallest rack sizes that is where the window lands — which used to mean no
  // seed at all, a degenerate fixed rack, and a succession letter freed every single turn.
  const minLen = Math.max(
    MIN_OFFER_LENGTH,
    Math.min(shaping?.minSeedLength ?? 6, targetRackSize),
  );
  const maxLen = Math.max(minLen, Math.min(8, targetRackSize - reservedSlots));

  // A free letter is narrowed to ONE letter rather than answered by fanning out over all 26 (see
  // resolveSeedLetter for why that fan-out was fatal on the server). Resolved per CALL, and
  // generateRack calls this once per attempt, so a single draw still sees up to MAX_ATTEMPTS
  // independent letters — which is what keeps a letter emptied by Sentinel or by `usedWords` from
  // ending the draw. Only a pool with nothing in the seed-length window falls back to all letters.
  const freeLetter = requiredLetter ? "" : resolveSeedLetter(pool, index, minLen, maxLen, rng);
  const startLetters = requiredLetter
    ? [requiredLetter.toLowerCase()]
    : freeLetter
      ? [freeLetter]
      : index.startLetters();

  /** A seed is only usable if its decomposition fits the rack — otherwise the catalyst loop never
   *  runs and the rack overflows the size the host asked for. Chunk extraction means letters are an
   *  upper bound on tiles, not the tile count itself, so this has to ask decomposeSeed rather than
   *  compare lengths: at a rack size of 2 the only usable seeds are the 3-letter words that split
   *  into a letter plus a chunk ("t" + "ed").
   *
   *  The length test is not an approximation of that call, it is the case where the call cannot
   *  say no: decomposeSeed emits `s[0]` plus tiles of at least one character covering the rest, so
   *  `decomposeSeed(w).length <= w.length` always — and a seed no longer than the rack therefore
   *  fits without asking. Since `maxLen` already binds at `min(8, targetRackSize - reservedSlots)`,
   *  that is EVERY candidate at rack sizes 3 and up, leaving the call for the rack-size-2 window
   *  and the fallback sweep below. It is worth spelling out because decomposeSeed is where the Jint
   *  stack trace landed: ~450 interpreted string ops per candidate, ~1,170 candidates per attempt,
   *  ~12 attempts, on the tick that arms the era opener. */
  const fits = (w: string): boolean =>
    w.length <= targetRackSize || decomposeSeed(w).length <= targetRackSize;

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
        if (!fits(w)) continue;

        // Bans are weighed ONLY for a holder of Sentinel. The penalty is worth about the whole of a
        // fertile seed's score, so feeding it in unconditionally made a banned-letter seed ~20-30x
        // less likely to be drawn FOR EVERYONE — handing every player most of Sentinel's protection
        // for free and quietly devaluing Sentinel, Prism and the tax-collector cards. The era ban is
        // supposed to hurt.
        //
        // Under excludeBannedLetters the penalty is in fact dead, because the hard filter above has
        // already dropped every candidate that would trip it. The conditional is here to state the
        // intent, and to keep the two paths from diverging if that filter is ever softened.
        const score = scoreSeedFertility(w, shaping?.excludeBannedLetters ? bannedLetters : NO_BANS);
        candidates.push({ word: w, score });
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: sweep any available length in the pool.
    //
    // Two-tier, because this path is reachable precisely BECAUSE of Sentinel — the hard filter above
    // is what empties `candidates` (likely whenever a common letter such as `e` is banned) — and
    // returning the first unplayed word regardless would break the guarantee the card is sold on.
    // Tier 2 exists because returning null is worse for the player than a taxed rack: the caller
    // reads null as "this letter is exhausted" and frees the succession letter entirely.
    //
    // Bounded by maxLen so a seed can never be longer than the rack it has to decompose into.
    //
    // Budgeted, unlike the sampling loop above: this one WALKS buckets instead of sampling them, so
    // its cost is the dictionary's rather than a fixed 15 per length. See
    // SEED_FALLBACK_EXAMINE_BUDGET.
    let taxedFallback: string | null = null;
    const sweep = budget ?? { remaining: SEED_FALLBACK_EXAMINE_BUDGET };
    for (const letter of startLetters) {
      for (const len of index.lengthsFor(letter)) {
        if (len > Math.max(maxLen, MIN_OFFER_LENGTH)) continue;
        const r = index.range(letter, len);
        for (let i = r.start; i < r.end; i++) {
          if (sweep.remaining <= 0) return taxedFallback;
          sweep.remaining--;
          const w = pool.pickOfLength(len, i);
          if (!w || usedWords.has(w) || !fits(w)) continue;
          if (!shaping?.excludeBannedLetters) return w;
          if (![...w].some((ch) => bannedLetters.has(ch))) return w;
          taxedFallback ??= w;
        }
      }
    }
    return taxedFallback;
  }

  // Tide: prefer a vowel-heavy seed. Reaching a 50% rack vowel share by injection alone is
  // arithmetically out of reach, because each injected vowel raises the denominator as well as the
  // numerator — an 8-letter seed with 2 vowels needs FOUR free slots to get there, more than any
  // rack can reserve without trampling Sieve. So the seed itself has to carry the ratio. Uses the
  // same predicate Tide applies on the Offer path (vowels * 2 >= length), and falls back to the
  // whole candidate set when the pool cannot serve it — a preference the pool cannot meet is
  // abandoned, never allowed to shrink the draw.
  let pickFrom = candidates;
  if (shaping?.highVowelRatio) {
    const vowelHeavy = candidates.filter((c) => {
      let v = 0;
      for (const ch of c.word) if (isVowel(ch)) v++;
      return v * 2 >= c.word.length;
    });
    if (vowelHeavy.length > 0) pickFrom = vowelHeavy;
  }

  // Weighted random selection based on fertility score
  let totalScore = 0;
  for (const c of pickFrom) totalScore += c.score;
  let pick = rng() * totalScore;

  for (const c of pickFrom) {
    pick -= c.score;
    if (pick <= 0) return c.word;
  }

  return pickFrom[pickFrom.length - 1].word;
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
  const targetRackSize = effectiveRackSize(req.rackSize, shaping?.slotDelta);
  const filterBans = !!shaping?.excludeBannedLetters;

  const targetVowelRatio = shaping?.highVowelRatio ? 0.5 : 0.4;
  // One slot per active guarantee, so the seed cannot fill the rack and starve the catalyst loop.
  const reservedSlots = (shaping?.guaranteeRare ? 1 : 0) + (shaping?.highVowelRatio ? 1 : 0);
  const unmet: ("rare" | "vowels")[] = [];
  let bestRack: Tile[] | null = null;
  let bestWords: string[] = [];
  let bestSeed = "";
  let examined = 0;
  let bestProgress = -1;
  let bestUnmet: ("rare" | "vowels")[] = [];
  let exhaustedStreak = 0;

  // One budget for the whole draw, threaded through every attempt's verification. See
  // RACK_SCAN_BUDGET — the per-call default this replaces was per ATTEMPT, which is what let a
  // single turn-arm spend twelve of them.
  const scanBudget: ScanBudget = { remaining: req.scanBudget ?? RACK_SCAN_BUDGET };

  const MAX_ATTEMPTS = 12;
  /** Consecutive budget-exhausted attempts before giving up on the contract for this draw. A rack
   *  the verifier could not settle within budget is a Full-dictionary symptom rather than a bad
   *  rack, and each retry costs another full budget while being no likelier to pass. Cannot fire on
   *  the Reduced list, where the budget is unreachable, so it cannot change a Reduced outcome. */
  const MAX_EXHAUSTED_STREAK = 3;

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
      reservedSlots,
      scanBudget,
    );

    // A free draw resolves a DIFFERENT start letter next attempt, so a letter that Sentinel's ban
    // filter or `usedWords` has emptied is not the end of the draw — only an exhausted CONSTRAINED
    // letter is, and that is what generateRackForTurn reads a "" seed as. Without this, narrowing
    // the free path to one letter would turn a recoverable turn into the degenerate rack.
    //
    // Guarded by the shared budget so a pool that can seed NOTHING cannot re-roll twelve times over
    // twelve fallback sweeps — the one way the retry above could have cost more than it saves.
    if (!seedWord) {
      if (requiredLetter === "" && scanBudget.remaining > 0) continue;
      break;
    }

    // 2. Decompose Seed into Tiles
    const seedTiles = decomposeSeed(seedWord);
    const tiles: DraftTile[] = seedTiles.map((t) => ({ ...t, fromSeed: true }));

    // 3. Catalyst Injection & Vowel Balancing
    //
    // Each branch tests its option list for emptiness BEFORE drawing, so a Sentinel ban that wipes
    // out a list costs no rng call and falls through to the next branch — which keeps the number of
    // rng draws per injected tile identical to the unbanned case, and therefore keeps every
    // shared-stream test in rack.test.ts stable.
    while (tiles.length < targetRackSize) {
      let newTileText: string | null = null;
      let isChunk = false;

      // Prospector first. Its guarantee is binary and costs exactly one slot, where Tide's is a
      // ratio that degrades gracefully — and with slots now reserved up front, the one-free-slot
      // case that made this ordering matter no longer arises.
      if (shaping?.guaranteeRare && !hasRareTile(tiles)) {
        const rares = allowedCatalysts(RARE_LETTERS, bannedSet, filterBans);
        if (rares.length > 0) newTileText = rares[Math.floor(rng() * rares.length)];
      }

      if (newTileText === null && vowelShare(tiles) < targetVowelRatio) {
        const vowels = allowedCatalysts(CATALYST_VOWELS, bannedSet, filterBans);
        if (vowels.length > 0) newTileText = vowels[Math.floor(rng() * vowels.length)];
      }

      if (newTileText === null) {
        const roll = rng();
        if (roll < 0.28) {
          const chunks = allowedCatalysts(CATALYST_CHUNKS, bannedSet, filterBans);
          if (chunks.length > 0) {
            newTileText = chunks[Math.floor(rng() * chunks.length)];
            isChunk = true;
          }
        }
        if (newTileText === null) {
          const consonants = allowedCatalysts(CATALYST_CONSONANTS, bannedSet, filterBans);
          newTileText =
            consonants.length > 0
              ? consonants[Math.floor(rng() * consonants.length)]
              : firstUnbannedLetter(bannedSet);
        }
      }

      tiles.push({ text: newTileText, isChunk, fromSeed: false });
    }

    // 3b. Guarantee repair. The loop above is the only place Prospector and Tide were ever enforced,
    // so a seed that filled the rack on its own — reachable whenever seed length meets the rack size,
    // and unavoidable at the smallest sizes — silently dropped both. Reservation makes that rare;
    // this makes it recoverable.
    //
    // Overwrites catalyst tiles IN PLACE and never touches a `fromSeed` tile, so the seed stays
    // buildable and the tile count cannot move. Both steps are rng-free, so the stream is untouched.
    unmet.length = 0;
    if (shaping?.guaranteeRare && !hasRareTile(tiles)) {
      const rares = allowedCatalysts(RARE_LETTERS, bannedSet, filterBans);
      const slot = lastCatalystIndex(tiles);
      if (rares.length > 0 && slot >= 0) {
        tiles[slot] = { text: rares[0], isChunk: false, fromSeed: false };
      } else {
        // Sentinel outranks Prospector when every rare is banned, and a rack with no catalyst tile
        // has nothing to give. Skipped in silence, as the Offer path already does for a guarantee
        // it cannot meet.
        unmet.push("rare");
      }
    }

    if (shaping?.highVowelRatio) {
      const vowels = allowedCatalysts(CATALYST_VOWELS, bannedSet, filterBans);
      for (let guard = tiles.length; guard > 0 && vowels.length > 0; guard--) {
        if (vowelShare(tiles) >= targetVowelRatio) break;
        const slot = bestVowelSwapIndex(tiles);
        if (slot < 0) break;
        tiles[slot] = { text: vowels[0], isChunk: false, fromSeed: false };
      }
      if (vowelShare(tiles) < targetVowelRatio) unmet.push("vowels");
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
    //
    // Verified against the letter the rack was actually SEEDED on, which on a free draw is the one
    // selectGoldenSeed narrowed to rather than "". decomposeSeed always emits `seed[0]` as its own
    // single-letter tile, so the seed starts with this letter and is buildable from the finished
    // rack. Asking about one letter instead of all 26 is strictly STRONGER than the contract needs:
    // free choice can build a superset of what that letter can, so the verifier may only
    // under-report, never pass a rack the player cannot work with.
    const seedLetter = requiredLetter || seedWord[0];
    const diversity = verifyRackDiversity(finalTiles, pool, index, seedLetter, usedWords, {
      seedWord,
      budget: scanBudget,
    });

    examined += diversity.examined;

    if (diversity.valid) {
      return {
        tiles: finalTiles,
        seedWord,
        subWordCount: diversity.words.length,
        diversityPassed: true,
        examined,
        unmetGuarantees: [...unmet],
      };
    }

    // Ranked on contract progress, not on total sub-word count: `words` is now a capped sample, and
    // progress is the thing the count could only ever proxy for. Consumes no rng, so the stream is
    // untouched either way.
    if (
      !bestRack ||
      diversity.progress > bestProgress ||
      (diversity.progress === bestProgress && diversity.words.length > bestWords.length)
    ) {
      bestRack = finalTiles;
      bestWords = diversity.words;
      bestSeed = seedWord;
      bestProgress = diversity.progress;
      bestUnmet = [...unmet];
    }

    // The shared budget subsumes the streak heuristic: once it is spent there is nothing left to
    // verify with, so a further attempt could only ever return the same unverified verdict.
    exhaustedStreak = diversity.budgetExhausted ? exhaustedStreak + 1 : 0;
    if (scanBudget.remaining <= 0 || exhaustedStreak >= MAX_EXHAUSTED_STREAK) break;
  }

  // Fallback to best rack generated. The hand-built rack is the last resort for a required letter
  // the pool cannot seed at all; it is sized to the request rather than fixed at three tiles, so a
  // host who asked for a large rack does not silently get a tiny one.
  const degenerate: Tile[] = [{ id: "t0", text: requiredLetter || "a", isChunk: false }];
  const filler = ["t", "e", "a", "s", "r", "n", "i", "o", "l", "d"];
  while (degenerate.length < targetRackSize) {
    degenerate.push({
      id: `t${degenerate.length}`,
      text: filler[(degenerate.length - 1) % filler.length],
      isChunk: false,
    });
  }

  return {
    tiles: bestRack ?? degenerate,
    seedWord: bestSeed,
    subWordCount: bestWords.length,
    diversityPassed: false,
    examined,
    unmetGuarantees: bestUnmet,
  };
}
