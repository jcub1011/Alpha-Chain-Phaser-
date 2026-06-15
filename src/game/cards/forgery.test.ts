import { describe, expect, it } from "vitest";
import { scoreWord } from "../scoring";
import type { BayCard } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("Forgery — perceived length doubling", () => {
  it("doubles the perceived length for a length-scoring card after it", () => {
    // "cat"=3, Forgery makes Vanilla see 6 letters. 6 < 7 so +1/letter → +6. seed 3 → 9.
    expect(scoreWord("cat", bay("Forgery", "Vanilla"), opts).finalScore).toBe(9);
  });

  it("pushes a length card over a threshold (Vanilla's 7+ → +2/letter)", () => {
    // "tiger"=5 → perceived 10 ≥ 7 → +2/letter on 10 → +20. seed 5 → 25.
    expect(scoreWord("tiger", bay("Forgery", "Vanilla"), opts).finalScore).toBe(25);
  });

  it("triggers The Architect (8+) on a perceived-doubled short word", () => {
    // "tiger"=5 → perceived 10 ≥ 8 → ×3 on seed 5 = 15.
    expect(scoreWord("tiger", bay("Forgery", "TheArchitect"), opts).finalScore).toBe(15);
  });

  it("does NOT affect per-character cards (Consonant Crunch counts real letters)", () => {
    // "monster"=7, 5 consonants. Real length gate 7+ → +3/consonant = +15. seed 7 → 22.
    // Forgery in front must not change the consonant count.
    expect(scoreWord("monster", bay("Forgery", "ConsonantCrunch"), opts).finalScore).toBe(22);
  });

  it("does not affect cards placed BEFORE it", () => {
    // Vanilla (before Forgery) sees real 3 → +3; seed 3 → 6.
    expect(scoreWord("cat", bay("Vanilla", "Forgery"), opts).finalScore).toBe(6);
  });

  it("stacks with a Magnifying Glass on the Forgery (×2 perceived → ×3)", () => {
    // Glass magnifies Forgery: perceived = 3 × 2 × 1.5 = 9. Vanilla 9 ≥ 7 → +2/letter = +18. seed 3 → 21.
    expect(scoreWord("cat", bay("MagnifyingGlass", "Forgery", "Vanilla"), opts).finalScore).toBe(21);
  });
});
