import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

// End-to-end coverage: Forgery in a real player bay must inflate the perceived
// length that ConsonantCrunch / VocalVowels gate on and that AnchorChain scales
// by — proving the wiring (bay → scoreWord) carries the fix, not just scoreWord.
const WORDS = new Set(["barn", "idea", "cat"]);
const two: PlayerSeed[] = [
  { id: "p1", name: "P1", isBot: false },
  { id: "p2", name: "P2", isBot: false },
];

const make = (overrides: Partial<AlphaChainSettings> = {}) => {
  const m = new MatchController(
    two,
    {
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
      ...overrides,
    },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );
  m.start();
  m.tick(1); // burn the pre-round countdown
  return m;
};

describe("Forgery in a live bay — perceived length reaches the scoring cards", () => {
  it("pushes Consonant Crunch over its 7+ gate", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "Forgery" }, { id: "ConsonantCrunch" }];
    // "barn"=4, 3 consonants → perceived 8 ≥ 7 → +3/consonant = +9. seed 4 → 13.
    const r = m.submitWord("p1", "barn");
    expect(r.submission!.score).toBe(13);
  });

  it("pushes Vocal Vowels over its 7+ gate", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "Forgery" }, { id: "VocalVowels" }];
    // "idea"=4, 3 vowels → perceived 8 ≥ 7 → +4/vowel = +12. seed 4 → 16.
    const r = m.submitWord("p1", "idea");
    expect(r.submission!.score).toBe(16);
  });

  it("scales Anchor Chain's per-letter multiplier with the perceived length", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "Forgery" }, { id: "AnchorChain" }];
    // "cat"=3 → perceived 6 → ×(0.5×6)=×3 on seed 3 → 9.
    const r = m.submitWord("p1", "cat");
    expect(r.submission!.score).toBe(9);
  });
});
