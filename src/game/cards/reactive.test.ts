/*
 * Reactive economy + aggression integration — the cards that only pay off when an
 * OPPONENT acts (or messes up). Driven through a real MatchController so the
 * lifecycle hooks (onOpponentWordResolved / onTurnEnded) fire in canonical order.
 * Complements the positive cases in economy.test / aggression.test / tax.test.
 */

import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { orderPreservingRng } from "../rng";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

const WORDS = new Set([
  "cat",
  "tap",
  "tiger",
  "rat",
  "zebra",
  "rabbit",
  "torch",
  "art",
  "monster",
  "cot",
  "tea",
  "apple",
]);

const seeds = (n: number): PlayerSeed[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, isBot: false }));

const make = (n: number, overrides: Partial<AlphaChainSettings> = {}) => {
  const m = new MatchController(
    seeds(n),
    {
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
      shotClockSeconds: 20,
      ...overrides,
    },
    // Keep seed order (p1, p2, p3, …) so multi-player turn order is deterministic
    // despite the per-era shuffle these cards' assertions depend on.
    { isWord: (w) => WORDS.has(w), rng: orderPreservingRng },
  );
  m.start();
  m.tick(1); // burn the countdown → p1's turn armed, free choice
  return m;
};

describe("Tax Collector — only banks off an opponent's taxed word", () => {
  it("collects nothing from a clean (untaxed) word", () => {
    const m = make(2);
    m.state.players[1].bay = [{ id: "TaxCollector" }];
    const r = m.submitWord("p1", "cat"); // no banned letter → clean
    expect(r.submission!.taxed).toBe(false);
    expect(m.state.players[1].score).toBe(0);
  });

  it("lets two collectors each bank half the would-be score", () => {
    const m = make(3);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100; // p1 not last → not exempt
    m.state.players[1].score = 50;
    m.state.players[2].score = 50;
    m.state.players[1].bay = [{ id: "TaxCollector" }];
    m.state.players[2].bay = [{ id: "TaxCollector" }];
    const r = m.submitWord("p1", "cat"); // would-be 3, taxed by 't'
    expect(r.submission!.taxed).toBe(true);
    expect(m.state.players[1].score).toBe(52); // 50 + floor(1.5+0.5)=2
    expect(m.state.players[2].score).toBe(52);
    expect(r.submission!.siphonedBy).toEqual(expect.arrayContaining(["p2", "p3"]));
    expect(r.submission!.effects).toEqual(
      expect.arrayContaining([
        { source: "Tax Collector", targetId: "p2", text: "+2 banked", amount: 2 },
        { source: "Tax Collector", targetId: "p3", text: "+2 banked", amount: 2 },
      ]),
    );
  });

  it("collects nothing when the victim is last-place exempt (word not taxed)", () => {
    const m = make(2);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 0; // p1 is last place → exempt from the era ban
    m.state.players[1].score = 100;
    m.state.players[1].bay = [{ id: "TaxCollector" }];
    const r = m.submitWord("p1", "cat"); // exempt → NOT taxed
    expect(r.submission!.taxed).toBe(false);
    expect(m.state.players[1].score).toBe(100);
  });
});

describe("Bait & Switch → hijack → Tax Collector (multi-turn opponent-messes-up chain)", () => {
  it("curses the next player, taxing their next word, which a Tax Collector banks", () => {
    const m = make(2);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100; // p1 not last → era ban applies to p1
    m.state.players[0].bay = [{ id: "BaitAndSwitch" }, { id: "TaxCollector" }];

    // 1) p1 eats the tax on 't' → curses p2 with 't'. p1 stays 100 (taxed → 0, no self-collect).
    const r1 = m.submitWord("p1", "cat");
    expect(r1.submission!.taxed).toBe(true);
    expect(m.services.hijackBan.peek("p2")).toBe("t");
    expect(m.state.players[0].score).toBe(100);

    // 2) p2's turn (required letter reset to free: 'cat' ends in the banned 't').
    //    p2 plays a 't' word → hijack-taxed even though p2 is era-exempt.
    const r2 = m.submitWord("p2", "tap");
    expect(r2.submission!.taxed).toBe(true);
    expect(m.state.players[0].score).toBe(102); // Tax Collector banks floor(3 × 0.5) = 2
  });
});

describe("The Bounty Hunter — fires only on the round leader's short word", () => {
  it("does not dock the leader for a 6+ letter word", () => {
    const m = make(3);
    m.state.players[1].bay = [{ id: "BountyHunter" }]; // an opponent watches the leader
    expect(m.computeLeaderId()).toBe("p1");
    const r = m.submitWord("p1", "rabbit"); // leader, 6 letters → not short
    expect(r.submission!.score).toBe(6);
    expect(m.state.players[0].score).toBe(6); // untouched
  });

  it("does not dock a non-leader who plays a short word", () => {
    const m = make(3);
    m.state.players[0].bay = [{ id: "BountyHunter" }]; // the leader holds it
    m.submitWord("p1", "rabbit"); // leader plays first → required letter 't'
    const r = m.submitWord("p2", "tap"); // non-leader, short word → no dock
    expect(r.submission!.score).toBe(3);
    expect(m.state.players[1].score).toBe(3);
  });
});

describe("The Toll Booth — no toll on an opponent's taxed word", () => {
  it("banks nothing when the opponent's letter-using word is itself taxed", () => {
    const m = make(2);
    m.state.players[0].bay = [{ id: "TollBooth" }];
    m.services.cardBan.roll("p1", "TollBooth", "z");
    m.state.bannedLetter = "z"; // p2's 'zebra' will be era-taxed
    m.state.players[0].score = 0; // p1 last/exempt (owner; irrelevant here)
    m.state.players[1].score = 100; // p2 not last → its 'z' word is taxed
    m.state.currentPlayerIndex = 1; // p2's turn, free choice
    m.state.requiredLetter = "";
    const r = m.submitWord("p2", "zebra");
    expect(r.submission!.taxed).toBe(true);
    expect(m.state.players[0].score).toBe(0); // toll skipped on a taxed word
  });

  it("banks 20% (and announces it) when an opponent's clean word uses the letter", () => {
    const m = make(2);
    m.state.players[0].bay = [{ id: "TollBooth" }];
    m.services.cardBan.roll("p1", "TollBooth", "z");
    m.state.players[0].score = 0;
    m.state.currentPlayerIndex = 1; // p2's turn, free choice
    m.state.requiredLetter = "";
    const r = m.submitWord("p2", "zebra"); // clean word containing the toll letter 'z'
    expect(r.submission!.taxed).toBe(false);
    expect(r.submission!.taxBounty).toBeGreaterThan(0);
    expect(m.state.players[0].score).toBe(r.submission!.taxBounty); // owner banked the toll
    expect(r.submission!.siphonedBy).toContain("p1");
    expect(r.submission!.effects).toContainEqual({
      source: "The Toll Booth",
      targetId: "p1",
      text: `+${r.submission!.taxBounty} banked`,
      amount: r.submission!.taxBounty,
    });
  });
});

describe("Chrono Syphon — every opponent banks the leftover seconds", () => {
  it("two opponents each gain the submitter's whole remaining seconds", () => {
    const m = make(3);
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    m.state.players[2].bay = [{ id: "ChronoSyphon" }];
    m.tick(5); // burn 5s of p1's 20s clock → 15 remaining
    const remaining = Math.floor(m.state.clockRemaining);
    expect(remaining).toBe(15);
    const r = m.submitWord("p1", "cat");
    expect(m.state.players[1].score).toBe(remaining * 2); // +2 per whole second
    expect(m.state.players[2].score).toBe(remaining * 2);
    expect(r.submission!.effects).toEqual(
      expect.arrayContaining([
        {
          source: "Chrono Syphon",
          targetId: "p2",
          text: `+${remaining * 2} banked`,
          amount: remaining * 2,
        },
        {
          source: "Chrono Syphon",
          targetId: "p3",
          text: `+${remaining * 2} banked`,
          amount: remaining * 2,
        },
      ]),
    );
  });
});

describe("Flak Cannon — shaves every higher-scoring opponent", () => {
  it("applies the 10% shave to two higher-scoring opponents", () => {
    const m = make(3);
    m.state.players[0].bay = [{ id: "FlakCannon" }];
    m.state.players[1].score = 999;
    m.state.players[2].score = 999;
    m.submitWord("p1", "cat"); // p1's turn ends → Flak fires at p2 and p3
    expect(m.current.id).toBe("p2");
    expect(m.state.clockTotal).toBe(18); // p2 arms now: 20 − 10%
    expect(m.services.timePenalty.peek("p3")).toBe(2); // p3's shave still queued
  });
});
