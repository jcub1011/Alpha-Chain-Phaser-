import { describe, expect, it } from "vitest";
import { armedClockSeconds, scoreWord } from "../scoring";
import type { BayCard } from "../types";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const opts = { prevWordLength: 0, clockRemaining: 10, clockTotal: 20, taxed: false };

describe("armedClockSeconds — layered clock", () => {
  it("sums fractional deltas (Overclock −20% + Heat Sink +30%)", () => {
    expect(armedClockSeconds(20, bay("TheVault", "HeatSink"))).toBe(22); // +10%
  });

  it("magnifies a clock delta (Redline −30% behind a glass → −45%)", () => {
    expect(armedClockSeconds(20, bay("MagnifyingGlass", "Redline"))).toBe(11); // 20 × 0.55
  });

  it("never falls below the 3s floor", () => {
    expect(armedClockSeconds(4, bay("Redline", "Redline", "Redline", "Redline", "Redline"))).toBe(
      3,
    );
  });

  it("Slow Burn lengthens the clock 30%", () => {
    expect(armedClockSeconds(20, bay("SlowBurn"))).toBe(26);
  });
});

describe("time-aware scoring", () => {
  it("Reflex multiplies by 1 + 0.05 per second left", () => {
    // clockRemaining 10 → ×1.5; "elephant"=8 → 8 × 1.5 = 12.
    const r = scoreWord("elephant", bay("PanicButton"), {
      ...opts,
      clockRemaining: 10,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(12);
  });

  it("Reflex caps at ×2", () => {
    // 40s left would be ×3, but the cap holds it at ×2; "elephant"=8 → 16.
    const r = scoreWord("elephant", bay("PanicButton"), {
      ...opts,
      clockRemaining: 40,
      clockTotal: 40,
    });
    expect(r.finalScore).toBe(16);
  });

  it("Speedracer multiplies by 1 + remaining/total (×2 at a full clock)", () => {
    const r = scoreWord("elephant", bay("Speedracer"), {
      ...opts,
      clockRemaining: 20,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(16); // 8 × 2
  });

  it("Speedracer scales down as the clock drains (×1.5 at half)", () => {
    const r = scoreWord("elephant", bay("Speedracer"), {
      ...opts,
      clockRemaining: 10,
      clockTotal: 20,
    });
    expect(r.finalScore).toBe(12); // 8 × 1.5
  });
});
