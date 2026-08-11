/*
 * Adapter parity — the assumption the Offer generator's binary search rests on.
 *
 * `dictionaryWordPool` (solo) and `kbWordPool` (server) must expose the SAME word at the same
 * index, or offer generation silently diverges between solo and networked play: the binary
 * search would return a wrong-but-plausible index range and quietly offer words that don't
 * start with the required letter, rather than failing.
 *
 * So this compares against the REAL local-tab emulation (`_buildLocalWords`, which the addon
 * exports for exactly this purpose) rather than a reimplementation of it. That emulation is
 * itself parity-pinned to the C# WordPoolSet by a shared fixture, so agreeing with it means
 * agreeing with the production server.
 */

import { describe, expect, it } from "vitest";
import KnockBoxLocalImport from "../../../addons/knockbox/knockbox-local.js";
import { Dictionary } from "../dictionary";
import { dictionaryWordPool, kbWordPool, type WordPool } from "./wordPool";

const buildLocalWords = KnockBoxLocalImport._buildLocalWords;

/* A fixture chosen to exercise every ordering rule at once:
 *  - several lengths, deliberately NOT introduced in length order (so a naive
 *    insertion-order pool fails);
 *  - runs of same-length words sharing a first letter (the contiguity the search needs),
 *    listed out of alphabetical order;
 *  - a duplicate ("cat"), which both sides must dedupe;
 *  - length gaps — nothing of length 7, so countOfLength(7) must be 0, not a throw;
 *  - first letters that sort adjacently (c/d) and a scarce one (x) with a single entry. */
const FIXTURE = [
  "zebra",
  "cat",
  "apple",
  "cog",
  "dog",
  "cab",
  "banana",
  "ax",
  "cats",
  "do",
  "xylophone",
  "cat",
  "dote",
  "cabs",
  "an",
  "ox",
  "candle",
  "dorm",
  "cape",
  "xi",
];

/** Every length worth probing, plus the boundaries the pool has nothing at. */
const LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe("WordPool adapters — solo/server ordering parity", () => {
  const kb = kbWordPool(buildLocalWords!({ en: FIXTURE }), "en");
  const solo = dictionaryWordPool(new Dictionary(FIXTURE));

  it("agrees on total count", () => {
    // 20 entries minus the one duplicate.
    expect(solo.count()).toBe(19);
    expect(solo.count()).toBe(kb.count());
  });

  it("agrees on countOfLength at every length, including empty ones", () => {
    for (const len of LENGTHS) {
      expect(solo.countOfLength(len), `length ${len}`).toBe(kb.countOfLength(len));
    }
    expect(solo.countOfLength(7)).toBe(0); // a genuine gap in the fixture
  });

  it("agrees on pickOfLength for every in-range index", () => {
    for (const len of LENGTHS) {
      const n = kb.countOfLength(len);
      for (let i = 0; i < n; i++) {
        expect(solo.pickOfLength(len, i), `length ${len} index ${i}`).toBe(kb.pickOfLength(len, i));
      }
    }
  });

  it("agrees on the contiguous global index across the whole pool", () => {
    for (let i = 0; i < kb.count(); i++) {
      expect(solo.pick(i), `index ${i}`).toBe(kb.pick(i));
    }
  });

  it("returns null out of range rather than throwing, on both adapters", () => {
    for (const pool of [solo, kb] as WordPool[]) {
      expect(pool.pick(-1)).toBeNull();
      expect(pool.pick(pool.count())).toBeNull();
      expect(pool.pickOfLength(3, -1)).toBeNull();
      expect(pool.pickOfLength(3, pool.countOfLength(3))).toBeNull();
      expect(pool.pickOfLength(7, 0)).toBeNull(); // length the pool has none of
    }
  });

  it("agrees on membership for ASCII words", () => {
    for (const w of ["cat", "candle", "xi", "zebra", "nope", "aardvark"]) {
      expect(solo.has(w), w).toBe(kb.has(w));
    }
  });

  /* THE invariant the generator depends on. If a length bucket ever interleaved first
   * letters, a binary search for "words of length L starting with X" would return a range
   * containing other letters — undetectably, because every index in it still yields a real
   * word. Asserted on the real emulation too, so this fails if the platform changes. */
  it("keeps same-first-letter words contiguous within each length bucket", () => {
    for (const pool of [solo, kb] as WordPool[]) {
      for (const len of LENGTHS) {
        const n = pool.countOfLength(len);
        const seen = new Set<string>();
        let prev = "";
        for (let i = 0; i < n; i++) {
          const first = pool.pickOfLength(len, i)![0];
          if (first !== prev) {
            expect(seen.has(first), `length ${len} revisits "${first}" at ${i}`).toBe(false);
            seen.add(first);
            prev = first;
          }
        }
      }
    }
  });

  it("sorts ascending within a length bucket", () => {
    for (const len of LENGTHS) {
      const words: string[] = [];
      for (let i = 0; i < solo.countOfLength(len); i++) {
        words.push(solo.pickOfLength(len, i)!);
      }
      expect(words).toEqual([...words].sort());
    }
  });

  it("orders the global index by length bucket ascending", () => {
    const lengths: number[] = [];
    for (let i = 0; i < solo.count(); i++) lengths.push(solo.pick(i)!.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it("drops non-ASCII entries on both adapters", () => {
    const withUnicode = [...FIXTURE, "café", "naïve"];
    const a = dictionaryWordPool(new Dictionary(withUnicode));
    const b = kbWordPool(buildLocalWords!({ en: withUnicode }), "en");
    expect(a.count()).toBe(19);
    expect(a.count()).toBe(b.count());
  });
});

describe("dictionaryWordPool — laziness", () => {
  it("does not bucket the lexicon until an index query arrives", () => {
    let enumerated = 0;
    const pool = dictionaryWordPool({
      has: () => true,
      words: () => {
        enumerated++;
        return FIXTURE;
      },
    });
    // `has` must not trigger the build — a Classic match only ever calls this one.
    expect(pool.has("cat")).toBe(true);
    expect(enumerated).toBe(0);

    pool.countOfLength(3);
    expect(enumerated).toBe(1);
    // Memoized: further queries reuse the buckets.
    pool.pickOfLength(3, 0);
    pool.count();
    pool.pick(0);
    expect(enumerated).toBe(1);
  });
});
