/*
 * Cross-card integration on the pure scoring fold: the Catalyst "letters act as
 * vowels" reclassification driving downstream cards, Forgery + Catalyst working
 * together, Magnifying-Glass stacking across card families, and how placement
 * order changes the result. All numeric, all through scoreWord.
 */

import { describe, expect, it } from "vitest";
import { scoreWord } from "../scoring";
import type { BayCard } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };
const score = (word: string, ...ids: string[]): number =>
  scoreWord(word, bay(...ids), opts).finalScore;
const triggered = (word: string, ...ids: string[]): boolean => {
  const steps = scoreWord(word, bay(...ids), opts).steps;
  return steps[steps.length - 1].triggered;
};

describe("Catalyst reclassifies Y/W/H as vowels for cards to its right", () => {
  it("flips Vowel Surge ON (Y counts as a vowel and a consonant)", () => {
    // "yay" plain: vowels {a}=1, consonants {y,y}=2 → no surge.
    expect(triggered("yay", "VowelSurge")).toBe(false);
    // With Catalyst: vowels {y,a,y}=3 > consonants {y,y}=2 → ×3.
    expect(score("yay", "Catalyst", "VowelSurge")).toBe(9); // 3 × 3
  });

  it("lets Perfect Link treat a trailing Y as a vowel", () => {
    expect(triggered("happy", "PerfectLink")).toBe(false); // ends in plain consonant 'y'
    expect(score("happy", "Catalyst", "PerfectLink")).toBe(8); // 5 × 1.5 = 7.5 → 8
  });

  it("makes Vocal Vowels count Y/W/H", () => {
    expect(score("happy", "VocalVowels")).toBe(8); // plain: 1 vowel ×3 → 5+3
    expect(score("happy", "Catalyst", "VocalVowels")).toBe(14); // h,a,y = 3 vowels ×3 → 5+9
  });

  it("can break Guttural Roar by introducing a non-A/E vowel", () => {
    expect(score("way", "GutturalRoar")).toBe(5); // plain vowel 'a' only → ×1.5
    // Catalyst adds w,y as vowels → not all A/E → skip.
    expect(triggered("way", "Catalyst", "GutturalRoar")).toBe(false);
  });

  it("only affects cards placed AFTER it (Vocal Vowels before Catalyst is unaffected)", () => {
    expect(score("happy", "VocalVowels", "Catalyst")).toBe(8); // sees plain 1 vowel
  });
});

describe("Forgery + Catalyst work together but on independent axes", () => {
  it("Forgery feeds a length card while Catalyst feeds a per-character card", () => {
    // "wry"(3): Forgery → Vanilla perceives 6 (+6 → 9); Catalyst → Vocal Vowels
    // counts w,y as vowels (2 × 3 = +6 → 15). Real length still 3 for VV's gate.
    expect(score("wry", "Forgery", "Vanilla", "Catalyst", "VocalVowels")).toBe(15);
  });
});

describe("Magnifying Glass stacks across families", () => {
  it("magnifies a conditional multiplier (Guttural Roar ×1.5 → ×2.25)", () => {
    expect(score("cat", "MagnifyingGlass", "GutturalRoar")).toBe(7); // 3 × 2.25 = 6.75 → 7
  });

  it("magnifies The Double Down's bonus (×2 → ×3)", () => {
    expect(score("tatter", "MagnifyingGlass", "DoubleDown")).toBe(18); // 6 × 3
  });

  it("never magnifies a card to its left", () => {
    expect(score("elephant", "TheArchitect", "MagnifyingGlass")).toBe(24); // plain ×3
  });
});

describe("Placement order changes the result", () => {
  it("additive→multiplier scales the larger base", () => {
    expect(score("cat", "Vanilla", "Redline")).toBe(12); // (3+3) × 2
    expect(score("cat", "Redline", "Vanilla")).toBe(9); // (3×2) + 3
  });

  it("The Double Down's ×0.5 penalty compounds differently by position", () => {
    expect(score("cat", "TheAnchor", "DoubleDown")).toBe(7); // (3+10) × 0.5 = 6.5 → 7
    expect(score("cat", "DoubleDown", "TheAnchor")).toBe(12); // (3×0.5) + 10 = 11.5 → 12
  });
});
