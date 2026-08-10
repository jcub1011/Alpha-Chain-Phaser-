import { describe, expect, it } from "vitest";
import { scoreWord } from "../scoring";
import { CardRarity, type BayCard } from "../types";
import { CARD_LIBRARY } from "./library";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("Magnifying Glass — neighbor amplification", () => {
  it("magnifies the card immediately to its right (+10 → +15)", () => {
    // seed "cat"=3, glass magnifies The Anchor → +15 → 18.
    expect(scoreWord("cat", bay("MagnifyingGlass", "TheAnchor"), opts).finalScore).toBe(18);
  });

  it("magnifies a multiplier (×3 → ×4.5)", () => {
    // elephant=8, Architect ×3 normally; magnified ×4.5 → 8×4.5 = 36.
    expect(scoreWord("elephant", bay("MagnifyingGlass", "TheArchitect"), opts).finalScore).toBe(36);
  });

  it("does NOT magnify a card to its left", () => {
    // The Anchor (left) is unmagnified; glass then magnifies nothing real to its right.
    expect(scoreWord("cat", bay("TheAnchor", "MagnifyingGlass"), opts).finalScore).toBe(13);
  });

  it("stacks: two glasses on the one neighbor → ×2.25", () => {
    // +10 base → ×2.25 = +22.5 → round half-up. seed 3 + 22.5 = 25.5 → 26.
    expect(
      scoreWord("cat", bay("MagnifyingGlass", "MagnifyingGlass", "TheAnchor"), opts).finalScore,
    ).toBe(26);
  });

  it("stacks: three glasses → ×3.375", () => {
    // +10 × 3.375 = +33.75; seed 3 → 36.75 → 37.
    expect(
      scoreWord(
        "cat",
        bay("MagnifyingGlass", "MagnifyingGlass", "MagnifyingGlass", "TheAnchor"),
        opts,
      ).finalScore,
    ).toBe(37);
  });

  it("stacks to the copy cap: five glasses → ×7.59375", () => {
    // maxInstances is 5 for the glass, so this is the highest reachable stack.
    // +10 × 7.59375 = +75.9375; seed 3 → 78.9375 → 79.
    expect(
      scoreWord(
        "cat",
        bay(
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "TheAnchor",
        ),
        opts,
      ).finalScore,
    ).toBe(79);
  });

  it("inert FX neighbour opts out (a glass never turns FX into a multiplier)", () => {
    // Glass to the left of a Tax Collector (FX) changes nothing.
    expect(scoreWord("cat", bay("MagnifyingGlass", "TaxCollector"), opts).finalScore).toBe(3);
  });
});

/*
 * The glass is the game's steepest build-around, and both halves of its ceiling are
 * deliberate: Rare (not Legendary) so the dealer actually offers it, and maxInstances 5
 * (the only card above the default 3) so the full ×7.59375 stack is reachable. Rarity used
 * to be the brake, but hosts can now retune the tiers — a "Rares only" lobby offers nothing
 * else — so the ceiling is pinned here instead. These numbers are a balance decision, not an
 * implementation detail: changing either half should have to change this test on purpose.
 */
describe("Magnifying Glass — the deliberate ceiling", () => {
  it("caps at 5 copies of a Rare, the two settings that set the ceiling", () => {
    const glass = CARD_LIBRARY.MagnifyingGlass;
    expect(glass.maxInstances).toBe(5);
    expect(glass.rarity).toBe(CardRarity.Rare);
  });

  it("the worst case is a full stack on a multiplier: ×3 becomes ×22.78", () => {
    // Five glasses compound to ×7.59375, and that applies to a multiplier's factor too:
    // The Architect's ×3 → ×22.78125. elephant = 8 → 182.25 → 182, from 6 of 12 bay slots.
    expect(
      scoreWord(
        "elephant",
        bay(
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "MagnifyingGlass",
          "TheArchitect",
        ),
        opts,
      ).finalScore,
    ).toBe(182);
  });
});
