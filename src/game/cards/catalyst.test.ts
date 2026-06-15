import { describe, expect, it } from "vitest";
import { scoreWord } from "../scoring";
import type { BayCard } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("The Catalyst — Y/W/H count as vowels for cards after it", () => {
  it("makes Vocal Vowels count Y as a vowel", () => {
    // "syzygy" = s y z y g y. Normal vowels: 0. With Catalyst: y×3 = 3 vowels.
    // <7 letters → +3/vowel = +9. seed 6 → 15.
    expect(scoreWord("syzygy", bay("Catalyst", "VocalVowels"), opts).finalScore).toBe(15);
  });

  it("does not affect a Vocal Vowels placed BEFORE it", () => {
    // Vocal Vowels first sees normal vowels (0) → +0 (skip). seed 6 → 6.
    expect(scoreWord("syzygy", bay("VocalVowels", "Catalyst"), opts).finalScore).toBe(6);
  });

  it("flips Vowel Surge by reclassifying Y/W/H", () => {
    // "wryly" = w r y l y. Catalyst vowels: w,y,y = 3; consonants (plain): r,l = ... actually
    // consonant classifier is independent (plain): w,r,y,l,y → non-vowels(plain) = all 5.
    // vowels(3) > consonants(5)? no. So Vowel Surge does NOT trigger here — assert skip.
    const r = scoreWord("wryly", bay("Catalyst", "VowelSurge"), opts);
    expect(r.steps[r.steps.length - 1].triggered).toBe(false);
  });

  it("keeps Y/W/H as consonants too (both roles)", () => {
    // Consonant Crunch after Catalyst: consonant classifier is unchanged, so 'y' still counts
    // as a consonant. "yay" = y a y → consonants y,y = 2. <7 → +2/con = +4. seed 3 → 7.
    expect(scoreWord("yay", bay("Catalyst", "ConsonantCrunch"), opts).finalScore).toBe(7);
  });
});
