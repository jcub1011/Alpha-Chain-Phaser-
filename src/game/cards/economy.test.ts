import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";

const WORDS = new Set(["cat", "tiger", "zebra", "rat", "apple", "torch"]);
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
  m.tick(1);
  return m;
};

describe("Chrono Syphon — banks an opponent's leftover seconds", () => {
  it("an opponent with Chrono Syphon gains the submitter's remaining whole seconds", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    m.tick(5); // 5s of p1's clock burned
    const remaining = Math.floor(m.state.clockRemaining);
    m.submitWord("p1", "cat");
    expect(m.state.players[1].score).toBe(remaining * 2); // +2 per whole second
  });
});

describe("The Toll Booth — tolls opponents who use the owner's banned letter", () => {
  it("banks 20% of an opponent's earned score when their word uses the toll letter", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TollBooth" }];
    m.services.cardBan.roll("p1", "TollBooth", "z");
    // Make it p2's turn with a free choice.
    m.state.currentPlayerIndex = 1;
    m.state.requiredLetter = "";
    m.submitWord("p2", "zebra"); // earns 5, contains the toll letter 'z'
    expect(m.state.players[0].score).toBe(1); // floor(5 × 0.2) = 1
  });
});

describe("The Roulette Wheel", () => {
  it("rewards ×1.75 on a clean word", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "RouletteWheel" }];
    const r = m.submitWord("p1", "cat"); // 3 × 1.75 = 5.25 → 5
    expect(r.submission!.score).toBe(5);
  });

  it("rolls a personal banned letter at era start (dodging the era letter)", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "RouletteWheel" }];
    m.applySniperBanAndAdvance("a"); // sets era ban 'a', fires OnEraStart
    const bans = m.services.cardBan.bansFor("p1");
    expect(bans.length).toBe(1);
    expect(bans[0]).not.toBe("a");
  });
});
