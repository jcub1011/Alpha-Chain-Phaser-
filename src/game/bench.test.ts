import { describe, expect, it } from "vitest";
import { BenchScenario } from "./bench";
import { Dictionary } from "./dictionary";

const dict = new Dictionary(["cat", "tiger", "rat", "art", "cot", "tea"]);

const fresh = (n = 2): BenchScenario => {
  const b = new BenchScenario(dict);
  b.reset(n);
  return b;
};

describe("BenchScenario", () => {
  it("resets into the Round phase with N empty bays", () => {
    const b = fresh(4);
    expect(b.phase).toBe("Round");
    expect(b.players).toHaveLength(4);
    expect(b.players.every((p) => p.bay.length === 0)).toBe(true);
    expect(b.currentPlayerId).toBe("P0");
  });

  it("clamps the player count to 2–8", () => {
    expect(fresh(1).players).toHaveLength(2);
    expect(fresh(99).players).toHaveLength(8);
  });

  it("builds an uncapped bay (more cards than the 3 starting slots)", () => {
    const b = fresh(2);
    b.setBay("P0", ["TheAnchor", "TheAnchor", "TheAnchor", "TheAnchor", "TheAnchor"]);
    expect(b.bayOf("P0")).toHaveLength(5);
    // Unknown ids are dropped.
    b.setBay("P0", ["TheAnchor", "NotARealCard"]);
    expect(b.bayOf("P0")).toEqual(["TheAnchor"]);
  });

  it("scores a real word through the live engine and records history", () => {
    const b = fresh(2);
    b.setBay("P0", ["TheAnchor"]); // +10 flat
    const r = b.submit("cat", 20); // seed 3 + 10
    expect(r.accepted).toBe(true);
    expect(b.latest?.word).toBe("cat");
    expect(b.latest?.breakdown.finalScore).toBe(13);
    expect(b.players[0].score).toBe(13);
    expect(b.history).toHaveLength(1);
  });

  it("rejects an out-of-dictionary word with a reason", () => {
    const b = fresh(2);
    const r = b.submit("zzzzz", 20);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not-a-word");
  });

  it("taxes a banned-letter word for a non-exempt player", () => {
    const b = fresh(2);
    b.setScore("P0", 5); // P0 is no longer last place, so not ban-exempt
    b.setBannedLetter("a");
    b.setBay("P0", ["TheAnchor"]);
    const r = b.submit("cat", 20); // contains "a"
    expect(r.accepted).toBe(true);
    expect(b.latest?.taxed).toBe(true);
    expect(b.latest?.breakdown.finalScore).toBe(0);
  });

  it("lets an opponent's Tax Collector siphon a bounty off a taxed word", () => {
    const b = fresh(2);
    b.setScore("P0", 5); // keep P0 non-exempt
    b.setBannedLetter("a");
    b.setBay("P1", ["TaxCollector"]);
    b.setBay("P0", ["TheAnchor"]);
    b.submit("cat", 20);
    expect(b.latest?.taxed).toBe(true);
    expect(b.latest?.taxBounty ?? 0).toBeGreaterThan(0);
    expect(b.latest?.siphonedBy).toContain("P1");
  });

  it("advances the turn on skip", () => {
    const b = fresh(2);
    expect(b.currentPlayerId).toBe("P0");
    b.skip();
    expect(b.currentPlayerId).toBe("P1");
  });
});
