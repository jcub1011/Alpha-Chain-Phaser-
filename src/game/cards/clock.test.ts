import { describe, expect, it } from "vitest";
import { armedClockSeconds, scoreWord } from "../scoring";
import type { BayCard } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("armedClockSeconds — layered clock", () => {
  it("sums fractional deltas (Vault −10% + Heat Sink +30%)", () => {
    expect(armedClockSeconds(20, bay("TheVault", "HeatSink"))).toBe(24); // +20%
  });

  it("magnifies a clock delta (Redline −20% behind a glass → −30%)", () => {
    expect(armedClockSeconds(20, bay("MagnifyingGlass", "Redline"))).toBe(14); // 20 × 0.7
  });

  it("Anchor Chain pins the clock to 5s, ignoring Heat Sink", () => {
    expect(armedClockSeconds(20, bay("AnchorChain", "HeatSink"))).toBe(5);
  });

  it("Hyper-Drive caps a longer clock at 5s but never raises a shorter one", () => {
    expect(armedClockSeconds(20, bay("HyperDrive"))).toBe(5); // capped down
    expect(armedClockSeconds(4, bay("HyperDrive"))).toBe(4); // below cap, untouched
  });

  it("never falls below the 3s floor", () => {
    expect(armedClockSeconds(4, bay("Redline", "Redline", "Redline", "Redline", "Redline"))).toBe(
      3,
    );
  });

  it("Slow Burn lengthens the clock 20%", () => {
    expect(armedClockSeconds(20, bay("SlowBurn"))).toBe(24);
  });
});

describe("time-aware scoring", () => {
  it("Panic Button ×2.7 when submitted early (>=2s left)", () => {
    // "elephant"=8, plenty of time → ×2.7 → 8 × 2.7 = 21.6 → 22.
    const r = scoreWord("elephant", bay("PanicButton"), {
      ...opts,
      clockRemaining: 10,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(22);
  });

  it("Panic Button ×1.35 in the danger zone (<2s left)", () => {
    const r = scoreWord("elephant", bay("PanicButton"), {
      ...opts,
      clockRemaining: 1,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(11); // 8 × 1.35 = 10.8 → 11
  });

  it("Speedracer caps at half the letter count", () => {
    // 8-letter word, almost no time left → factor = min(huge, 8/2=4) = 4. 8 × 4 = 32.
    const r = scoreWord("elephant", bay("Speedracer"), {
      ...opts,
      clockRemaining: 0.1,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(32);
  });

  it("Speedracer does not trigger at 6 letters or fewer", () => {
    const r = scoreWord("monkey", bay("Speedracer"), {
      ...opts,
      clockRemaining: 1,
      clockTotal: 20,
    });
    expect(r.steps[0].triggered).toBe(false);
  });

  it("Anchor Chain multiplies by 0.5 per real letter", () => {
    // "cat"=3 → ×1.5 → 4.5 → 5 (rounded). Real length, not perceived.
    expect(scoreWord("cat", bay("AnchorChain"), opts).finalScore).toBe(5);
  });

  it("Hyper-Drive folds ×1.5 at its slot when the word is 7+ letters", () => {
    // "monster"=7 → ×1.5 → 10.5 → 11 (the cap only affects the clock, not the score).
    expect(scoreWord("monster", bay("HyperDrive"), opts).finalScore).toBe(11);
  });
});
