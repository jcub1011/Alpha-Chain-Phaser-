import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

const WORDS = new Set(["cat", "tiger", "rat", "art", "torch", "ratio", "tap", "apple"]);
const two: PlayerSeed[] = [
  { id: "p1", name: "P1", isBot: false },
  { id: "p2", name: "P2", isBot: false },
];

const make = (overrides: Partial<AlphaChainSettings> = {}) => {
  const m = new MatchController(
    two,
    { ...DEFAULT_SETTINGS, preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1, shotClockSeconds: 20, ...overrides },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );
  m.start();
  m.tick(1);
  return m;
};

describe("Flak Cannon — shaves higher-scoring opponents' next clock", () => {
  it("shaves 10% off a higher-scoring opponent's next clock", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "FlakCannon" }];
    m.state.players[1].score = 999; // p2 is higher than p1
    m.submitWord("p1", "cat"); // p1's turn ends → Flak fires at p2, whose turn now arms
    expect(m.current.id).toBe("p2");
    // p2's 20s armed clock minus the 10% (2s) shave = 18.
    expect(m.state.clockTotal).toBe(18);
  });
});

describe("Bait & Switch — curses the next player on a taxed word", () => {
  it("hijack-bans the next player with the offending letter", () => {
    const m = make();
    m.state.bannedLetter = "t";
    m.state.players[0].score = 100; // not last → era ban taxes p1
    m.state.players[0].bay = [{ id: "BaitAndSwitch" }];
    m.submitWord("p1", "cat"); // taxed by 't' → curse next player (p2) with 't'
    expect(m.services.hijackBan.peek("p2")).toBe("t");
  });
});

describe("The Titanium Mirror — reflects an attack and decays", () => {
  it("reflects a Flak Cannon shave back at the caster and decays the shield", () => {
    const m = make();
    // p1 holds Flak Cannon, p2 holds the Mirror and is scoring higher.
    m.state.players[0].bay = [{ id: "FlakCannon" }];
    m.state.players[1].bay = [{ id: "TitaniumMirror" }];
    m.services.shield.grantFresh("p2");
    m.state.players[1].score = 999;
    m.submitWord("p1", "cat"); // Flak targets p2 → Mirror reflects onto p1
    expect(m.services.timePenalty.peek("p2")).toBe(0); // blocked
    expect(m.services.timePenalty.peek("p1")).toBeGreaterThan(0); // reflected to caster
    expect(m.services.shield.getMultiplier("p2")).toBeCloseTo(0.9); // decayed 0.1
  });
});

describe("The Bounty Hunter — docks the round leader on a short word", () => {
  it("drains 15 from the leader when they play a sub-6-letter word", () => {
    const m = make();
    // p1 is the round leader (marked at round start, when scores were all 0 → first
    // active player). p2 holds the Bounty Hunter; p1 then plays a short word.
    m.state.players[1].bay = [{ id: "BountyHunter" }];
    expect(m.computeLeaderId()).toBe("p1");
    m.submitWord("p1", "cat"); // scores 3, then docked 15 as the short-word leader
    expect(m.state.players[0].score).toBe(3 - 15);
  });
});
