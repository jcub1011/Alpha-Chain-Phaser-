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
  findTileDecomposition,
  generateRack,
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
      const diversity = verifyRackDiversity(result.tiles, pool, index, letter);
      expect(diversity.words.length).toBeGreaterThanOrEqual(3);
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
