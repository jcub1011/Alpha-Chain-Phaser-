/*
 * Card-aware bot helpers: chooseBotWordScored picks the highest-scoring legal word
 * through the bot's own bay, and planBotBay orders (additives left, multipliers
 * right) + trims a bay to capacity. Both are pure (RNG injected) — these tests use
 * a fixed rng so the picks are deterministic.
 */

import { describe, expect, it } from "vitest";
import { chooseBotWordFromRack, chooseBotWordScored, planBotBay, type BotScoredPick } from "./bots";
import { Dictionary } from "./dictionary";
import type { BayCard, Tile } from "./types";
import { GameMode } from "./types";
import { buildPoolIndex } from "./picker/offer";
import { dictionaryWordPool } from "./picker/wordPool";

const scoreOpts = {
  mode: GameMode.Classic,
  prevWordLength: 0,
  clockRemaining: 10,
  clockTotal: 20,
  baseClockSeconds: 20,
  era: 1,
  history: [],
};

const basePick = (over: Partial<BotScoredPick>): BotScoredPick => ({
  requiredLetter: "",
  usedWords: new Set<string>(),
  bannedLetter: "",
  difficulty: "hard",
  rng: () => 0.5,
  bay: [],
  scoreOpts,
  candidateCount: 20,
  ...over,
});

describe("chooseBotWordScored", () => {
  it("prefers the higher-scoring word given a length-rewarding bay", () => {
    // Both words start with 't'; Stonemason (+4/letter at 8+) rewards the longer one.
    const dict = new Dictionary(["tap", "tarantula"]);
    const word = chooseBotWordScored(dict, {
      ...basePick({ requiredLetter: "t", bay: [{ id: "Stonemason" }] }),
    } as BotScoredPick);
    expect(word).toBe("tarantula");
  });

  it("returns a legal word that respects the required start letter", () => {
    const dict = new Dictionary(["apple", "tap", "tiger"]);
    const word = chooseBotWordScored(dict, basePick({ requiredLetter: "t" }));
    expect(word).not.toBeNull();
    expect(word![0]).toBe("t");
  });

  it("falls back to the naive picker for easy bots (candidateCount 0)", () => {
    const dict = new Dictionary(["tap", "tiger"]);
    const word = chooseBotWordScored(
      dict,
      basePick({ difficulty: "easy", candidateCount: 0, requiredLetter: "t" }),
    );
    expect(word).not.toBeNull();
    expect(word![0]).toBe("t");
  });

  it("avoids the banned letter when a clean candidate exists", () => {
    // 'z' is banned; "tap" is clean, "zap"/"tzar" carry the banned letter.
    const dict = new Dictionary(["tap", "tang", "tzar"]);
    const word = chooseBotWordScored(dict, basePick({ requiredLetter: "t", bannedLetter: "z" }));
    expect(word).not.toBeNull();
    expect(word!.includes("z")).toBe(false);
  });
});

describe("planBotBay", () => {
  const withUids = (...ids: string[]): BayCard[] => ids.map((id, i) => ({ id, uid: `u${i}` }));

  it("orders additives left and multipliers right", () => {
    // Input is deliberately multiplier-first; planning should move it right.
    const bay = withUids("Redline", "TheAnchor"); // [mult, additive]
    const { engine, discard } = planBotBay(bay, 2, scoreOpts);
    expect(discard).toEqual([]);
    expect(engine).toEqual(["u1", "u0"]); // TheAnchor (additive) then Redline (mult)
  });

  it("discards down to capacity, dropping the weakest contributor", () => {
    // Three cards, 2 slots. TheAnchor (+10) and Redline (×2) matter most on the
    // probe word; the conditional Architect (×3 only at 8+, probe is 7) adds nothing.
    const bay = withUids("TheAnchor", "TheArchitect", "Redline");
    const { engine, discard } = planBotBay(bay, 2, scoreOpts);
    expect(engine).toHaveLength(2);
    expect(discard).toHaveLength(1);
    // The inert Architect is the one dropped.
    expect(discard).toEqual(["u1"]);
  });
});

describe("chooseBotWordFromRack", () => {
  const dict = new Dictionary(["action", "act", "cat", "traction", "tract", "ion"]);
  const pool = dictionaryWordPool(dict);
  const index = buildPoolIndex(pool);

  const testRack: Tile[] = [
    { id: "t0", text: "t", isChunk: false },
    { id: "t1", text: "r", isChunk: false },
    { id: "t2", text: "a", isChunk: false },
    { id: "t3", text: "c", isChunk: false },
    { id: "t4", text: "tion", isChunk: true },
  ];

  it("selects buildable sub-words respecting the required letter", () => {
    const word = chooseBotWordFromRack(testRack, pool, index, {
      ...basePick({ requiredLetter: "t" }),
    });
    expect(word).toBe("traction");
  });

  it("scores candidates through the bot's bay in Word Builder mode", () => {
    const word = chooseBotWordFromRack(testRack, pool, index, {
      ...basePick({
        requiredLetter: "t",
        bay: [{ id: "Stonemason" }], // rewards 8+ letters: "traction" is 8 letters!
      }),
    });
    expect(word).toBe("traction");
  });

  it("easy bots pick valid sub-words", () => {
    const word = chooseBotWordFromRack(testRack, pool, index, {
      ...basePick({ difficulty: "easy", requiredLetter: "t" }),
    });
    expect(["tract", "traction"]).toContain(word);
  });

  // "action" = a + c + tion and "act" = a + c + t, so this letter has two buildable words to choose
  // between — unlike "t", where only "traction" is buildable ("tract" would need a second t).
  it("never picks a word that has already been played", () => {
    const word = chooseBotWordFromRack(testRack, pool, index, {
      ...basePick({ requiredLetter: "a", usedWords: new Set(["action"]) }),
    });
    expect(word).toBe("act");
  });

  it("stands down instead of repeating a word when everything buildable is used", () => {
    /* Falling back to the used set made the bot commit a word submitWord rejects as already-used,
     * which spends its one action, runs the clock out into a dead turn, and in Survival eliminates
     * it — with a rejection flash on the way past. Returning null reaches the same resolved turn
     * quietly, which is what the engine's own no-show auto-pick already does. */
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const word = chooseBotWordFromRack(testRack, pool, index, {
        ...basePick({
          difficulty,
          requiredLetter: "a",
          usedWords: new Set(["action", "act"]),
        }),
      });
      expect(word).toBeNull();
    }
  });
});
