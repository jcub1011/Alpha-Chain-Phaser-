/*
 * WordPool — the one word-source abstraction the Picker's Offer generator draws against, so
 * solo play and the server authority run IDENTICAL generation code over different backings.
 *
 * WHY THIS SHAPE. The platform's word service (kb.words) deliberately never hands the
 * dictionary to the game: it exposes only index-based queries, so the 4 MB lexicon stays on
 * the server and out of the JS heap. That surface — has / count / pick / countOfLength /
 * pickOfLength — is therefore the lowest common denominator, and it is sufficient: see
 * `offer.ts` for how a contiguous-index-range binary search turns `pickOfLength` into
 * "words of length L starting with letter X" without ever scanning.
 *
 * THE ORDERING CONTRACT (load-bearing). The platform's WordPoolSet and the local-tab
 * emulation (addons/knockbox/knockbox-local.js buildLocalWordPool) both order words as:
 * length buckets ascending, ordinal (plain ASCII sort) within a length, exposed as one
 * contiguous global index. `dictionaryWordPool` reproduces that exactly. It has to: the
 * generator's binary search assumes same-first-letter words are CONTIGUOUS inside a length
 * bucket, and a divergence would silently return wrong ranges rather than throwing. That is
 * what wordPool.test.ts pins.
 */

/** The word-service surface, with the dictionary key already bound by the adapter. */
export interface WordPool {
  /** Whether `word` is in this pool. */
  has(word: string): boolean;
  /** Total words in the pool. */
  count(): number;
  /** The word at a global index, or null if out of range. */
  pick(index: number): string | null;
  /** How many words have exactly `len` letters. 0 for a length the pool has none of. */
  countOfLength(len: number): number;
  /** The `index`-th word of length `len` in ASCII order, or null if out of range. */
  pickOfLength(len: number, index: number): string | null;
}

/** `kb.words` as injected into the server authority (and emulated in local-tab mode).
 *  Declared structurally so this module imports nothing from the server layer. */
export interface KbWordsLike {
  has(key: string, word: string): boolean;
  count(key: string): number;
  pick(key: string, index: number): string | null;
  countOfLength(key: string, len: number): number;
  pickOfLength(key: string, len: number, index: number): string | null;
}

/** The part of `Dictionary` this module needs. Structural so tests can pass a stub. */
export interface DictionaryLike {
  has(word: string): boolean;
  words(): Iterable<string>;
}

/** Bind a dictionary key to `kb.words`. Used by the server authority, where the pool is a
 *  host capability and every call crosses the sandbox boundary — hence no caching here:
 *  the service is already backed by a prebuilt WordPoolSet. */
export function kbWordPool(words: KbWordsLike, key: string): WordPool {
  return {
    has: (word) => words.has(key, word),
    count: () => words.count(key),
    pick: (index) => words.pick(key, index),
    countOfLength: (len) => words.countOfLength(key, len),
    pickOfLength: (len, index) => words.pickOfLength(key, len, index),
  };
}

/** ASCII-only, matching the platform's `isAsciiWord` filter — the server's word service
 *  rejects non-ASCII outright, so a pool built here must drop the same entries. */
function isAsciiWord(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (word.charCodeAt(i) > 127) return false;
  return true;
}

interface Buckets {
  /** length → words of that length, ASCII-ascending. */
  readonly perLength: Map<number, readonly string[]>;
  /** Lengths present, ascending — the global index walks these in order. */
  readonly lengths: readonly number[];
  readonly total: number;
}

/** Reproduce buildLocalWordPool's bucketing: dedupe per length, ASCII sort within a length,
 *  lengths ascending. Built in one pass over the whole list. */
function buildBuckets(words: Iterable<string>): Buckets {
  const sets = new Map<number, Set<string>>();
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (w.length === 0 || !isAsciiWord(w)) continue;
    let set = sets.get(w.length);
    if (!set) sets.set(w.length, (set = new Set<string>()));
    set.add(w);
  }
  const lengths = [...sets.keys()].sort((a, b) => a - b);
  const perLength = new Map<number, readonly string[]>();
  let total = 0;
  for (const len of lengths) {
    // Default sort is code-unit order, which IS ordinal order for ASCII — the same
    // comparison the C# WordPoolSet and the local emulation both use.
    const arr = [...sets.get(len)!].sort();
    perLength.set(len, arr);
    total += arr.length;
  }
  return { perLength, lengths, total };
}

/** Build a pool over a client-side `Dictionary` (solo / sandbox / the Testing Bay).
 *
 *  Bucketing is deferred to the first index query and then memoized: a Classic match never
 *  touches it, and paying a 386k-word pass at construction would slow every solo boot for a
 *  mode that may not be selected. `has` delegates straight through, so membership works
 *  without ever building the buckets.
 *
 *  The global index is COMPUTED by walking length buckets rather than materializing a
 *  386k-entry concatenated array — same contract, no second copy of the lexicon. */
export function dictionaryWordPool(dict: DictionaryLike): WordPool {
  let buckets: Buckets | null = null;
  const built = (): Buckets => (buckets ??= buildBuckets(dict.words()));

  return {
    has: (word) => dict.has(word),
    count: () => built().total,
    pick: (index) => {
      const b = built();
      let i = Math.trunc(index);
      if (!Number.isFinite(i) || i < 0 || i >= b.total) return null;
      for (const len of b.lengths) {
        const arr = b.perLength.get(len)!;
        if (i < arr.length) return arr[i];
        i -= arr.length;
      }
      return null;
    },
    countOfLength: (len) => built().perLength.get(Math.trunc(len))?.length ?? 0,
    pickOfLength: (len, index) => {
      const arr = built().perLength.get(Math.trunc(len));
      if (!arr) return null;
      const i = Math.trunc(index);
      return Number.isFinite(i) && i >= 0 && i < arr.length ? arr[i] : null;
    },
  };
}
