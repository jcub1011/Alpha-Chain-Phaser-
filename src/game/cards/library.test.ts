/*
 * Per-card unit coverage: every card's scoring fold exercised across word shapes,
 * asserting BOTH the triggered and the skipped branch (plus threshold boundaries).
 * Pure folds go through scoreWord; the FX/hook-only cards are checked for an inert
 * "FX" step here (their real behaviour lives in interactions.test / reactive.test).
 */

import { describe, expect, it } from "vitest";
import { bayHidesInput, makeBayEvaluator, scoreWord, type ScoreOptions } from "../scoring";
import {
  CardRarity,
  GameMode,
  type BayCard,
  type CardRarity as CardRarityT,
  type Submission,
} from "../types";
import {
  CARD_LIBRARY,
  dealableCardIds,
  dealPoolCapacity,
  getCard,
  rarityCardCounts,
  rarityDealShare,
} from "./library";
import { DEFAULT_RARITY_DEAL_WEIGHT } from "../settings";

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

describe("Booster Pack — +2 per card to its right, scaled by slot capacity", () => {
  it("adds 2 × cardsToRight × slots (slots defaults to bay length)", () => {
    // 2-card bay → slots defaults to 2: 3 +2(1 right ×2 slots) +10
    expect(score("cat", ["BoosterPack", "TheAnchor"])).toBe(17);
  });
  it("scales with the player's slot capacity", () => {
    expect(score("cat", ["BoosterPack", "TheAnchor"], { slots: 5 })).toBe(23); // 3 +10 +10
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

describe("Chant — ×2 when the only vowels are A or E", () => {
  it("triggers when every vowel is a/e", () => {
    expect(score("cat", ["GutturalRoar"])).toBe(6); // 3 × 2
  });
  it("triggers vacuously on a word with no vowels", () => {
    expect(score("rhythm", ["GutturalRoar"])).toBe(12); // 6 × 2
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

describe("Try Hard — ×1.5 at 7, +0.1/letter beyond", () => {
  it("skips at 6 letters or fewer", () => {
    expect(scoreWord("cat", bay("TryHard"), opts).steps[0].triggered).toBe(false);
  });
  it("×1.5 at exactly 7 letters", () => {
    expect(score("monster", ["TryHard"])).toBe(11); // 7 × 1.5 = 10.5 → 11
  });
  it("×1.6 at 8 letters", () => {
    expect(score("elephant", ["TryHard"])).toBe(13); // 8 × 1.6 = 12.8 → 13
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

describe("Roulette Wheel — ×2 on a clean word", () => {
  it("rewards a clean word", () => {
    expect(score("cat", ["RouletteWheel"])).toBe(6); // 3 × 2
  });
});

describe("Blindfold — ×1.5 and hides the input", () => {
  it("always multiplies by 1.5", () => {
    expect(score("cat", ["Blindfold"])).toBe(5); // 3 × 1.5 = 4.5 → 5
  });
  it("reports that it hides the owner's input", () => {
    expect(bayHidesInput(makeBayEvaluator("cat", bay("Blindfold"), opts))).toBe(true);
  });
  it("a bay without it does not hide the input", () => {
    expect(bayHidesInput(makeBayEvaluator("cat", bay("TheAnchor"), opts))).toBe(false);
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

describe("Numismatist — ×(1 + 0.6 per rare letter)", () => {
  it("multiplies for rare letters", () => {
    // "quiz": 2 rare (q,z) → ×(1 + 0.6×2) = ×2.2. seed 4 × 2.2 = 8.8 → 9.
    expect(score("quiz", ["Numismatist"])).toBe(9);
  });
  it("skips cleanly with no rare letters", () => {
    expect(scoreWord("cat", bay("Numismatist"), opts).steps[0].triggered).toBe(false);
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

// ── New archetype cards ──────────────────────────────────────────────────────

describe("Heat Sink — +30% clock but ×0.9 score", () => {
  it("shaves 10% off the score where it folds", () => {
    expect(score("cat", ["TheAnchor", "HeatSink"])).toBe(12); // (3+10) × 0.9 = 11.7 → 12
  });
});

describe("Tilesmith — + letter-tile value", () => {
  it("adds common-letter tile values", () => {
    expect(score("cat", ["Tilesmith"])).toBe(8); // 3 + (c3 a1 t1 = 5)
  });
  it("rewards rare letters more", () => {
    expect(score("quiz", ["Tilesmith"])).toBe(26); // 4 + (q10 u1 i1 z10 = 22)
  });
});

describe("Bookends — ×2 when first letter = last letter", () => {
  it("doubles when the ends match", () => {
    expect(score("tat", ["Bookends"])).toBe(6); // 3 × 2
  });
  it("skips when the ends differ", () => {
    expect(scoreWord("cat", bay("Bookends"), opts).steps[0].triggered).toBe(false);
  });
});

describe("Dividend — +2 per card in the bay", () => {
  it("pays per bay slot", () => {
    expect(score("cat", ["Dividend"])).toBe(5); // 3 + 2×1
    expect(score("cat", ["Dividend", "TheAnchor"])).toBe(17); // 3 + 2×2 + 10
  });
});

describe("Crescendo — clean-streak multiplier", () => {
  it("skips with no streak service in scope (pure scoring)", () => {
    expect(scoreWord("cat", bay("Crescendo"), opts).steps[0].triggered).toBe(false);
  });
});

// ── Rarity coverage: every card is tiered, and the agreed distribution holds ──

describe("card rarity assignments", () => {
  const cards = Object.values(CARD_LIBRARY);
  const validTiers = new Set<CardRarityT>(Object.values(CardRarity));

  it("assigns every card a valid rarity tier", () => {
    for (const c of cards) {
      expect(validTiers.has(c.rarity), `${c.id} has rarity ${c.rarity}`).toBe(true);
    }
  });

  it("matches the agreed whole-catalogue distribution", () => {
    // 47 mode-agnostic + Classic-only cards, plus the 7 Picker-only Preference Cards.
    const counts: Record<CardRarityT, number> = {
      common: 0,
      uncommon: 0,
      rare: 0,
      legendary: 0,
    };
    for (const c of cards) counts[c.rarity]++;
    expect(counts).toEqual({ common: 20, uncommon: 17, rare: 13, legendary: 4 });
    expect(cards.length).toBe(54);
  });

  it("gives the CLASSIC dealer the original 18 / 15 / 11 / 3 pool", () => {
    // Classic is unchanged by all of this: the 7 Preference Cards are Picker-only, so its pool is
    // still exactly the 47 cards it always was.
    expect(rarityCardCounts(GameMode.Classic)).toEqual({
      common: 18,
      uncommon: 15,
      rare: 11,
      legendary: 3,
    });
    expect(dealableCardIds(GameMode.Classic).length).toBe(47);
  });

  it("gives the PICKER dealer its own pool: no Blindfold or Insurance, plus the seven", () => {
    // Out: The Blindfold (Uncommon — masks an input box Picker has none of) and Insurance
    // (Common — negates a timeout penalty Picker does not have).
    // In: Sieve + Wide Net (Common), Tide + Prospector (Uncommon), Winnower + Sentinel (Rare),
    // Tunnel Vision (Legendary).
    expect(rarityCardCounts(GameMode.Picker)).toEqual({
      common: 19,
      uncommon: 16,
      rare: 13,
      legendary: 4,
    });
    expect(dealableCardIds(GameMode.Picker).length).toBe(52);
  });
});

// ── dealableCardIds: the mode-scoped pool the dealer and the lobby both read ──

describe("dealableCardIds", () => {
  it("is a strict split — no card is dealable in neither mode", () => {
    const union = new Set([
      ...dealableCardIds(GameMode.Classic),
      ...dealableCardIds(GameMode.Picker),
    ]);
    expect(union.size).toBe(Object.keys(CARD_LIBRARY).length);
  });

  it("withholds exactly The Blindfold and Insurance from Picker", () => {
    const classic = new Set<string>(dealableCardIds(GameMode.Classic));
    const picker = new Set<string>(dealableCardIds(GameMode.Picker));
    expect([...classic].filter((id) => !picker.has(id)).sort()).toEqual(["Blindfold", "Insurance"]);
  });

  it("withholds every Preference Card from Classic", () => {
    const classic = new Set<string>(dealableCardIds(GameMode.Classic));
    const picker = new Set<string>(dealableCardIds(GameMode.Picker));
    expect([...picker].filter((id) => !classic.has(id)).sort()).toEqual([
      "Prospector",
      "Sentinel",
      "Sieve",
      "Tide",
      "TunnelVision",
      "WideNet",
      "Winnower",
    ]);
  });

  it("still RESOLVES a withheld card, so an existing bay and the gallery keep rendering", () => {
    // Undealable is not deleted: getCard stays mode-blind, or a score replay of a Classic match
    // (or the sandbox gallery) would render blanks.
    expect(getCard("Blindfold")?.name).toBe("Blindfold");
    expect(getCard("Sieve")?.name).toBe("Sieve");
  });

  it("preserves declaration order, which the dealer's weighted walk indexes into", () => {
    const all = Object.keys(CARD_LIBRARY);
    for (const mode of [GameMode.Classic, GameMode.Picker]) {
      const ids: string[] = [...dealableCardIds(mode)];
      expect(ids).toEqual(all.filter((id) => ids.includes(id)));
    }
  });
});

// ── rarityDealShare: the lobby's per-tier "share of a draw" readout ───────────

describe("rarityDealShare", () => {
  it("splits a draw across tiers by count × weight, summing to 1", () => {
    const share = rarityDealShare(DEFAULT_RARITY_DEAL_WEIGHT, GameMode.Classic);
    const sum = Object.values(share).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    // Σ = 18×10 + 15×5 + 11×2 + 3×1 = 280.
    expect(share.common).toBeCloseTo(180 / 280, 10);
    expect(share.uncommon).toBeCloseTo(75 / 280, 10);
    expect(share.rare).toBeCloseTo(22 / 280, 10);
    expect(share.legendary).toBeCloseTo(3 / 280, 10);
  });

  it("gives a zeroed tier exactly no share, and redistributes the rest", () => {
    const share = rarityDealShare({ ...DEFAULT_RARITY_DEAL_WEIGHT, common: 0 }, GameMode.Classic);
    expect(share.common).toBe(0);
    expect(Object.values(share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("returns zeros rather than NaN when every tier is zeroed", () => {
    const share = rarityDealShare(
      { common: 0, uncommon: 0, rare: 0, legendary: 0 },
      GameMode.Classic,
    );
    expect(share).toEqual({ common: 0, uncommon: 0, rare: 0, legendary: 0 });
  });
});

// ── dealPoolCapacity: the hard per-player ceiling the lobby warns against ─────

describe("dealPoolCapacity", () => {
  const ALL_TIERS = { common: 1, uncommon: 1, rare: 1, legendary: 1 };
  const capOf = (id: string) => CARD_LIBRARY[id as keyof typeof CARD_LIBRARY].maxInstances ?? 3;

  it("sums every copy of every card in the mode's pool when no tier is disabled", () => {
    // Derived from the mode's own id list, not the whole catalogue — the two diverged once cards
    // became mode-scoped, and the dealer reads the mode list.
    for (const mode of [GameMode.Classic, GameMode.Picker]) {
      const expected = dealableCardIds(mode).reduce((sum, id) => sum + capOf(id), 0);
      expect(dealPoolCapacity(ALL_TIERS, mode), mode).toBe(expected);
      // The weights are relative, so only the zero/non-zero split can move the ceiling.
      expect(dealPoolCapacity(DEFAULT_RARITY_DEAL_WEIGHT, mode), mode).toBe(expected);
    }
  });

  it("counts only the enabled tiers", () => {
    const legendaryOnly = dealPoolCapacity(
      { ...ALL_TIERS, common: 0, uncommon: 0, rare: 0 },
      GameMode.Classic,
    );
    // Deca-Quint 1 + Forgery 3 (the default cap) + Roulette Wheel 1 — a whole match's worth
    // of intermissions has 5 cards to draw from, against a default ask of 9.
    expect(legendaryOnly).toBe(5);
    expect(
      dealPoolCapacity(ALL_TIERS, GameMode.Classic) -
        dealPoolCapacity({ ...ALL_TIERS, legendary: 0 }, GameMode.Classic),
    ).toBe(legendaryOnly);
  });

  it("is 0 when every tier is disabled", () => {
    expect(
      dealPoolCapacity({ common: 0, uncommon: 0, rare: 0, legendary: 0 }, GameMode.Classic),
    ).toBe(0);
  });

  it("differs between the modes by exactly the cards each withholds", () => {
    /* The number the lobby's warning prints. If the dealer and this readout ever disagreed, the
     * warning would be wrong precisely in the mode it was computed for.
     *
     * Picker is the LARGER pool now: it gives up Blindfold (cap 1) and Insurance (cap 3), and gains
     * the seven Preference Cards — 3+1+3+1+3+3+3 = 17 copies, since Winnower and Tunnel Vision
     * are capped at one each. Net +13. */
    const classic = dealPoolCapacity(ALL_TIERS, GameMode.Classic);
    const picker = dealPoolCapacity(ALL_TIERS, GameMode.Picker);
    expect(picker - classic).toBe(13);
  });

  it("counts the legendary tier one card higher in Picker (Tunnel Vision)", () => {
    const legendaryOnly = { ...ALL_TIERS, common: 0, uncommon: 0, rare: 0 };
    expect(dealPoolCapacity(legendaryOnly, GameMode.Classic)).toBe(5);
    // Tunnel Vision is the family's only Legendary, and it is capped at 1.
    expect(dealPoolCapacity(legendaryOnly, GameMode.Picker)).toBe(6);
  });
});

// ── FX / hook-only cards: an inert "FX" step that never moves the score ───────

describe("FX cards fold inert (behaviour lives in the lifecycle hooks)", () => {
  const FX_CARDS = [
    "SlowBurn",
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
    "BaitAndSwitch",
    "LoanShark",
    "TheSniper",
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
