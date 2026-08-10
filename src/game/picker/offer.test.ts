/*
 * Offer generation. Two kinds of test here, deliberately kept apart:
 *
 *  - SHAPE tests over the real shipped Reduced pool (public/assets/words-common.txt), because the
 *    properties that matter — the length correction, the letter-starvation lookahead — are claims
 *    about that specific pool and are meaningless on a toy fixture.
 *  - INVARIANT tests over small hand-built fixtures, where the pool can be starved on purpose.
 *
 * Distribution assertions pin AGGREGATE bands, never exact per-card frequencies: LENGTH_BANDS is
 * explicitly a tunable table, and a test that locks its exact output makes it untunable.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Dictionary } from "../dictionary";
import {
  buildPoolIndex,
  generateOffer,
  LENGTH_BANDS,
  MAX_OFFER_LENGTH,
  MIN_OFFER_LENGTH,
  type OfferRequest,
} from "./offer";
import { dictionaryWordPool, type WordPool } from "./wordPool";

/* `orderPreservingRng` is a CONSTANT (rng.ts:10), so it drives every draw to the top of its range
 * — fine for order-preserving shuffles, useless for distribution work. mulberry32 gives a cheap,
 * seedable, well-distributed stream so the shape tests measure the generator and not the RNG. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSETS = path.resolve(__dirname, "../../../public/assets");

function loadList(file: string): string[] {
  return readFileSync(path.join(ASSETS, file), "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

const REDUCED_WORDS = loadList("words-common.txt");
const reducedPool = dictionaryWordPool(new Dictionary(REDUCED_WORDS));
const reducedIndex = buildPoolIndex(reducedPool);

function poolOf(words: string[]): { pool: WordPool; index: ReturnType<typeof buildPoolIndex> } {
  const pool = dictionaryWordPool(new Dictionary(words));
  return { pool, index: buildPoolIndex(pool) };
}

/** A request over the real Reduced pool, with sensible defaults. */
function req(over: Partial<OfferRequest> = {}): OfferRequest {
  return {
    pool: reducedPool,
    index: reducedIndex,
    requiredLetter: "c",
    usedWords: new Set<string>(),
    count: 5,
    rng: seeded(1),
    ...over,
  };
}

/** Letters worth sweeping: common, mid, and the scarce ones that stress the lookahead. */
const SWEEP_LETTERS = "abcdefghijklmnoprstuvwy".split("");

describe("generateOffer — hard guarantees over the shipped Reduced pool", () => {
  it("always satisfies Succession", () => {
    for (const letter of SWEEP_LETTERS) {
      for (let s = 0; s < 40; s++) {
        const r = generateOffer(req({ requiredLetter: letter, rng: seeded(s * 31 + 7) }));
        if (r.freedLetter) continue; // letter was unplayable; the contract is explicitly waived
        for (const w of r.words) {
          expect(w[0], `letter=${letter} seed=${s} word=${w}`).toBe(letter);
        }
      }
    }
  });

  it("never offers a word outside the offerable length range", () => {
    for (const letter of SWEEP_LETTERS) {
      for (let s = 0; s < 20; s++) {
        for (const w of generateOffer(req({ requiredLetter: letter, rng: seeded(s) })).words) {
          expect(w.length).toBeGreaterThanOrEqual(MIN_OFFER_LENGTH);
          expect(w.length).toBeLessThanOrEqual(MAX_OFFER_LENGTH);
        }
      }
    }
  });

  it("only offers words the pool actually contains", () => {
    for (const letter of SWEEP_LETTERS) {
      for (const w of generateOffer(req({ requiredLetter: letter, rng: seeded(99) })).words) {
        expect(reducedPool.has(w), w).toBe(true);
      }
    }
  });

  it("serves a full-size Offer for every healthy letter", () => {
    for (const letter of SWEEP_LETTERS) {
      for (const count of [3, 5, 8]) {
        const r = generateOffer(req({ requiredLetter: letter, count, rng: seeded(count) }));
        expect(r.words.length, `letter=${letter} count=${count}`).toBe(count);
        expect(r.short).toBe(false);
      }
    }
  });

  it("never repeats a word within one Offer", () => {
    for (const letter of SWEEP_LETTERS) {
      for (let s = 0; s < 30; s++) {
        const { words } = generateOffer(req({ requiredLetter: letter, count: 8, rng: seeded(s) }));
        expect(new Set(words).size).toBe(words.length);
      }
    }
  });

  it("never offers an already-played word, even when the slice is nearly exhausted", () => {
    // Consume ~90% of every 5-letter c-word, forcing the fallback rungs to do real work.
    const used = new Set<string>();
    const { start, end } = reducedIndex.range("c", 5);
    for (let i = start; i < end - 3; i++) used.add(reducedPool.pickOfLength(5, i)!);

    for (let s = 0; s < 40; s++) {
      const r = generateOffer(req({ requiredLetter: "c", usedWords: used, rng: seeded(s) }));
      expect(r.words.length).toBe(5);
      for (const w of r.words) expect(used.has(w), w).toBe(false);
    }
  });

  it("does not mutate the caller's usedWords", () => {
    const used = new Set(["candle", "carrot"]);
    generateOffer(req({ usedWords: used }));
    expect([...used].sort()).toEqual(["candle", "carrot"]);
  });
});

describe("generateOffer — the length correction", () => {
  /** Sample many offers across many letters and report the realised length shape. */
  function sampleLengths(count: number, offers: number): number[] {
    const out: number[] = [];
    for (let s = 0; s < offers; s++) {
      const letter = SWEEP_LETTERS[s % SWEEP_LETTERS.length];
      for (const w of generateOffer(req({ requiredLetter: letter, count, rng: seeded(s + 1) }))
        .words) {
        out.push(w.length);
      }
    }
    return out;
  }

  it("keeps 10+ letter words occasional rather than near-certain", () => {
    // THE number this mode exists to fix. An unshaped uniform draw of 5 from the Full list puts a
    // 10+ letter word in ~95% of Offers, which would leave Sesquipedalian (x5 at 10+) permanently
    // active. The shaped draw has to be far below that.
    let withLong = 0;
    const offers = 600;
    for (let s = 0; s < offers; s++) {
      const letter = SWEEP_LETTERS[s % SWEEP_LETTERS.length];
      const { words } = generateOffer(req({ requiredLetter: letter, rng: seeded(s + 1) }));
      if (words.some((w) => w.length >= 10)) withLong++;
    }
    const p = withLong / offers;
    expect(p).toBeLessThan(0.8); // nowhere near the unshaped ~0.95
    expect(p).toBeGreaterThan(0.2); // but long words must not vanish either
  });

  it("lands each band's share within a few points of its target", () => {
    const lengths = sampleLengths(5, 900);
    for (const band of LENGTH_BANDS) {
      const share = lengths.filter((l) => l >= band.min && l <= band.max).length / lengths.length;
      // Generous tolerance on purpose: remapping and the lookahead both perturb the draw, and the
      // table is meant to stay tunable. This asserts the correction is WORKING, not its exact aim.
      expect(
        Math.abs(share - band.weight),
        `band ${band.min}-${band.max} got ${share}`,
      ).toBeLessThan(0.1);
    }
  });

  it("shapes the same way at other Offer counts", () => {
    for (const count of [3, 8]) {
      const lengths = sampleLengths(count, 300);
      const short = lengths.filter((l) => l <= 6).length / lengths.length;
      expect(short, `count=${count}`).toBeGreaterThan(0.25);
      expect(short, `count=${count}`).toBeLessThan(0.65);
    }
  });

  it("makes Full and Reduced play the same game", () => {
    /* THE reason LENGTH_BANDS is an explicit target rather than a curve derived from the pool.
     * Raw, the two pools are nothing alike — Full has median length 9 with 73% of entries at 8+
     * letters, Reduced median ~6 with 34%. A pool-relative correction would leave the Offer
     * Dictionary setting silently changing the game's difficulty and scoring economy rather than
     * just its vocabulary. After shaping, the two must be near-indistinguishable by length.
     *
     * Measured at the time of writing: median 7 on both; P(10+) 51.7% Reduced vs 55.4% Full. */
    const shape = (words: string[]): { median: number; long: number } => {
      const pool = dictionaryWordPool(new Dictionary(words));
      const index = buildPoolIndex(pool);
      const lens: number[] = [];
      let withLong = 0;
      const n = 400;
      for (let s = 0; s < n; s++) {
        const { words: got } = generateOffer({
          pool,
          index,
          requiredLetter: SWEEP_LETTERS[s % SWEEP_LETTERS.length],
          usedWords: new Set(),
          count: 5,
          rng: seeded(s + 1),
        });
        if (got.some((w) => w.length >= 10)) withLong++;
        for (const w of got) lens.push(w.length);
      }
      lens.sort((a, b) => a - b);
      return { median: lens[lens.length >> 1], long: withLong / n };
    };

    const reduced = shape(REDUCED_WORDS);
    const full = shape(loadList("words.txt"));
    expect(Math.abs(reduced.median - full.median)).toBeLessThanOrEqual(1);
    expect(Math.abs(reduced.long - full.long)).toBeLessThan(0.15);
  });
});

describe("generateOffer — the ending-letter lookahead", () => {
  it("knows `x` is starved on the Reduced pool", () => {
    // The premise of the whole mechanism: one offerable word starts with x, so a five-card Offer
    // could never be built for it.
    expect(reducedIndex.atLeastStarting("x", 5)).toBe(false);
    expect(reducedIndex.startTotal("x")).toBeLessThan(5);
  });

  it("refuses the x trap — never offers a word ending in a starved letter", () => {
    const starved = ["x", "z", "q", "j", "v"].filter((c) => !reducedIndex.atLeastStarting(c, 5));
    expect(starved.length, "expected at least one starved letter to test").toBeGreaterThan(0);

    for (const letter of SWEEP_LETTERS) {
      for (let s = 0; s < 30; s++) {
        const r = generateOffer(req({ requiredLetter: letter, rng: seeded(s * 17 + 3) }));
        if (r.short) continue; // a relaxed rung fired; the lookahead is allowed to yield there
        for (const w of r.words) {
          expect(starved, `letter=${letter} word=${w}`).not.toContain(w[w.length - 1]);
        }
      }
    }
  });

  it("tightens as a letter's start-words are consumed", () => {
    // `k` is healthy at count 5 but not unlimited. Consume its start-words and the words ending
    // in k must stop being offered — the dynamic half of the lookahead, which a static
    // pool-only check would miss.
    const kStarts: string[] = [];
    for (const len of reducedIndex.lengthsFor("k")) {
      const { start, end } = reducedIndex.range("k", len);
      for (let i = start; i < end; i++) kStarts.push(reducedPool.pickOfLength(len, i)!);
    }
    expect(reducedIndex.atLeastStarting("k", 5)).toBe(true);

    const used = new Set(kStarts.slice(0, kStarts.length - 2)); // leave only 2 k-starters
    let offeredKEnder = 0;
    for (const letter of SWEEP_LETTERS) {
      for (let s = 0; s < 10; s++) {
        const r = generateOffer(req({ requiredLetter: letter, usedWords: used, rng: seeded(s) }));
        if (r.short) continue;
        offeredKEnder += r.words.filter((w) => w.endsWith("k")).length;
      }
    }
    expect(offeredKEnder).toBe(0);
  });

  /* The selfConsumed term: a word that both starts and ends with the same letter consumes one of
   * that letter's own start-words, so the next player is left one short of what usedWords implies.
   *
   * Isolating it takes care. Under a CONSTRAINED letter it is unobservable by construction: a word
   * can only self-consume when it ends in the required letter, and then the letter's start-words
   * ARE the draw pool — so refusing one makes the Offer short, and the relaxed rung puts it
   * straight back. It only bites in free-letter mode, where the draw pool is the whole dictionary
   * and refusing one word costs nothing.
   *
   * So: letter `l` has exactly three start-words, one of which is "level". The threshold is
   * `startTotal(l) >= count + selfConsumed`, which makes count 3 the exact boundary — refused at
   * 3, allowed at 2. Testing both sides proves the +1 is what's doing the work, not some other
   * exclusion. */
  const SELF_CONSUME_POOL = [
    "level", // l -> l : the self-consumer
    "lamp", // l -> p
    "lion", // l -> n  (so `l` has exactly three start-words)
    "paint",
    "piano",
    "pearl",
    "noble",
    "nurse",
    "night",
    "table",
    "tiger",
    "tulip",
    "ocean",
    "onion",
    "opera",
    "eagle",
    "email",
    "enter",
    "radio",
    "river",
    "robin",
    "amber",
    "apple",
    "arrow",
  ];

  it("refuses a self-consuming word at the threshold", () => {
    const { pool, index } = poolOf(SELF_CONSUME_POOL);
    expect(index.startTotal("l")).toBe(3);

    let sawLevel = 0;
    let sawOtherL = 0;
    for (let s = 0; s < 150; s++) {
      const { words } = generateOffer({
        pool,
        index,
        requiredLetter: "",
        usedWords: new Set(),
        count: 3, // needs startTotal(l) >= 3 + 1 = 4, but l has only 3
        rng: seeded(s + 1),
      });
      if (words.includes("level")) sawLevel++;
      if (words.includes("lamp") || words.includes("lion")) sawOtherL++;
    }
    expect(sawLevel).toBe(0); // the self-consumer is refused...
    expect(sawOtherL).toBeGreaterThan(0); // ...while l-words in general are not
  });

  it("allows the same word one step below the threshold", () => {
    // count 2 needs startTotal(l) >= 2 + 1 = 3, which l exactly satisfies. Nothing else about
    // the pool changed, so this pins the term itself rather than a general l-exclusion.
    const { pool, index } = poolOf(SELF_CONSUME_POOL);
    let sawLevel = 0;
    for (let s = 0; s < 150; s++) {
      const { words } = generateOffer({
        pool,
        index,
        requiredLetter: "",
        usedWords: new Set(),
        count: 2,
        rng: seeded(s + 1),
      });
      if (words.includes("level")) sawLevel++;
    }
    expect(sawLevel).toBeGreaterThan(0);
  });
});

describe("generateOffer — free-letter Offers", () => {
  it("draws from the whole pool and still shapes length", () => {
    const firsts = new Set<string>();
    const lengths: number[] = [];
    for (let s = 0; s < 200; s++) {
      const { words, freedLetter } = generateOffer(req({ requiredLetter: "", rng: seeded(s + 1) }));
      expect(freedLetter).toBe(false);
      expect(words.length).toBe(5);
      for (const w of words) {
        firsts.add(w[0]);
        lengths.push(w.length);
      }
    }
    expect(firsts.size).toBeGreaterThan(15); // genuinely unconstrained
    const long = lengths.filter((l) => l >= 10).length / lengths.length;
    expect(long).toBeLessThan(0.35); // still corrected, not raw
  });

  it("still applies the lookahead", () => {
    for (let s = 0; s < 60; s++) {
      const { words, short } = generateOffer(req({ requiredLetter: "", rng: seeded(s + 1) }));
      if (short) continue;
      for (const w of words) expect(w.endsWith("x"), w).toBe(false);
    }
  });
});

describe("generateOffer — degenerate pools", () => {
  it("frees the letter when nothing starts with it", () => {
    const { pool, index } = poolOf(["apple", "amber", "argue", "anvil", "adore", "melon"]);
    const r = generateOffer({
      pool,
      index,
      requiredLetter: "q", // no q-words at all
      usedWords: new Set(),
      count: 3,
      rng: seeded(2),
    });
    expect(r.freedLetter).toBe(true);
    expect(r.words.length).toBe(3);
    expect(r.words.every((w) => w[0] === "q")).toBe(false);
  });

  it("frees the letter when the match has consumed every word starting with it", () => {
    const { pool, index } = poolOf(["cat", "cog", "cub", "melon", "maple", "mango", "mirth"]);
    const r = generateOffer({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(["cat", "cog", "cub"]),
      count: 3,
      rng: seeded(3),
    });
    expect(r.freedLetter).toBe(true);
    expect(r.words.some((w) => w[0] === "m")).toBe(true);
  });

  it("serves a short Offer rather than padding when the letter is nearly exhausted", () => {
    const { pool, index } = poolOf(["cat", "cog", "cub", "melon", "maple", "mango"]);
    const r = generateOffer({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(["cat"]),
      count: 5,
      rng: seeded(4),
    });
    expect(r.words.length).toBe(2); // cog, cub — never duplicated to reach 5
    expect(new Set(r.words).size).toBe(2);
    expect(r.short).toBe(true);
    expect(r.freedLetter).toBe(false);
  });

  it("fills even when the band table aims where the letter has nothing", () => {
    /* Adversarial: every c-word is 4 letters, but the drawn band will usually be 5-6 or 7-8.
     * Remapping (or the widened rung) has to land on 4 anyway and still serve a full Offer. */
    const { pool, index } = poolOf([
      "cart",
      "cast",
      "cope",
      "cure",
      "clam",
      "chat",
      "epic",
      "term",
      "port",
      "tidy",
      "mile",
      "atom",
      "rope",
    ]);
    for (let s = 0; s < 30; s++) {
      const r = generateOffer({
        pool,
        index,
        requiredLetter: "c",
        usedWords: new Set(),
        count: 5,
        rng: seeded(s + 1),
      });
      expect(r.words.length, `seed=${s}`).toBe(5);
      expect(r.words.every((w) => w.length === 4 && w[0] === "c")).toBe(true);
    }
  });

  it("terminates when every candidate would starve the next player", () => {
    // All c-words end in x, and x has no start-words: rung 3 must relax the lookahead and
    // return rather than spin.
    const { pool, index } = poolOf(["calx", "crux", "coax", "cru", "flax"]);
    const r = generateOffer({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(),
      count: 3,
      rng: seeded(6),
    });
    expect(r.words.length).toBe(3);
    expect(r.words.filter((w) => w.endsWith("x")).length).toBeGreaterThan(0);
  });

  it("returns an empty Offer for count 0 without touching the pool", () => {
    expect(generateOffer(req({ count: 0 })).words).toEqual([]);
  });

  it("degrades a corrupt required letter to a free-letter Offer", () => {
    const r = generateOffer(req({ requiredLetter: "?" }));
    expect(r.freedLetter).toBe(true);
    expect(r.words.length).toBe(5);
  });
});

describe("generateOffer — determinism", () => {
  it("returns the same Offer for the same seed and inputs", () => {
    for (const letter of ["a", "c", "s", "t"]) {
      const a = generateOffer(req({ requiredLetter: letter, rng: seeded(1234) }));
      const b = generateOffer(req({ requiredLetter: letter, rng: seeded(1234) }));
      expect(a.words).toEqual(b.words);
      expect(a.freedLetter).toBe(b.freedLetter);
    }
  });

  it("returns different Offers for different seeds", () => {
    const a = generateOffer(req({ rng: seeded(1) })).words;
    const b = generateOffer(req({ rng: seeded(2) })).words;
    expect(a).not.toEqual(b);
  });

  it("resolves an unsatisfiable draw the same way every time", () => {
    // Deterministic remapping / skipping is a GDD §3.2 requirement: a resolution that varied
    // between runs would desynchronise multiplayer.
    const { pool, index } = poolOf(["cart", "cast", "cope", "cure", "epic", "term"]);
    const one = generateOffer({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(),
      count: 4,
      rng: seeded(77),
    });
    const two = generateOffer({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(),
      count: 4,
      rng: seeded(77),
    });
    expect(one.words).toEqual(two.words);
  });

  it("does not present the guaranteed-legal word in a fixed slot", () => {
    /* The Offer is shuffled before returning. Without it, acceptance order leaks which rung the
     * picker fell back to and which word was the safe one. */
    const firstWords = new Set<string>();
    for (let s = 0; s < 60; s++) {
      firstWords.add(generateOffer(req({ requiredLetter: "s", rng: seeded(s + 1) })).words[0]);
    }
    expect(firstWords.size).toBeGreaterThan(10);
  });
});

describe("the shipped Reduced pool", () => {
  it("is a subset of the Full list, so every offered word passes isWord", () => {
    /* THE regression guarding the packaging decision. The raw source list is NOT a subset of
     * words.txt (613 entries absent: aol, api, asn, apnic, adidas, alot...). submitWord validates
     * every commit through isWord, which stays bound to the Full list in BOTH modes — so a
     * non-subset Reduced pool would make ~6% of offered words reject as "not-a-word", including
     * the random pick a Picker timeout commits. tools/build-common-wordlist.mjs takes the
     * intersection; this proves the shipped artefact actually has that property. */
    const full = new Set(loadList("words.txt"));
    const missing = REDUCED_WORDS.filter((w) => !full.has(w));
    expect(missing).toEqual([]);
  });

  it("carries no word too short to be legal", () => {
    expect(REDUCED_WORDS.filter((w) => w.length < MIN_OFFER_LENGTH)).toEqual([]);
  });

  it("is plain lowercase ASCII, so the binary search's ordering holds", () => {
    expect(REDUCED_WORDS.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
  });
});
