import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

const WORDS = new Set([
  "cat",
  "tiger",
  "apple",
  "banana",
  "table",
  "rat",
  "torch",
  "art",
  "ant",
  "tap",
  "monster",
  "carrot",
]);

const two: PlayerSeed[] = [
  { id: "p1", name: "P1", isBot: false },
  { id: "p2", name: "P2", isBot: false },
];
const one: PlayerSeed[] = [{ id: "p1", name: "P1", isBot: false }];

const make = (seeds: PlayerSeed[], overrides: Partial<AlphaChainSettings> = {}) => {
  const m = new MatchController(
    seeds,
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
  m.tick(1); // burn countdown → p1's turn armed, free choice
  return m;
};

describe("Slow Burn — word legality tax", () => {
  it("taxes a word shorter than 6 letters to 0", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "SlowBurn" }];
    const r = m.submitWord("p1", "cat"); // 3 letters → illegal → taxed
    expect(r.accepted).toBe(true);
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(0);
  });

  it("allows a 6+ letter word untaxed", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "SlowBurn" }];
    const r = m.submitWord("p1", "monster"); // 7 letters → legal
    expect(r.submission!.taxed).toBe(false);
    expect(r.submission!.score).toBeGreaterThan(0);
  });
});

describe("The IRS Agent — suppresses opponents' tax collectors", () => {
  it("zeroes the submitter and denies the opponent's Tax Collector", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100; // p1 not last → not exempt
    m.state.players[0].bay = [{ id: "IrsAgent" }];
    m.state.players[1].bay = [{ id: "TaxCollector" }];
    const r = m.submitWord("p1", "cat"); // contains 't' → taxed
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(0);
    expect(m.state.players[1].score).toBe(0); // collector suppressed
  });

  it("without the IRS Agent, the Tax Collector does collect", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100;
    m.state.players[1].bay = [{ id: "TaxCollector" }];
    const r = m.submitWord("p1", "cat"); // would-be score 3 → half = 2 (round half-up of 1.5)
    expect(r.submission!.taxed).toBe(true);
    expect(m.state.players[1].score).toBe(2);
  });
});

describe("Tax Write-Off — first-half salvage", () => {
  it("adds the first half's clean score on top of a taxed word", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100;
    m.state.players[0].bay = [{ id: "TaxWriteOff" }];
    const r = m.submitWord("p1", "cat"); // taxed → 0, salvage "ca" (ceil(3/2)=2 letters) → +2
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(2);
  });

  it("stacks: N copies salvage the first half N times", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100;
    m.state.players[0].bay = [{ id: "TaxWriteOff" }, { id: "TaxWriteOff" }, { id: "TaxWriteOff" }];
    const r = m.submitWord("p1", "cat"); // taxed → 0, salvage "ca" (len 2) ×3 → +6
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(6);
  });
});

describe("The Wildcard — once-per-era succession bypass", () => {
  it("accepts a chain-breaking word once, then enforces succession again", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "Wildcard" }];
    expect(m.submitWord("p1", "cat").accepted).toBe(true); // free first word → required "t"
    expect(m.submitWord("p1", "apple").accepted).toBe(true); // bypass: 'a' ≠ 't'
    const r = m.submitWord("p1", "rat"); // 'r' ≠ 'e'; wildcard spent this era
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("wrong-start-letter");
  });
});

describe("The Prism — clock refill on timeout / banned letter (once per era)", () => {
  it("stays inert on a plain typo (the clock keeps ticking, charge unspent)", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "Prism" }];
    m.tick(5); // burn 5s of the clock
    const before = m.state.clockRemaining;
    const r = m.submitWord("p1", "zzz"); // not a word
    expect(r.reason).toBe("not-a-word");
    expect(m.state.clockRemaining).toBe(before); // NOT refilled
  });

  it("refills the clock instead of penalising on a shot-clock timeout", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "Prism" }];
    m.tick(m.state.clockTotal + 1); // run the shot clock out → timeout
    expect(m.state.clockRemaining).toBe(m.state.clockTotal); // Prism refilled
    expect(m.state.players[0].score).toBe(0); // no timeout penalty
    // Charge spent: a second timeout this era applies the penalty as normal.
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBeLessThan(0);
  });

  it("does not spend the charge when a valid drafted word auto-submits on a timeout", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "Prism" }];
    m.setDraft("p1", "cat"); // a valid word is queued when the clock runs out
    m.tick(m.state.clockTotal + 1); // clock expires → auto-submits "cat", not a timeout

    expect(m.state.usedWords.has("cat")).toBe(true); // the word actually played
    const scored = m.state.players[0].score;
    expect(scored).toBeGreaterThan(0); // scored normally, no penalty

    // The Prism was untouched — it still rescues a real (draft-less) timeout this era.
    m.tick(m.state.clockTotal + 1);
    expect(m.state.clockRemaining).toBe(m.state.clockTotal); // refilled
    expect(m.state.players[0].score).toBe(scored); // no penalty: the charge fired here

    // And it is now spent: the next timeout penalises as normal.
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBeLessThan(scored);
  });

  it("bails out of a banned-letter word (reject + refill, no tax), once per era", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100; // p1 not last → not exempt
    m.state.players[0].bay = [{ id: "Prism" }];
    m.tick(5); // burn 5s of the clock
    const r = m.submitWord("p1", "cat"); // contains the banned 't'
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("prism-saved");
    expect(m.state.clockRemaining).toBe(m.state.clockTotal); // refilled
    expect(m.state.players[0].score).toBe(100); // not taxed
    // Charge spent: the same banned-letter word is now taxed and accepted.
    const r2 = m.submitWord("p1", "cat");
    expect(r2.accepted).toBe(true);
    expect(r2.submission!.taxed).toBe(true);
  });
});
