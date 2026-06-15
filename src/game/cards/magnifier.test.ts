import { describe, expect, it } from "vitest";
import { scoreWord } from "../scoring";
import type { BayCard } from "../types";

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
    expect(scoreWord("cat", bay("MagnifyingGlass", "MagnifyingGlass", "TheAnchor"), opts).finalScore).toBe(26);
  });

  it("stacks: three glasses → ×3.375", () => {
    // +10 × 3.375 = +33.75; seed 3 → 36.75 → 37.
    expect(
      scoreWord("cat", bay("MagnifyingGlass", "MagnifyingGlass", "MagnifyingGlass", "TheAnchor"), opts).finalScore,
    ).toBe(37);
  });

  it("inert FX neighbour opts out (a glass never turns FX into a multiplier)", () => {
    // Glass to the left of a Tax Collector (FX) changes nothing.
    expect(scoreWord("cat", bay("MagnifyingGlass", "TaxCollector"), opts).finalScore).toBe(3);
  });
});
