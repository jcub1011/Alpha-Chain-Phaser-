/*
 * Per-card unit coverage: every card's scoring fold exercised across word shapes,
 * asserting BOTH the triggered and the skipped branch (plus threshold boundaries).
 * Pure folds go through scoreWord; the FX/hook-only cards are checked for an inert
 * "FX" step here (their real behaviour lives in interactions.test / reactive.test).
 */

import { describe, expect, it } from "vitest";
import { bayHidesInput, makeBayEvaluator, scoreWord, type ScoreOptions } from "../scoring";
import type { BayCard, Submission } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };
const score = (word: string, ids: string[], over: Partial<ScoreOptions> = {}): number =>
  scoreWord(word, bay(...ids), { ...opts, ...over }).finalScore;
/** Minimal history rows (only `.word` is read by Scavenger). */
const hist = (...words: string[]): Submission[] =>
  words.map((word) => ({ word }) as unknown as Submission);

// ── §3.1 Core additives ──────────────────────────────────────────────────────

describe("The Anchor — flat +10", () => {
  it("always adds 10", () => {
    expect(score("cat", ["TheAnchor"])).toBe(13); // 3 + 10
  });
});

describe("Vanilla — +1/ltr, +2/ltr at 7+", () => {
  it("pays +1/letter below 7 (boundary: exactly 6)", () => {
    expect(score("monkey", ["Vanilla"])).toBe(12); // 6 + 6×1
  });
  it("pays +2/letter at exactly 7", () => {
    expect(score("monster", ["Vanilla"])).toBe(21); // 7 + 7×2
  });
});

describe("Consonant Crunch — +2/con, +3/con at 7+", () => {
  it("pays +2/consonant below 7 letters", () => {
    expect(score("cat", ["ConsonantCrunch"])).toBe(7); // 3 + 2 consonants ×2
  });
  it("pays +3/consonant at 7+ letters", () => {
    expect(score("monster", ["ConsonantCrunch"])).toBe(22); // 7 + 5 consonants ×3
  });
});

describe("Vocal Vowels — +3/vowel, +4/vowel at 7+", () => {
  it("pays +3/vowel below 7 letters", () => {
    expect(score("cat", ["VocalVowels"])).toBe(6); // 3 + 1 vowel ×3
  });
  it("pays +4/vowel at 7+ letters", () => {
    expect(score("elephant", ["VocalVowels"])).toBe(20); // 8 + 3 vowels ×4
  });
});

describe("Brick Layer — +3/ltr only when 6+", () => {
  it("skips below 6 letters", () => {
    const r = scoreWord("cat", bay("BrickLayer"), opts);
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].triggered).toBe(false);
    expect(r.steps[0].valueText).toBe("—");
  });
  it("pays +3/letter at exactly 6", () => {
    expect(score("monkey", ["BrickLayer"])).toBe(24); // 6 + 6×3
  });
});

describe("The Blueprint — +3/ltr when word ≥ previous word length", () => {
  it("always pays on the first word (prevWordLength 0)", () => {
    expect(score("cat", ["TheBlueprint"], { prevWordLength: 0 })).toBe(12); // 3 + 3×3
  });
  it("pays when at least as long as the previous word", () => {
    expect(score("cat", ["TheBlueprint"], { prevWordLength: 3 })).toBe(12);
  });
  it("skips when shorter than the previous word", () => {
    const r = scoreWord("cat", bay("TheBlueprint"), { ...opts, prevWordLength: 5 });
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].triggered).toBe(false);
  });
});

describe("Letter Hoarder — +2/distinct letter", () => {
  it("counts distinct letters, not total", () => {
    // "tatter" → {t,a,e,r} = 4 distinct. seed 6 + 4×2.
    expect(score("tatter", ["LetterHoarder"])).toBe(14);
  });
});

describe("High Roller — +10 per rare letter (Q, X, Z, J)", () => {
  it("pays +10 per rare letter", () => {
    expect(score("zebra", ["HighRoller"])).toBe(15); // 5 + 10 (one Z)
  });
  it("pays +10 per rare letter for multiple rare letters", () => {
    expect(score("quiz", ["HighRoller"])).toBe(24); // 4 + 20 (Q + Z)
  });
  it("skips when no rare letters", () => {
    const r = scoreWord("cat", bay("HighRoller"), opts);
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].triggered).toBe(false);
  });
});

describe("Booster Pack — +3 per card to its right", () => {
  it("adds 3 for each card placed after it", () => {
    expect(score("cat", ["BoosterPack", "TheAnchor"])).toBe(16); // 3 +3(right) +10
  });
  it("adds nothing when it is the rightmost card", () => {
    const r = scoreWord("cat", bay("TheAnchor", "BoosterPack"), opts);
    expect(r.finalScore).toBe(13); // +10 only; Booster has 0 to its right
    expect(r.steps[1].triggered).toBe(false);
  });
});

describe("Scavenger — +2 per prior word containing the start letter", () => {
  it("counts history words that include the start letter", () => {
    // start 't'; "cat" and "art" contain t, "dog" does not → 2 words × +2.
    expect(score("tap", ["Scavenger"], { history: hist("cat", "art", "dog") })).toBe(7);
  });
  it("skips with no qualifying history", () => {
    const r = scoreWord("tap", bay("Scavenger"), { ...opts, history: hist("dog") });
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].triggered).toBe(false);
  });
});

// ── §3.2 Core multipliers ────────────────────────────────────────────────────

describe("Vowel Surge — ×3 when vowels > consonants", () => {
  it("triggers when vowels outnumber consonants", () => {
    expect(score("oui", ["VowelSurge"])).toBe(9); // 3 vowels > 0 consonants → ×3
  });
  it("skips when consonants tie or win", () => {
    const r = scoreWord("cat", bay("VowelSurge"), opts); // 1 vowel, 2 consonants
    expect(r.steps[0].triggered).toBe(false);
  });
});

describe("The Architect — ×3 at 8+ letters", () => {
  it("skips at 7 letters", () => {
    expect(scoreWord("monster", bay("TheArchitect"), opts).steps[0].triggered).toBe(false);
  });
  it("triggers at exactly 8", () => {
    expect(score("elephant", ["TheArchitect"])).toBe(24); // 8 × 3
  });
});

describe("Sesquipedalian — ×5 at 10+ letters", () => {
  it("skips at 9 letters", () => {
    expect(scoreWord("wonderful", bay("Sesquipedalian"), opts).steps[0].triggered).toBe(false);
  });
  it("triggers at exactly 10", () => {
    expect(score("basketball", ["Sesquipedalian"])).toBe(50); // 10 × 5
  });
});

describe("Guttural Roar — ×1.5 when the only vowels are A or E", () => {
  it("triggers when every vowel is a/e", () => {
    expect(score("cat", ["GutturalRoar"])).toBe(5); // 3 × 1.5 = 4.5 → 5
  });
  it("triggers vacuously on a word with no vowels", () => {
    expect(score("rhythm", ["GutturalRoar"])).toBe(9); // 6 × 1.5
  });
  it("skips when an i/o/u vowel is present", () => {
    const r = scoreWord("cot", bay("GutturalRoar"), opts);
    expect(r.steps[0].triggered).toBe(false);
  });
});

describe("Perfect Link — ×1.5 when the word ends in a vowel", () => {
  it("triggers on a trailing vowel", () => {
    expect(score("tea", ["PerfectLink"])).toBe(5); // 3 × 1.5 = 4.5 → 5
  });
  it("skips on a trailing consonant", () => {
    expect(scoreWord("cat", bay("PerfectLink"), opts).steps[0].triggered).toBe(false);
  });
});

describe("Try Hard — ×1.1 at 7, +0.1/letter beyond", () => {
  it("skips at 6 letters or fewer", () => {
    expect(scoreWord("cat", bay("TryHard"), opts).steps[0].triggered).toBe(false);
  });
  it("×1.1 at exactly 7 letters", () => {
    expect(score("monster", ["TryHard"])).toBe(8); // 7 × 1.1 = 7.7 → 8
  });
  it("×1.2 at 8 letters", () => {
    expect(score("elephant", ["TryHard"])).toBe(10); // 8 × 1.2 = 9.6 → 10
  });
});

describe("The Double Down — ×2 with a repeat letter, else ×0.5", () => {
  it("doubles when a letter repeats", () => {
    expect(score("tatter", ["DoubleDown"])).toBe(12); // 6 × 2
  });
  it("halves when every letter is unique", () => {
    expect(score("cat", ["DoubleDown"])).toBe(2); // 3 × 0.5 = 1.5 → 2
  });
});

// ── §3.3 Glass cannon / clock multipliers (scoring side) ─────────────────────

describe("The Vault / Redline — flat multipliers", () => {
  it("Vault is always ×1.5", () => {
    expect(score("cat", ["TheVault"])).toBe(5); // 3 × 1.5 → 4.5 → 5
  });
  it("Redline is always ×2", () => {
    expect(score("cat", ["Redline"])).toBe(6); // 3 × 2
  });
});

describe("The Roulette Wheel — ×1.75 on a clean word", () => {
  it("rewards a clean word", () => {
    expect(score("cat", ["RouletteWheel"])).toBe(5); // 3 × 1.75 = 5.25 → 5
  });
});

describe("The Blindfold — ×1.8 and hides the input", () => {
  it("always multiplies by 1.8", () => {
    expect(score("cat", ["Blindfold"])).toBe(5); // 3 × 1.8 = 5.4 → 5
  });
  it("reports that it hides the owner's input", () => {
    expect(bayHidesInput(makeBayEvaluator("cat", bay("Blindfold"), opts))).toBe(true);
  });
  it("a bay without it does not hide the input", () => {
    expect(bayHidesInput(makeBayEvaluator("cat", bay("TheAnchor"), opts))).toBe(false);
  });
});

describe("The Titanium Mirror — passive ×1.0 with no shield state", () => {
  it("leaves the score unchanged when no shield service is present", () => {
    const r = scoreWord("cat", bay("TitaniumMirror"), opts);
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].valueText).toBe("×1");
  });
});

// ── Rebalance additions: pure scoring cards ──────────────────────────────────

describe("The Lexicon — ×2 at 9+ letters", () => {
  it("skips below 9 letters", () => {
    expect(scoreWord("elephant", bay("TheLexicon"), opts).steps[0].triggered).toBe(false);
  });
  it("doubles at 9+", () => {
    expect(score("wonderful", ["TheLexicon"])).toBe(18); // 9 × 2
  });
});

describe("Stonemason — +4/ltr at 8+", () => {
  it("skips below 8 letters", () => {
    expect(scoreWord("monster", bay("Stonemason"), opts).steps[0].triggered).toBe(false);
  });
  it("pays +4/letter at 8+", () => {
    expect(score("elephant", ["Stonemason"])).toBe(40); // 8 + 8×4
  });
});

describe("Numismatist — +6 per rare letter, +2 per distinct", () => {
  it("rewards rare letters and variety", () => {
    // "quiz": 2 rare (q,z), 4 distinct → 6×2 + 2×4 = 20. seed 4 + 20.
    expect(score("quiz", ["Numismatist"])).toBe(24);
  });
});

describe("The Flywheel — ×1.15 per other multiplier (cap ×2.3)", () => {
  it("skips with no other multiplier card in the bay", () => {
    expect(scoreWord("cat", bay("TheFlywheel"), opts).steps[0].triggered).toBe(false);
  });
  it("scales by the count of other multiplier cards", () => {
    // [Vault ×1.5][Redline ×2][Flywheel]: 2 other multipliers → ×1.3.
    // 3 ×1.5 = 4.5 ×2 = 9 ×1.3 = 11.7 → 12.
    expect(score("cat", ["TheVault", "Redline", "TheFlywheel"])).toBe(12);
  });
});

// ── FX / hook-only cards: an inert "FX" step that never moves the score ───────

describe("FX cards fold inert (behaviour lives in the lifecycle hooks)", () => {
  const FX_CARDS = [
    "SlowBurn",
    "HeatSink",
    "Catalyst",
    "Forgery",
    "MagnifyingGlass",
    "Wildcard",
    "Prism",
    "IrsAgent",
    "TaxWriteOff",
    "TollBooth",
    "TaxCollector",
    "ChronoSyphon",
    "FlakCannon",
    "BountyHunter",
    "BaitAndSwitch",
    "LoanShark",
    "TheSniper",
    "TheLeech",
    "Insurance",
  ];
  for (const id of FX_CARDS) {
    it(`${id} emits an FX step and leaves the value unchanged`, () => {
      const r = scoreWord("cat", bay(id), opts);
      expect(r.finalScore).toBe(3); // seed only
      expect(r.steps[0].triggered).toBe(true);
      expect(r.steps[0].valueText).toBe("FX");
    });
  }
});
