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
    {
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
      shotClockSeconds: 20,
      ...overrides,
    },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );
  m.start();
  m.tick(1);
  return m;
};

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

describe("Loan Shark — banks 15% of an opponent's big word", () => {
  it("skims a word scoring over 30", () => {
    const m = make();
    m.state.players[0].bay = [
      { id: "TheAnchor" },
      { id: "TheAnchor" },
      { id: "TheAnchor" },
      { id: "Redline" },
    ];
    m.state.players[1].bay = [{ id: "LoanShark" }];
    m.submitWord("p1", "cat"); // (3 +10+10+10) ×2 = 66 → 15% = 9.9 → 10 banked by p2
    expect(m.state.players[1].score).toBe(10);
  });

  it("ignores a word scoring 30 or less", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TheAnchor" }];
    m.state.players[1].bay = [{ id: "LoanShark" }];
    m.submitWord("p1", "cat"); // 13 ≤ 30 → nothing banked
    expect(m.state.players[1].score).toBe(0);
  });

  it("only banks when the victim is ahead of the owner on the leaderboard", () => {
    const m = make();
    m.state.players[0].bay = [
      { id: "TheAnchor" },
      { id: "TheAnchor" },
      { id: "TheAnchor" },
      { id: "Redline" },
    ];
    m.state.players[1].bay = [{ id: "LoanShark" }];
    m.state.players[1].score = 999; // owner (p2) is far ahead of the submitter (p1)
    m.submitWord("p1", "cat"); // p1 scores 66 but stays behind p2 → nothing banked
    expect(m.state.players[1].score).toBe(999);
  });
});

describe("Blind Sniper — shaves 20% off the overall leader's next clock", () => {
  it("shaves the leader when the leader is an opponent above its owner", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TheSniper" }];
    m.state.players[1].score = 999;
    m.submitWord("p1", "cat"); // p1 turn ends → Sniper shaves the leader (p2), who arms next
    expect(m.current.id).toBe("p2");
    expect(m.state.clockTotal).toBe(16); // 20 − 20%
  });

  it("shaves its own clock when its owner is the leader (anti-snowball)", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TheSniper" }];
    m.state.players[0].score = 999; // p1 is (and stays) the leader after scoring
    m.submitWord("p1", "cat"); // p1 turn ends → Sniper targets the leader = p1 itself
    expect(m.services.timePenalty.peek("p1")).toBeGreaterThan(0);
  });
});
