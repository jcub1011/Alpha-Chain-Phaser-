import { describe, expect, it } from "vitest";
import { armedClockSeconds, roundHalfUp, scoreTimeout, scoreWord } from "./scoring";
import type { BayCard } from "./types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("scoreWord — sequential fold", () => {
  it("seeds with word length when the bay is empty", () => {
    expect(scoreWord("cat", bay(), opts).finalScore).toBe(3);
  });

  it("adds The Anchor's flat +10", () => {
    expect(scoreWord("cat", bay("TheAnchor"), opts).finalScore).toBe(13); // 3 + 10
  });

  it("placement matters: additive→multiplier scales the bigger base", () => {
    // elephant = 8 letters; Architect ×3 triggers at 8+.
    const additiveFirst = scoreWord("elephant", bay("TheAnchor", "TheArchitect"), opts);
    expect(additiveFirst.finalScore).toBe((8 + 10) * 3); // 54

    const multiplierFirst = scoreWord("elephant", bay("TheArchitect", "TheAnchor"), opts);
    expect(multiplierFirst.finalScore).toBe(8 * 3 + 10); // 34
  });

  it("Vanilla pays +2/letter at 7+ letters", () => {
    expect(scoreWord("monster", bay("Vanilla"), opts).finalScore).toBe(7 + 7 * 2); // 21
  });

  it("conditional multiplier does not trigger below threshold (chip is —)", () => {
    const r = scoreWord("cat", bay("TheArchitect"), opts); // 3 letters < 8
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].triggered).toBe(false);
    expect(r.steps[0].valueText).toBe("—");
  });

  it("Sesquipedalian ×5 fires at 10 letters", () => {
    expect(scoreWord("basketball", bay("Sesquipedalian"), opts).finalScore).toBe(10 * 5); // 50
  });

  it("FX cards emit a step but leave the value unchanged", () => {
    const r = scoreWord("cat", bay("TaxCollector"), opts);
    expect(r.finalScore).toBe(3);
    expect(r.steps[0].valueText).toBe("FX");
  });

  it("zeroes the score when taxed but still records what it would have been", () => {
    const r = scoreWord("elephant", bay("TheAnchor"), { ...opts, taxed: true });
    expect(r.finalBeforeTax).toBe(18);
    expect(r.finalScore).toBe(0);
    expect(r.taxed).toBe(true);
  });

  it("clamps a single word to the 10,000 max", () => {
    // 10-letter word, +10, then ×5 ×3 ×2 ×1.5 = (10+10)*5*3*2*1.5 = 900 — bump with many.
    const r = scoreWord(
      "basketball",
      bay("TheAnchor", "Sesquipedalian", "TheArchitect", "VowelSurge", "Redline", "TheVault"),
      opts,
    );
    expect(r.finalScore).toBeLessThanOrEqual(10000);
  });
});

describe("scoreTimeout — the penalty walk (mirrors scoreWord)", () => {
  it("an empty bay loses only the flat base penalty", () => {
    expect(scoreTimeout(bay(), opts).finalScore).toBe(-10);
  });

  it("a glass-cannon card folds in its own drain (Vault −5)", () => {
    expect(scoreTimeout(bay("TheVault"), opts).finalScore).toBe(-15); // -10 base, -5 Vault
  });

  it("stacks multiple speed cards", () => {
    expect(scoreTimeout(bay("TheVault", "Redline"), opts).finalScore).toBe(-27); // -10 -5 -12
  });

  it("a Magnifying Glass magnifies the loss too (Redline ×1.5)", () => {
    expect(scoreTimeout(bay("MagnifyingGlass", "Redline"), opts).finalScore).toBe(-28); // -10 + (-12×1.5)
  });

  it("Insurance negates the base penalty (lose nothing on a timeout)", () => {
    expect(scoreTimeout(bay("Insurance"), opts).finalScore).toBe(0); // -10 base, fully refunded
  });

  it("Insurance negates glass-cannon drains to its left (floor at 0)", () => {
    // Insurance sits to the RIGHT and brings the running penalty back to 0.
    expect(scoreTimeout(bay("TheVault", "Redline", "Insurance"), opts).finalScore).toBe(0);
  });

  it("Insurance negation is order-independent (drain to its right still floored)", () => {
    // Insurance zeroes at its step, a later Redline re-opens a loss, but the final
    // net is floored to 0 because the bay holds an Insurance card.
    expect(scoreTimeout(bay("Insurance", "Redline"), opts).finalScore).toBe(0);
  });

  it("emits one step per bay slot (aligned to the replay fan); inert cards skip", () => {
    const bd = scoreTimeout(bay("TheVault", "TheAnchor"), opts);
    expect(bd.seed).toBe(-10);
    expect(bd.steps).toHaveLength(2);
    expect(bd.steps[0].triggered).toBe(true); // Vault drains
    expect(bd.steps[1].triggered).toBe(false); // The Anchor is inert on a timeout
    expect(bd.taxed).toBe(false);
  });
});

describe("roundHalfUp", () => {
  it("rounds .5 up", () => {
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.4)).toBe(2);
  });
});

describe("armedClockSeconds", () => {
  it("applies percentage clock modifiers", () => {
    expect(armedClockSeconds(20, bay())).toBe(20);
    expect(armedClockSeconds(20, bay("TheVault"))).toBe(18); // -10%
    expect(armedClockSeconds(20, bay("Redline"))).toBe(16); // -20%
    expect(armedClockSeconds(20, bay("TheVault", "Redline"))).toBe(14); // -30%
    expect(armedClockSeconds(20, bay("Redline", "HeatSink"))).toBe(24); // -20% +40%
  });

  it("never falls below the 3s floor", () => {
    expect(armedClockSeconds(4, bay("Redline", "Redline", "Redline", "Redline", "Redline"))).toBe(
      3,
    );
  });
});
