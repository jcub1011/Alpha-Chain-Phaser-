import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Dictionary } from "../dictionary";
import { buildPoolIndex } from "../picker/offer";
import { dictionaryWordPool } from "../picker/wordPool";
import {
  canConstructWordFromTiles,
  decomposeSeed,
  DEFAULT_RACK_SIZE,
  effectiveRackSize,
  findTileDecomposition,
  generateRack,
  MAX_RACK_SIZE,
  MIN_RACK_SIZE,
  scoreSeedFertility,
  subWordFinder,
  verifyRackDiversity,
  type Tile,
} from "./rack";

const WORDS = readFileSync(
  path.resolve(__dirname, "../../../public/assets/words-common.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

const dict = new Dictionary(WORDS);
const pool = dictionaryWordPool(dict);
const index = buildPoolIndex(pool);

function makeRng(seed = 12345): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Word Builder — Core Generator & Profiler", () => {
  it("decomposes seed words into single letters, root chunks, and standard morpheme suffixes", () => {
    const dec1 = decomposeSeed("creative");
    expect(dec1.map((t) => t.text).join("")).toBe("creative");
    // "creative" extracts "ive" and "ea" chunks
    expect(dec1.some((t) => t.text === "ive" && t.isChunk)).toBe(true);

    const dec2 = decomposeSeed("testing");
    expect(dec2.map((t) => t.text).join("")).toBe("testing");
    expect(dec2.some((t) => t.text === "ing" && t.isChunk)).toBe(true);

    const dec3 = decomposeSeed("standing");
    expect(dec3.map((t) => t.text).join("")).toBe("standing");
    expect(dec3.some((t) => t.text === "ing" && t.isChunk)).toBe(true);
    expect(dec3.some((t) => t.text === "and" && t.isChunk)).toBe(true);

    const dec4 = decomposeSeed("wonderful");
    expect(dec4.map((t) => t.text).join("")).toBe("wonderful");
    expect(dec4.some((t) => t.text === "ful" && t.isChunk)).toBe(true);
  });

  it("shuffles tiles so they do not spell the seed word in left-to-right order", () => {
    const rng = makeRng(1234);
    const result = generateRack({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(),
      rng,
    });

    // The raw concatenated tile texts should NOT equal the sequential spelling of the seed word
    const leftToRightText = result.tiles.map((t) => t.text).join("");
    expect(leftToRightText.startsWith(result.seedWord)).toBe(false);
  });

  it("accurately tests whether a word can be constructed from tile partitions", () => {
    const tiles: Tile[] = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "r", isChunk: false },
      { id: "t2", text: "e", isChunk: false },
      { id: "t3", text: "a", isChunk: false },
      { id: "t4", text: "t", isChunk: false },
      { id: "t5", text: "i", isChunk: false },
      { id: "t6", text: "v", isChunk: false },
      { id: "t7", text: "e", isChunk: false },
      { id: "t8", text: "ed", isChunk: true },
      { id: "t9", text: "s", isChunk: false },
    ];

    expect(canConstructWordFromTiles("create", tiles)).toBe(true);
    expect(canConstructWordFromTiles("created", tiles)).toBe(true);
    expect(canConstructWordFromTiles("creates", tiles)).toBe(true);
    expect(canConstructWordFromTiles("creative", tiles)).toBe(true);
    expect(canConstructWordFromTiles("cat", tiles)).toBe(true);
    expect(canConstructWordFromTiles("rate", tiles)).toBe(true);

    // Unconstructible words (missing letters / affixes)
    expect(canConstructWordFromTiles("dog", tiles)).toBe(false);
    expect(canConstructWordFromTiles("creativity", tiles)).toBe(false);
    expect(canConstructWordFromTiles("creativeness", tiles)).toBe(false);
  });

  it("finds exact tile decomposition handles for valid words", () => {
    const tiles: Tile[] = [
      { id: "t0", text: "p", isChunk: false },
      { id: "t1", text: "l", isChunk: false },
      { id: "t2", text: "a", isChunk: false },
      { id: "t3", text: "y", isChunk: false },
      { id: "t4", text: "ing", isChunk: true },
      { id: "t5", text: "er", isChunk: true },
    ];

    const matchPlay = findTileDecomposition("play", tiles);
    expect(matchPlay).not.toBeNull();
    expect(matchPlay!.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3"]);

    const matchPlaying = findTileDecomposition("playing", tiles);
    expect(matchPlaying).not.toBeNull();
    expect(matchPlaying!.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);

    const matchPlayer = findTileDecomposition("player", tiles);
    expect(matchPlayer).not.toBeNull();
    expect(matchPlayer!.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3", "t5"]);

    const matchInvalid = findTileDecomposition("plays", tiles);
    expect(matchInvalid).toBeNull();
  });

  it("subWordFinder finds all buildable dictionary words rapidly", () => {
    const tiles: Tile[] = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "a", isChunk: false },
      { id: "t2", text: "t", isChunk: false },
      { id: "t3", text: "s", isChunk: false },
      { id: "t4", text: "e", isChunk: false },
      { id: "t5", text: "r", isChunk: false },
      { id: "t6", text: "ing", isChunk: true },
      { id: "t7", text: "ed", isChunk: true },
      { id: "t8", text: "o", isChunk: false },
    ];

    const subWords = subWordFinder(tiles, pool, index, "c");
    expect(subWords.length).toBeGreaterThan(0);
    expect(subWords).toContain("cat");
    expect(subWords).toContain("cats");
    expect(subWords).toContain("catering");

    // All returned words must start with 'c'
    for (const w of subWords) {
      expect(w.startsWith("c")).toBe(true);
      expect(dict.has(w)).toBe(true);
    }
  });

  it("scores seed fertility preferring diverse, high-utility letters", () => {
    const high = scoreSeedFertility("creative", new Set());
    const low = scoreSeedFertility("jazzily", new Set());
    expect(high).toBeGreaterThan(low);

    const taxed = scoreSeedFertility("creative", new Set(["e"]));
    expect(taxed).toBeLessThan(high);
  });

  it("generates 100% solvable racks across all 26 starting letters (500 draws)", () => {
    const rng = makeRng(42);
    const startLetters = index.startLetters();

    for (let i = 0; i < 500; i++) {
      const letter = startLetters[i % startLetters.length];
      const result = generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        rng,
      });

      if (!result.seedWord) {
        console.error(`Failed on draw ${i}, letter "${letter}":`, result);
      }

      expect(result.tiles.length).toBeGreaterThanOrEqual(DEFAULT_RACK_SIZE - 1);
      expect(result.seedWord.length).toBeGreaterThanOrEqual(2);
      expect(result.seedWord.startsWith(letter)).toBe(true);

      // Verify the seed word is constructible from the generated rack
      const canBuildSeed = canConstructWordFromTiles(result.seedWord, result.tiles);
      expect(canBuildSeed, `Seed word ${result.seedWord} must be buildable from rack`).toBe(true);

      // Verify at least one sub-word is discovered
      expect(result.subWordCount).toBeGreaterThan(0);
    }
  });

  it("satisfies the Diversity Contract on high-fertility letters", () => {
    const rng = makeRng(999);
    const commonLetters = ["c", "p", "s", "t", "m", "b", "r", "d", "f"];

    let passedCount = 0;
    for (const letter of commonLetters) {
      const result = generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        rng,
      });

      if (result.diversityPassed) {
        passedCount++;
      }
      // `exhaustive` because this assertion is about the census, not about the bounded verdict:
      // the fast path deliberately stops as soon as the contract is settled.
      const census = verifyRackDiversity(result.tiles, pool, index, letter, new Set(), {
        exhaustive: true,
      });
      expect(census.words.length).toBeGreaterThanOrEqual(3);
      const bounded = verifyRackDiversity(result.tiles, pool, index, letter);
      expect(bounded.valid).toBe(census.valid);
    }

    // Almost all common-letter racks pass full diversity
    expect(passedCount).toBeGreaterThanOrEqual(commonLetters.length - 1);
  });

  it("supports Preference Card shaping (The Sieve, The Tide, The Prospector, The Sentinel, The Wide Net)", () => {
    const rng = makeRng(777);

    // The Sieve (8+ seed length)
    const sieveRes = generateRack({
      pool,
      index,
      requiredLetter: "c",
      usedWords: new Set(),
      shaping: { minSeedLength: 8 },
      rng,
    });
    expect(sieveRes.seedWord.length).toBeGreaterThanOrEqual(8);

    // The Wide Net (+2 rack tiles)
    const wideRes = generateRack({
      pool,
      index,
      requiredLetter: "t",
      usedWords: new Set(),
      shaping: { slotDelta: 2 },
      rng,
    });
    expect(wideRes.tiles.length).toBe(DEFAULT_RACK_SIZE + 2);

    // Tunnel Vision (-2 rack tiles)
    const tunnelRes = generateRack({
      pool,
      index,
      requiredLetter: "t",
      usedWords: new Set(),
      shaping: { slotDelta: -2 },
      rng,
    });
    expect(tunnelRes.tiles.length).toBe(DEFAULT_RACK_SIZE - 2);

    // The Prospector (guaranteed rare letter)
    const prospectorRes = generateRack({
      pool,
      index,
      requiredLetter: "a",
      usedWords: new Set(),
      shaping: { guaranteeRare: true },
      rng,
    });
    expect(
      prospectorRes.tiles.some((t) => ["q", "x", "z", "j"].some((r) => t.text.includes(r))),
    ).toBe(true);

    // The Sentinel (no banned letters)
    const sentinelRes = generateRack({
      pool,
      index,
      requiredLetter: "b",
      usedWords: new Set(),
      bannedLetters: ["e", "s"],
      shaping: { excludeBannedLetters: true },
      rng,
    });
    expect(
      sentinelRes.tiles.some((t) => t.text.includes("e") || t.text.includes("s")),
    ).toBe(false);
  });

  it("ensures deterministic generation with identical RNG streams", () => {
    const draw1 = generateRack({
      pool,
      index,
      requiredLetter: "m",
      usedWords: new Set(["make"]),
      rng: makeRng(5555),
    });

    const draw2 = generateRack({
      pool,
      index,
      requiredLetter: "m",
      usedWords: new Set(["make"]),
      rng: makeRng(5555),
    });

    expect(draw1.seedWord).toBe(draw2.seedWord);
    expect(draw1.tiles).toEqual(draw2.tiles);
    expect(draw1.subWordCount).toBe(draw2.subWordCount);
  });

  it("passes performance constraint: average generation time < 1.5ms", () => {
    const rng = makeRng(101);
    const startLetters = index.startLetters();
    const iterations = 1000;

    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const letter = startLetters[i % startLetters.length];
      generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        rng,
      });
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / iterations;

    expect(avgMs).toBeLessThan(1.5);
  });
});

describe("Diversity Contract — bounded verification", () => {
  /* The contract needs a handful of words but used to enumerate the whole starting-letter bucket,
   * up to 12 times per rack draw. These pin the two properties that make bounding it safe: the
   * bounded path agrees with the unbounded one, and the budget it is bounded by cannot be reached on
   * the shipped Reduced list — which is what keeps every shared-rng test in this file stable. */

  const draws = (count: number, seed: number, rackSize?: number) => {
    const rng = makeRng(seed);
    const letters = index.startLetters();
    const out: { tiles: Tile[]; letter: string; seedWord: string }[] = [];
    for (let i = 0; i < count; i++) {
      const letter = letters[i % letters.length];
      const r = generateRack({ pool, index, requiredLetter: letter, usedWords: new Set(), rackSize, rng });
      out.push({ tiles: r.tiles, letter, seedWord: r.seedWord });
    }
    return out;
  };

  it("agrees with the exhaustive oracle on every draw", () => {
    for (const { tiles, letter, seedWord } of draws(200, 2024)) {
      const oracle = verifyRackDiversity(tiles, pool, index, letter, new Set(), { exhaustive: true });
      const fast = verifyRackDiversity(tiles, pool, index, letter, new Set(), { seedWord });

      expect(fast.valid).toBe(oracle.valid);
      expect(fast.progress).toBe(oracle.progress);
      expect(fast.words.length).toBeLessThanOrEqual(oracle.words.length);
      // A capped sample may be smaller, but it must never be empty where a census found words.
      expect(fast.words.length > 0).toBe(oracle.words.length > 0);
      for (const w of fast.words) expect(dict.has(w)).toBe(true);
    }
  });

  it("never exhausts its budget on the Reduced pool", () => {
    for (const { tiles, letter, seedWord } of draws(300, 8181)) {
      const d = verifyRackDiversity(tiles, pool, index, letter, new Set(), { seedWord });
      expect(d.budgetExhausted).toBe(false);
    }
  });

  it("settles a fertile rack in far fewer examinations than a census", () => {
    // Deterministic stand-in for a timing assertion: counts pool candidates looked at, not ms.
    const tiles: Tile[] = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "a", isChunk: false },
      { id: "t2", text: "t", isChunk: false },
      { id: "t3", text: "s", isChunk: false },
      { id: "t4", text: "e", isChunk: false },
      { id: "t5", text: "r", isChunk: false },
      { id: "t6", text: "ing", isChunk: true },
      { id: "t7", text: "o", isChunk: false },
      { id: "t8", text: "l", isChunk: false },
    ];
    const fast = verifyRackDiversity(tiles, pool, index, "c");
    const oracle = verifyRackDiversity(tiles, pool, index, "c", new Set(), { exhaustive: true });

    expect(fast.valid).toBe(true);
    expect(fast.examined).toBeLessThan(oracle.examined / 2);
  });

  it("still finds a long word that sorts late in its length bucket", () => {
    // The ascending-length trap: a shared maxResults cap would return only short words and report
    // the long clause as unmet. Located with the oracle so the case is real rather than assumed.
    let checked = 0;
    for (const { tiles, letter, seedWord } of draws(150, 616)) {
      const oracle = verifyRackDiversity(tiles, pool, index, letter, new Set(), { exhaustive: true });
      const longWords = oracle.words.filter((w) => w.length >= 7);
      if (longWords.length === 0) continue;

      // Verified WITHOUT the seed priming, so the long probe has to do the finding itself.
      const unprimed = verifyRackDiversity(tiles, pool, index, letter);
      expect(unprimed.progress).toBe(oracle.progress);
      expect(seedWord.length).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("stays bounded and still serves a rack when the contract cannot be met", () => {
    // A 3-tile rack cannot spell a 7-letter word, so all 12 attempts fail on every draw.
    const rng = makeRng(4321);
    const letters = index.startLetters();
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = generateRack({
        pool,
        index,
        requiredLetter: letters[i % letters.length],
        usedWords: new Set(),
        rackSize: 3,
        rng,
      });
      expect(r.tiles.length).toBe(3);
      if (r.seedWord) expect(canConstructWordFromTiles(r.seedWord, r.tiles)).toBe(true);
    }
    expect((performance.now() - t0) / N).toBeLessThan(1.5);
  });
});

describe("Rack size band", () => {
  /* The band is deliberately wider than the lobby stepper's range. When they matched, a Preference
   * Card's tile delta was clamped away at either end while the other half of the card still applied. */

  it("serves the requested tile count across the whole band", () => {
    for (const rackSize of [MIN_RACK_SIZE, 3, 4, 6, 9, 12, 20, MAX_RACK_SIZE]) {
      const rng = makeRng(31337);
      const letters = index.startLetters();
      for (let i = 0; i < 40; i++) {
        const r = generateRack({
          pool,
          index,
          requiredLetter: letters[i % letters.length],
          usedWords: new Set(),
          rackSize,
          rng,
        });
        expect(r.tiles.length).toBe(rackSize);
        // The seed must stay spellable from the finished rack at every size, or the rack is a lie.
        if (r.seedWord) expect(canConstructWordFromTiles(r.seedWord, r.tiles)).toBe(true);
      }
    }
  });

  it("delivers both card deltas in full at the lobby's own extremes", () => {
    const draw = (rackSize: number, slotDelta: number): number =>
      generateRack({
        pool,
        index,
        requiredLetter: "s",
        usedWords: new Set(),
        rackSize,
        shaping: { slotDelta },
        rng: makeRng(11),
      }).tiles.length;

    // Wide Net at what used to be the ceiling, Tunnel Vision at what used to be the floor.
    expect(draw(12, 2)).toBe(14);
    expect(draw(6, -2)).toBe(4);
  });

  it("finds a seed at the smallest rack size instead of falling back to a fixed rack", () => {
    // A 2-tile rack is only seedable by a word that decomposes into a letter plus a chunk, which is
    // why the seed search asks decomposeSeed rather than comparing lengths.
    const rng = makeRng(90210);
    const letters = index.startLetters();
    let seeded = 0;
    for (let i = 0; i < 60; i++) {
      const r = generateRack({
        pool,
        index,
        requiredLetter: letters[i % letters.length],
        usedWords: new Set(),
        rackSize: 2,
        rng,
      });
      expect(r.tiles.length).toBe(2);
      if (r.seedWord) {
        seeded++;
        expect(canConstructWordFromTiles(r.seedWord, r.tiles)).toBe(true);
      }
    }
    expect(seeded).toBeGreaterThan(40);
  });
});

describe("Preference Card guarantees", () => {
  const RARE = ["q", "x", "z", "j"];
  const hasRare = (tiles: readonly Tile[]): boolean =>
    tiles.some((t) => RARE.some((r) => t.text.includes(r)));
  const vowelShareOf = (tiles: readonly Tile[]): number => {
    let v = 0;
    let n = 0;
    for (const t of tiles) {
      for (const ch of t.text) {
        n++;
        if ("aeiou".includes(ch)) v++;
      }
    }
    return v / Math.max(1, n);
  };

  it("delivers Prospector's rare letter at every rack size a card can reach", () => {
    // Includes slotDelta -2, the exact regression: at rackSize 9 under Tunnel Vision a 7-letter
    // chunk-free seed filled the rack, the catalyst loop never ran, and the guarantee vanished.
    for (const slotDelta of [-2, 0, 2]) {
      const rng = makeRng(777);
      const letters = index.startLetters();
      for (let i = 0; i < 60; i++) {
        const r = generateRack({
          pool,
          index,
          requiredLetter: letters[i % letters.length],
          usedWords: new Set(),
          rackSize: 9,
          shaping: { guaranteeRare: true, slotDelta },
          rng,
        });
        expect(hasRare(r.tiles)).toBe(true);
        expect(r.unmetGuarantees).toEqual([]);
      }
    }
  });

  it("delivers Prospector and Tide together", () => {
    const rng = makeRng(2468);
    const letters = index.startLetters();
    let vowelHeavy = 0;
    const N = 120;
    for (let i = 0; i < N; i++) {
      const r = generateRack({
        pool,
        index,
        requiredLetter: letters[i % letters.length],
        usedWords: new Set(),
        rackSize: 9,
        shaping: { guaranteeRare: true, highVowelRatio: true },
        rng,
      });
      expect(hasRare(r.tiles)).toBe(true); // the rare branch is checked first and must still land
      if (vowelShareOf(r.tiles) >= 0.5) vowelHeavy++;
    }
    // Tide is a floor the seed has to carry, not a hard guarantee: reaching 50% by injection alone
    // needs up to four free slots, which conflicts with Sieve. Best-effort, and it should land.
    expect(vowelHeavy).toBeGreaterThan(N * 0.85);
  });

  it("keeps the seed buildable while repairing guarantees", () => {
    const rng = makeRng(13579);
    const letters = index.startLetters();
    for (let i = 0; i < 250; i++) {
      const r = generateRack({
        pool,
        index,
        requiredLetter: letters[i % letters.length],
        usedWords: new Set(),
        rackSize: 9,
        shaping: { guaranteeRare: true, highVowelRatio: true, slotDelta: -2 },
        rng,
      });
      expect(r.tiles.length).toBe(7);
      if (r.seedWord) expect(canConstructWordFromTiles(r.seedWord, r.tiles)).toBe(true);
    }
  });

  it("lets Sentinel outrank Prospector when the rares are banned", () => {
    const partial = generateRack({
      pool,
      index,
      requiredLetter: "b",
      usedWords: new Set(),
      bannedLetters: ["z", "q", "x"],
      shaping: { guaranteeRare: true, excludeBannedLetters: true },
      rng: makeRng(31),
    });
    for (const t of partial.tiles) {
      for (const ch of ["z", "q", "x"]) expect(t.text.includes(ch)).toBe(false);
    }

    const all = generateRack({
      pool,
      index,
      requiredLetter: "b",
      usedWords: new Set(),
      bannedLetters: ["z", "q", "x", "j"],
      shaping: { guaranteeRare: true, excludeBannedLetters: true },
      rng: makeRng(31),
    });
    // No rare at all rather than a banned one, and it says so instead of pretending.
    expect(all.tiles.some((t) => RARE.some((r) => t.text.includes(r)))).toBe(false);
    expect(all.unmetGuarantees).toContain("rare");
  });

  it("holds Sentinel against a heavily banned alphabet", () => {
    // Empties the ban-filtered vowel, chunk and consonant lists in turn, which is where the old
    // `?? "z"` / `?? "e"` / `?? "s"` fallbacks used to inject the very letters being avoided.
    const banned = ["a", "e", "i", "o", "u", "s", "d", "r", "t", "n"];
    const rng = makeRng(5150);
    const letters = index.startLetters();
    for (let i = 0; i < 60; i++) {
      const r = generateRack({
        pool,
        index,
        requiredLetter: letters[i % letters.length],
        usedWords: new Set(),
        bannedLetters: banned,
        shaping: { excludeBannedLetters: true },
        rng,
      });
      for (const t of r.tiles) {
        for (const ch of t.text) {
          if (!banned.includes(ch)) continue;
          // A banned letter may only reach the rack inside a seed the pool could not serve ban-free
          // — a taxed rack beats freeing the succession letter outright. What must never happen is a
          // CATALYST introducing one, which is what the old `?? "e"` / `?? "s"` fallbacks did.
          expect(r.seedWord.includes(ch)).toBe(true);
        }
      }
    }
  });

  it("skips a guarantee the rack is too small to honour, without faking it", () => {
    const r = generateRack({
      pool,
      index,
      requiredLetter: "s",
      usedWords: new Set(),
      rackSize: MIN_RACK_SIZE,
      shaping: { guaranteeRare: true },
      rng: makeRng(6),
    });
    expect(r.tiles.length).toBe(MIN_RACK_SIZE);
    if (!r.tiles.some((t) => ["q", "x", "z", "j"].some((x) => t.text.includes(x)))) {
      expect(r.unmetGuarantees).toContain("rare");
    }
  });
});

describe("Banned letters and seed selection", () => {
  it("does not bias seed selection for a player without Sentinel", () => {
    // The era ban is supposed to hurt. Docking fertility for it unconditionally handed every player
    // most of Sentinel's protection for free, and devalued Sentinel, Prism and the tax collectors.
    for (const letter of ["c", "s", "t", "b", "p"]) {
      const withBan = generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        bannedLetters: ["e"],
        rng: makeRng(24680),
      });
      const withoutBan = generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        rng: makeRng(24680),
      });

      expect(withBan.seedWord).toBe(withoutBan.seedWord);
      expect(withBan.tiles).toEqual(withoutBan.tiles);
    }
  });

  it("keeps Sentinel's guarantee in the exhaustive seed fallback", () => {
    // The hard ban filter can empty the sampled candidate set, which is exactly when the fallback
    // sweep runs — and returning the first unplayed word regardless would break the card.
    const tiny = new Dictionary(["beast", "bells", "berth", "blast", "bosun", "brash", "bloat"]);
    const tinyPool = dictionaryWordPool(tiny);
    const tinyIndex = buildPoolIndex(tinyPool);

    const r = generateRack({
      pool: tinyPool,
      index: tinyIndex,
      requiredLetter: "b",
      usedWords: new Set(),
      bannedLetters: ["e"],
      shaping: { excludeBannedLetters: true },
      rng: makeRng(99),
    });
    expect(r.seedWord).not.toBe("");
    expect(r.seedWord.includes("e")).toBe(false);
  });

  it("still serves a seed when every candidate carries a banned letter", () => {
    // Returning null would make the caller free the succession letter, which is worse for the
    // player than a taxed rack.
    const tiny = new Dictionary(["beast", "bells", "berth", "beset"]);
    const tinyPool = dictionaryWordPool(tiny);
    const tinyIndex = buildPoolIndex(tinyPool);

    const r = generateRack({
      pool: tinyPool,
      index: tinyIndex,
      requiredLetter: "b",
      usedWords: new Set(),
      bannedLetters: ["e"],
      shaping: { excludeBannedLetters: true },
      rng: makeRng(99),
    });
    expect(r.seedWord).not.toBe("");
  });
});

describe("effectiveRackSize", () => {
  it("applies the bay slot delta and clamps to the allowable band", () => {
    expect(effectiveRackSize(9, 0)).toBe(9);
    expect(effectiveRackSize(9, 2)).toBe(11); // Wide Net
    expect(effectiveRackSize(9, -2)).toBe(7); // Tunnel Vision
    // Stacks are delivered in full rather than clamped away. The band is deliberately wider than
    // the lobby's range: when the two matched, a card's tile delta vanished at either end while the
    // other half of the card still applied.
    expect(effectiveRackSize(9, -6)).toBe(3); // three Tunnel Visions stacked
    expect(effectiveRackSize(9, 6)).toBe(15); // three Wide Nets stacked
    // The band still holds at its own edges.
    expect(effectiveRackSize(MIN_RACK_SIZE, -2)).toBe(MIN_RACK_SIZE);
    expect(effectiveRackSize(MAX_RACK_SIZE, 2)).toBe(MAX_RACK_SIZE);
    expect(effectiveRackSize(undefined, undefined)).toBe(DEFAULT_RACK_SIZE);
  });
});
