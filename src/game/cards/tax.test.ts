import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

const WORDS = new Set([
  "cat", "tiger", "apple", "banana", "table", "rat", "torch", "art", "ant",
  "tap", "monster", "carrot",
]);

const two: PlayerSeed[] = [
  { id: "p1", name: "P1", isBot: false },
  { id: "p2", name: "P2", isBot: false },
];
const one: PlayerSeed[] = [{ id: "p1", name: "P1", isBot: false }];

const make = (seeds: PlayerSeed[], overrides: Partial<AlphaChainSettings> = {}) => {
  const m = new MatchController(
    seeds,
    { ...DEFAULT_SETTINGS, enableTutorials: false, preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1, ...overrides },
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

describe("Tax Write-Off — first-letter salvage", () => {
  it("adds the first letter's clean score on top of a taxed word", () => {
    const m = make(two);
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100;
    m.state.players[0].bay = [{ id: "TaxWriteOff" }];
    const r = m.submitWord("p1", "cat"); // taxed → 0, salvage "c" (len 1) → +1
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(1);
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

describe("The Prism — refills the clock on a typo (once per era)", () => {
  it("resets the shot clock to full on a failed word", () => {
    const m = make(one);
    m.state.players[0].bay = [{ id: "Prism" }];
    m.tick(5); // burn 5s of the clock
    expect(m.state.clockRemaining).toBeLessThan(m.state.clockTotal);
    const r = m.submitWord("p1", "zzz"); // not a word
    expect(r.reason).toBe("not-a-word");
    expect(m.state.clockRemaining).toBe(m.state.clockTotal); // Prism refilled
  });
});
