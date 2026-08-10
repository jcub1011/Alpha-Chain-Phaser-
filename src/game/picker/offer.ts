/*
 * The Word Picker — generates the Offer (the candidate words shown to the active player).
 *
 * PURITY IS A BUILD CONSTRAINT, not a preference. This module is bundled into authority.js and
 * executed in the server's Jint sandbox, which has no `Date`, no `fetch` and no DOM, and where
 * `npm run build:authority` rejects any import. So: no I/O, no ambient time, RNG injected.
 *
 * DETERMINISM COMES STRUCTURALLY, not from seed replication. `kb.rng` is absent in production
 * (authority.ts falls back to Math.random), so clients cannot reproduce a draw — they don't have
 * to. Only the authoritative side generates an Offer and the result ships in the state snapshot,
 * exactly as the per-era turn-order shuffle does (match.ts beginEra). The invariant to protect is
 * that no RNG-derived logic runs on a client mirror.
 *
 * Note the contrast with `dealCards`, which pins "exactly one rng() call per card". Nothing here
 * needs a fixed call count: determinism means same inputs -> same output, which any pure function
 * of the rng stream satisfies. The one latent hazard is that a *variable* draw count shifts the
 * downstream position of the shared `MatchController.rng` stream, which `dealCards` also draws
 * from — so a future seeded-replay feature would want its own `offerRng`. Benign today: production
 * uses Math.random, and every test harness injects the stateless `orderPreservingRng`.
 *
 * THE THREE PROBLEMS THIS SOLVES
 *
 * 1. Length skew. The full list is severely skewed — median 9 letters, 73% at 8+, 45% at 10+.
 *    A uniform draw of 5 words would contain a 10+ letter word ~95% of turns, permanently
 *    activating Sesquipedalian (x5 at 10+) and handing out a large base score for free. Since
 *    the scoring seed IS the word length, an unshaped Offer breaks the whole length economy.
 *    So we draw against an EXPLICIT target distribution (LENGTH_BANDS) rather than one derived
 *    from the pool — a pool-relative correction would leave Full and Reduced playing as two
 *    different games.
 *
 * 2. Finding "words of length L starting with X" through an index-only API. The word service
 *    exposes no prefix query. But every pool orders words as length buckets ascending, ASCII
 *    ordinal within a length — so same-first-letter words occupy a CONTIGUOUS index range that
 *    a binary search finds in ~2*log2(n) probes. wordPool.test.ts pins that ordering.
 *
 * 3. Letter starvation. Succession makes the chosen word's LAST letter the next player's
 *    required letter, so the picker implicitly steers the chain's letter graph. On the Reduced
 *    pool only ONE word starts with `x` — offering a word ending in `x` would kill the chain
 *    within a turn. The lookahead refuses those, and it is cheap: barely 1% of the pool ends in
 *    a starved letter.
 */

import { shuffle } from "../rng";
import { NO_SHAPING, type OfferFilter, type OfferShaping } from "./preference";
import type { WordPool } from "./wordPool";

/** Shortest word the Offer may serve. match.ts rejects anything under 2 letters outright; 3 is
 *  the floor because 2-letter words are noise to evaluate and read as filler. */
export const MIN_OFFER_LENGTH = 3;

/** Longest word the Offer may serve.
 *
 *  Not cosmetic — it is what makes length handling tractable. The full list runs to 190
 *  characters and its buckets are NOT contiguous (nothing at 32-45, then singletons at 46 and
 *  190, mostly run-together junk), so "probe upward until a length is empty" would stop early and
 *  an open-ended top band could serve a 190-character Offer Card. A fixed sweep over
 *  MIN..MAX removes the question entirely, and doubles as the readability control the mode needs
 *  (GDD §5). */
export const MAX_OFFER_LENGTH = 16;

/** The Offer's target length distribution.
 *
 *  An explicit design target, deliberately NOT derived from the pool (see note 1 above). It
 *  lands close to the cleaned Reduced pool's natural shape (17/31/28/16/8), so for Reduced this
 *  is near-identity; against Full (73% at 8+) it is a large correction. That asymmetry is the
 *  point — both pools should play the same game.
 *
 *  Only the BAND weights are prescribed. Which length is drawn *inside* a band is weighted by
 *  how many words the pool actually has there, so the closed top band doesn't smear probability
 *  into a tail the pool barely populates.
 *
 *  Tune this table freely: the tests pin AGGREGATE properties (e.g. "P(Offer contains a 10+
 *  letter word)" sits in a band), never exact per-card frequencies, precisely so it stays
 *  tunable. Weights are a probability distribution and must sum to 1. */
export const LENGTH_BANDS: readonly { min: number; max: number; weight: number }[] = [
  { min: 3, max: 4, weight: 0.15 },
  { min: 5, max: 6, weight: 0.3 },
  { min: 7, max: 8, weight: 0.3 },
  { min: 9, max: 10, weight: 0.18 },
  { min: 11, max: MAX_OFFER_LENGTH, weight: 0.07 },
];

/** Sampling attempts per Offer Card before falling through to the next rung. Uniform sampling
 *  inside a (letter, length) range hits an acceptable word almost immediately unless the range is
 *  nearly exhausted — and the exhaustive rungs handle exactly that case exactly, so this stays
 *  small rather than trying to brute-force its way out. */
const SAMPLE_ATTEMPTS = 12;

/** An index over one pool, memoized for the pool's lifetime.
 *
 *  Every lookup is lazy: a Classic match builds nothing, and a Picker match pays only for the
 *  letters and lengths it actually touches. Worth caring about because on the server each pool
 *  call crosses the sandbox boundary. Build ONE per match and reuse it across turns. */
export interface PoolIndex {
  /** `[start, end)` index range within length bucket `len` of words starting with `letter`.
   *  `letter === ""` means "any", i.e. the whole bucket — which is what makes free-letter Offers
   *  share every code path with constrained ones. Empty range when there are none. */
  range(letter: string, len: number): { start: number; end: number };
  /** Offerable lengths (MIN..MAX) at which `letter` has at least one word, ascending. */
  lengthsFor(letter: string): readonly number[];
  /** Whether at least `n` offerable words start with `letter`. Incremental and memoized: a
   *  healthy letter answers after one binary search, because its first bucket already exceeds
   *  any plausible Offer count. This, not `startTotal`, is the lookahead's hot path. */
  atLeastStarting(letter: string, n: number): boolean;
  /** Exact count of offerable words starting with `letter`. Tests and diagnostics. */
  startTotal(letter: string): number;
  /** Letters that start at least one offerable word. */
  startLetters(): readonly string[];
}

/** First index whose word's initial character is >= `ch`. Compares ONLY the first character,
 *  which is what makes this a range search rather than a word search. */
function lowerBound(pool: WordPool, len: number, n: number, ch: string): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const w = pool.pickOfLength(len, mid);
    // A null mid (shouldn't happen inside [0,n)) sorts as "before", keeping the search total.
    if (w === null || w[0] < ch) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildPoolIndex(pool: WordPool): PoolIndex {
  const lengthCount = new Map<number, number>();
  const ranges = new Map<string, { start: number; end: number }>();
  const lengthsByLetter = new Map<string, readonly number[]>();
  /** Incremental start-count tally: how far up `lengthsFor` we've summed, and the sum so far. */
  const tally = new Map<string, { sum: number; next: number }>();
  let letters: readonly string[] | null = null;

  const countAt = (len: number): number => {
    let n = lengthCount.get(len);
    if (n === undefined) lengthCount.set(len, (n = pool.countOfLength(len)));
    return n;
  };

  const range = (letter: string, len: number): { start: number; end: number } => {
    if (len < MIN_OFFER_LENGTH || len > MAX_OFFER_LENGTH) return { start: 0, end: 0 };
    const n = countAt(len);
    if (letter === "") return { start: 0, end: n };
    // Defensive: a corrupt required letter must degrade to an empty range (and thence to a
    // free-letter Offer), never mis-range. Uppercase and punctuation sort below 'a', so they
    // would otherwise silently return the leading run.
    if (letter.length !== 1 || letter < "a" || letter > "z") return { start: 0, end: 0 };
    const key = `${letter}${len}`;
    let r = ranges.get(key);
    if (!r) {
      const start = lowerBound(pool, len, n, letter);
      // Upper bound = lower bound of the NEXT character. No 'z' special case needed: 'z' is
      // 0x7A, so this probes '{', which nothing starts with, and the search returns n.
      const next = String.fromCharCode(letter.charCodeAt(0) + 1);
      const end = lowerBound(pool, len, n, next);
      ranges.set(key, (r = { start, end: Math.max(start, end) }));
    }
    return r;
  };

  const lengthsFor = (letter: string): readonly number[] => {
    let ls = lengthsByLetter.get(letter);
    if (!ls) {
      const out: number[] = [];
      for (let len = MIN_OFFER_LENGTH; len <= MAX_OFFER_LENGTH; len++) {
        const r = range(letter, len);
        if (r.end > r.start) out.push(len);
      }
      lengthsByLetter.set(letter, (ls = out));
    }
    return ls;
  };

  /** Sum buckets for `letter` until the running total reaches `need` (or buckets run out).
   *  `next` only moves forward, so no bucket is ever counted twice across calls. */
  const advance = (letter: string, need: number): { sum: number; next: number } => {
    let t = tally.get(letter);
    if (!t) tally.set(letter, (t = { sum: 0, next: 0 }));
    const ls = lengthsFor(letter);
    while (t.sum < need && t.next < ls.length) {
      const r = range(letter, ls[t.next++]);
      t.sum += r.end - r.start;
    }
    return t;
  };

  return {
    range,
    lengthsFor,
    atLeastStarting: (letter, n) => (n <= 0 ? true : advance(letter, n).sum >= n),
    startTotal: (letter) => advance(letter, Infinity).sum,
    startLetters: () => {
      if (letters) return letters;
      const out: string[] = [];
      for (let c = 97; c <= 122; c++) {
        const ch = String.fromCharCode(c);
        if (advance(ch, 1).sum > 0) out.push(ch);
      }
      return (letters = out);
    },
  };
}

export interface OfferRequest {
  pool: WordPool;
  /** Index over `pool`. Shared across turns so its memos survive — build once per match. */
  index: PoolIndex;
  /** The Succession letter, or "" for a free-letter Offer (era opener, or the Wildcard's
   *  once-per-era "your Offer ignores the required letter"). */
  requiredLetter: string;
  /** Words already played this match. Offering one would be offering an unplayable card, so
   *  this exclusion is never relaxed — unlike the lookahead. Never mutated. */
  usedWords: ReadonlySet<string>;
  /** How many Offer Cards to serve, with any Preference Card deltas already applied. */
  count: number;
  /** Preference Card shaping for this turn. Omit for an unshaped Offer. */
  shaping?: OfferShaping;
  rng: () => number;
}

export interface OfferResult {
  /** The Offer, in presentation order (shuffled — see `generateOffer`). */
  words: string[];
  /** The required letter was unplayable (no unplayed word starts with it) and the Offer was
   *  redrawn from the whole pool. The caller MUST clear `state.requiredLetter`, or the HUD
   *  would advertise a letter the Offer does not honour. */
  freedLetter: boolean;
  /** Fewer than `count` words could be served: this letter is nearly exhausted. Not an error —
   *  the turn is still playable — but on the Reduced pool it means the chain is dying. */
  short: boolean;
  /** Card ids whose shape filter had to be skipped because it could not be satisfied at full
   *  Offer size. Diagnostics only — the player is not told which card lapsed. */
  skippedFilters: string[];
}

/** Uniform integer in [lo, hi). One rng() call. */
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo));
}

/** Pick an index into `weights` proportionally. One rng() call. */
function weightedIndex(weights: readonly number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  const r = rng() * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1; // float drift only
}

/** The available length nearest `target`, ties going SHORTER.
 *
 *  Both halves are deliberate. Deterministic, because GDD §3.2 requires that resolving an
 *  unsatisfiable constraint never varies between runs. Shorter-on-tie, because preferring longer
 *  leaks probability mass upward on every remap and partially undoes the correction the band
 *  table exists to apply — and shorter also favours decodability. */
function nearestLength(lengths: readonly number[], target: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const len of lengths) {
    const d = Math.abs(len - target);
    if (d < bestDist || (d === bestDist && len < best!)) {
      best = len;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Generate one turn's Offer.
 *
 * GUARANTEES
 *  - Every word is in the pool, is at least MIN_OFFER_LENGTH letters, has not been played, and
 *    starts with `requiredLetter` — unless `freedLetter` came back true, in which case the
 *    letter was unplayable and the caller must clear it.
 *  - No duplicates within the Offer. A repeated card is strictly worse than a short Offer.
 *  - Served at full `count` whenever `count` distinct unplayed words exist for the letter.
 *  - So the Offer always contains at least one *legal* word. No soft-lock.
 *
 * NOT GUARANTEED, deliberately: that any word is SAFE. Words carrying the era Banned Letter, a
 * personal ban or a hijack appear unannounced and score 0 when the Zero-Point Tax fires. Bans
 * are never a generation filter — only a scoring consequence. Legality here means *playable*,
 * not *safe*, and discovering the biggest word on the board was poisoned only when the score
 * lands is intended.
 */
export function generateOffer(req: OfferRequest): OfferResult {
  const { pool, index, usedWords, rng } = req;
  const letter = req.requiredLetter.toLowerCase();
  const count = Math.max(0, Math.trunc(req.count));
  const shaping = req.shaping ?? NO_SHAPING;
  if (count === 0) return { words: [], freedLetter: false, short: false, skippedFilters: [] };

  const lengths = index.lengthsFor(letter);

  /* The dead-letter escape. No word of any offerable length starts with this letter, so the
   * turn is literally unplayable — reachable on Reduced, where `x` has a single start-word:
   * once it is used, any turn requiring `x` has nothing to offer. Redraw from the whole pool and
   * tell the caller to clear the required letter. That is the same idiom the engine already uses
   * at an era boundary and after a banned-letter tail, not a new concept. */
  if (lengths.length === 0) {
    if (letter === "") return { words: [], freedLetter: false, short: true, skippedFilters: [] };
    const free = generateOffer({ ...req, requiredLetter: "" });
    return { ...free, freedLetter: true };
  }

  const offer: string[] = [];
  const taken = new Set<string>();

  /* Lookahead input: how many unplayed words start with each letter. Tallied ONCE per Offer
   * from usedWords (bounded by players x rounds, so this is trivial) and then read O(1) per
   * candidate.
   *
   * This is deliberately a pure histogram rather than a long-lived counter decremented as words
   * are played. A private counter is not in MatchState, so every path that rebuilds a match from
   * a snapshot — late join, rematch, the sandbox, a test replaying intents — would silently
   * carry a wrong one, and a wrong count presents as a distribution bug rather than a state bug.
   * The length filter matters too: counting used words outside the offerable range against a
   * total that excludes them would drift the balance negative. */
  const usedByStart = new Map<string, number>();
  for (const w of usedWords) {
    if (w.length < MIN_OFFER_LENGTH || w.length > MAX_OFFER_LENGTH) continue;
    usedByStart.set(w[0], (usedByStart.get(w[0]) ?? 0) + 1);
  }

  /* Would choosing `word` leave the next player a viable pool? Exact and O(1).
   *
   * `selfConsumed` is not a nicety: a word that both starts and ends with the same letter
   * (`level`, `radar`, `sees`) removes one of that letter's own start-words on top of whatever
   * usedWords already accounts for. Omitting it makes the check off by one exactly on the
   * starved letters it exists to protect.
   *
   * NOTE: a word ending in the era's Banned Letter actually clears the required letter entirely
   * (match.ts: `requiredLetter = last === bannedLetter ? "" : last`), so such a word can never
   * starve anyone and is refused here unnecessarily. Teaching the generator about the banned
   * letter would buy a little variety at the cost of passing a ban into a function that must
   * never filter on bans — not worth the ambiguity. */
  const leavesViableChain = (word: string): boolean => {
    const last = word[word.length - 1];
    const selfConsumed = word[0] === last ? 1 : 0;
    return index.atLeastStarting(last, count + selfConsumed + (usedByStart.get(last) ?? 0));
  };

  const fresh = (word: string): boolean => !usedWords.has(word) && !taken.has(word);

  const accept = (word: string): void => {
    taken.add(word);
    offer.push(word);
  };

  /* Preference Card filters, in bay order. They intersect, and their relative order is
   * player-controlled and meaningful — which is why one is dropped from the RIGHT when they cannot
   * all be satisfied: the leftmost survives longest, honouring the order the player chose. */
  const activeFilters: OfferFilter[] = [...shaping.filters];
  const skippedFilters: string[] = [];
  const acceptable = (word: string, requireLookahead: boolean): boolean =>
    fresh(word) &&
    activeFilters.every((f) => f.accepts(word)) &&
    (!requireLookahead || leavesViableChain(word));

  /** Words of `len` available to this letter. `range` already unifies constrained and free. */
  const sizeCache = new Map<number, number>();
  const sliceSize = (len: number): number => {
    let s = sizeCache.get(len);
    if (s === undefined) {
      const r = index.range(letter, len);
      sizeCache.set(len, (s = r.end - r.start));
    }
    return s;
  };
  const wordAt = (len: number, i: number): string | null =>
    pool.pickOfLength(len, index.range(letter, len).start + i);

  /** Draw a length: band from the target table, then a length inside it weighted by how many
   *  words are actually there. Two rng() calls, or one when the band has to be remapped. */
  const drawLength = (): number => {
    const band =
      LENGTH_BANDS[
        weightedIndex(
          LENGTH_BANDS.map((b) => b.weight),
          rng,
        )
      ];
    const inBand = lengths.filter((l) => l >= band.min && l <= band.max);
    if (inBand.length === 0) {
      // This letter has nothing in the drawn band; remap to the nearest length it does have.
      return nearestLength(lengths, (band.min + band.max) >> 1)!;
    }
    return inBand[weightedIndex(inBand.map(sliceSize), rng)];
  };

  /** Try to fill the Offer by uniform sampling. `pickLength` chooses where to aim. */
  const sample = (pickLength: () => number): void => {
    while (offer.length < count) {
      const len = pickLength();
      const size = sliceSize(len);
      let got = false;
      for (let attempt = 0; attempt < SAMPLE_ATTEMPTS && size > 0; attempt++) {
        const word = wordAt(len, randInt(rng, 0, size));
        if (word === null || !acceptable(word, true)) continue;
        // The soft bias (Tide), spelling out "where the pool allows": insist on it for the
        // first half of the attempts, then take anything that qualifies. It can narrow an Offer
        // but must never starve one.
        if (shaping.prefer && attempt * 2 < SAMPLE_ATTEMPTS && !shaping.prefer(word)) continue;
        accept(word);
        got = true;
        break;
      }
      if (!got) return; // sampling has stopped paying; hand over to the next rung
    }
  };

  /* ── Guarantees first ──
   * Prospector's rare letter and Sentinel's ban-free word each cost an Offer SLOT, so they
   * are drawn before the general fill rather than patched in afterwards. That is the card's stated
   * price ("an Offer slot spent on a word you may not want"), and seeding makes it literal.
   *
   * A guarantee that cannot be met is skipped in silence — same rule as an unsatisfiable filter,
   * for the same reason: nothing a Preference Card asks for may shrink the Offer. */
  const seedGuarantee = (g: OfferFilter): void => {
    if (offer.length >= count || offer.some((w) => g.accepts(w))) return;
    // Sample first — on a healthy pool this lands almost immediately.
    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS * 2; attempt++) {
      const len = drawLength();
      const size = sliceSize(len);
      if (size === 0) continue;
      const word = wordAt(len, randInt(rng, 0, size));
      if (word !== null && acceptable(word, true) && g.accepts(word)) return accept(word);
    }
    // Then settle it deterministically: a rare-letter word is genuinely scarce, so rejection
    // sampling alone would find one only by luck.
    for (const len of lengths) {
      const size = sliceSize(len);
      for (let k = 0; k < size; k++) {
        const word = wordAt(len, k);
        if (word !== null && acceptable(word, true) && g.accepts(word)) return accept(word);
      }
    }
  };
  for (const g of shaping.guarantees) seedGuarantee(g);

  /* ── Rungs 0 and 1, then drop a filter and retry ──
   * Rung 0 aims with the target distribution; rung 1 relaxes the band table only, because the
   * commonest stall is aim rather than unsatisfiability. If the Offer still cannot be filled, a
   * shape filter is genuinely too tight for this letter, so the rightmost one is skipped ENTIRELY
   * — never partially applied — and the whole fill is retried. Deterministic: which filter goes is
   * decided by bay order, never by the rng. */
  const widened = (): number => lengths[weightedIndex(lengths.map(sliceSize), rng)];

  /* ── The deterministic exhaustive sweep ──
   * Rejection sampling cannot guarantee completion once the available set is only barely large
   * enough, so the ladder has to bottom out in an enumeration. Lengths ascending is a fixed
   * order; the random wrap-around start only stops a nearly-exhausted slice from always yielding
   * its alphabetically-first words.
   *
   * Affordable despite looking O(pool): it stops the instant the Offer is full, so a large slice
   * costs ~count steps. A slice is only ever walked in full when it is nearly exhausted — which
   * is to say, when it is small.
   *
   * WHAT IS NEVER RELAXED, at any rung: pool membership, already-played words (they are illegal —
   * submitWord rejects them, so offering one would be offering a dead card), within-Offer
   * uniqueness, and the minimum length. Those are exactly the checks commitSelection re-runs. */
  const sweep = (requireLookahead: boolean): void => {
    for (const len of lengths) {
      if (offer.length >= count) return;
      const size = sliceSize(len);
      if (size === 0) continue;
      const start = randInt(rng, 0, size);
      for (let k = 0; k < size && offer.length < count; k++) {
        const word = wordAt(len, (start + k) % size);
        if (word === null || !acceptable(word, requireLookahead)) continue;
        accept(word);
      }
    }
  };

  /**
   * One filling pass: aim, re-aim, then enumerate — dropping the rightmost surviving filter and
   * repeating whenever the ENUMERATION comes up short.
   *
   * The sweep, not the sampling, is what decides a filter is unsatisfiable. That distinction is the
   * whole correctness of this ladder: `drawLength` aims by length band and knows nothing about the
   * filters, so with Sieve in the bay it happily keeps aiming at 3- and 4-letter slices where
   * no word can ever pass. Judging satisfiability by "sampling gave up" would therefore skip the
   * Sieve on a pool holding hundreds of legal 6+ letter words — the card silently doing nothing,
   * with no error anywhere.
   */
  const fillPass = (requireLookahead: boolean): string[] => {
    activeFilters.length = 0;
    activeFilters.push(...shaping.filters);
    const dropped: string[] = [];
    for (;;) {
      if (requireLookahead) {
        sample(drawLength);
        if (offer.length >= count) break;
        sample(widened);
        if (offer.length >= count) break;
      }
      sweep(requireLookahead);
      if (offer.length >= count || activeFilters.length === 0) break;
      // Deterministic, and from the RIGHT: filter order is player-controlled, so the leftmost
      // survives longest.
      dropped.push(activeFilters.pop()!.cardId);
    }
    return dropped;
  };

  let dropped = fillPass(true);
  if (offer.length < count) {
    /* The lookahead relaxes LAST, because it is the only constraint whose violation harms a
     * DIFFERENT player on a LATER turn — everything above it only shapes the current Offer, and a
     * full-size Offer is a stated guarantee.
     *
     * Every filter is RESTORED for this pass. Reaching here means the first pass gave them all up
     * and still came short, which proves the lookahead was the real blocker — so the filters were
     * discarded for something that was never their fault, and are worth another try now that it is
     * out of the way. */
    dropped = fillPass(false);
  }
  skippedFilters.push(...dropped);

  /* Still nothing at all, with a constrained letter: every word starting with it has been
   * played. Same dead-letter escape as above — the difference is that here the letter had words
   * once, and the match consumed them. */
  if (offer.length === 0 && letter !== "") {
    const free = generateOffer({ ...req, requiredLetter: "" });
    return { ...free, freedLetter: true };
  }

  /* Shuffle before returning. Acceptance order leaks provenance: index 0 is always the
   * ideal-rung word, and sweep results arrive alphabetically clustered. GDD §2.2 promises the
   * Offer *contains* at least one legal word — not that the player can tell which one that was,
   * nor which rung the picker had to fall back to. */
  return {
    words: shuffle(offer, rng),
    freedLetter: false,
    short: offer.length < count,
    skippedFilters,
  };
}
