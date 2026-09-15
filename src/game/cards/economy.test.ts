import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../match";
import { DEFAULT_SETTINGS } from "../settings";
import type { AlphaChainSettings } from "../types";
import { CardBanService } from "./roomServices";

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

describe("Chrono Syphon — banks elapsed seconds (pure elapsed, capped)", () => {
  it("banks +1 per whole second taken, so a normal submit pays elapsed time", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    m.tick(5); // 5s of p1's 20s clock burned → 5s elapsed
    const elapsed = Math.floor(m.state.clockTotal - m.state.clockRemaining);
    expect(elapsed).toBe(5);
    m.submitWord("p1", "cat");
    expect(m.state.players[1].score).toBe(5); // +1 per whole second taken
  });

  it("an instant submit pays nothing — fast play denies the card", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    m.submitWord("p1", "cat"); // straight off the armed clock, 0s elapsed
    expect(m.state.players[1].score).toBe(0);
  });

  it("banks the full elapsed time on a long stall, up to the cap", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    m.tick(15); // 15s elapsed → min(30, 15) = 15
    m.submitWord("p1", "cat");
    expect(m.state.players[1].score).toBe(15);
  });

  it("caps a magnified full-clock stall at 30", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "MagnifyingGlass" }, { id: "ChronoSyphon" }];
    m.state.clockRemaining = 0; // 20s elapsed without tripping the timeout path
    m.submitWord("p1", "cat");
    expect(m.state.players[1].score).toBe(30); // min(30, 20) × 1.5
  });

  it("still collects on a real timeout — stalling out costs the victim", () => {
    const m = make();
    m.state.players[1].bay = [{ id: "ChronoSyphon" }];
    let submission: import("../types").Submission | undefined;
    m.events.on("submission", ({ submission: s }) => (submission = s));
    m.tick(m.state.clockTotal + 1); // no draft → a real timeout
    expect(m.state.players[0].score).toBe(-10); // base timeout penalty
    expect(m.state.players[1].score).toBe(20); // timeout bounty = min(30, 20s clock)
    expect(submission?.timedOut).toBe(true);
    expect(submission?.taxBounty).toBe(20);
    expect(submission?.siphonedBy).toContain("p2");
  });
});

describe("The Toll Booth — tolls opponents who use the owner's banned letter", () => {
  it("banks 20% of an opponent's earned score when their word uses the toll letter", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TollBooth" }];
    m.services.cardBan.roll("p1", 0, "TollBooth", "z");
    // Make it p2's turn with a free choice.
    m.state.currentPlayerIndex = 1;
    m.state.requiredLetter = "";
    m.submitWord("p2", "zebra"); // earns 5, contains the toll letter 'z'
    expect(m.state.players[0].score).toBe(1); // floor(5 × 0.2) = 1
  });
});

describe("The Roulette Wheel", () => {
  it("rewards ×2 on a clean word", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "RouletteWheel" }];
    const r = m.submitWord("p1", "cat"); // 3 × 2 = 6
    expect(r.submission!.score).toBe(6);
  });

  it("rolls a personal banned letter at era start (dodging the era letter)", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "RouletteWheel" }];
    m.applySniperBanAndAdvance("a"); // sets era ban 'a', fires OnEraStart
    const bans = m.services.cardBan.bansFor("p1");
    expect(bans.length).toBe(1);
    expect(bans[0]).not.toBe("a");
  });

  it("two Roulette Wheels each roll their own personal ban (one per instance)", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "RouletteWheel" }, { id: "RouletteWheel" }];
    m.applySniperBanAndAdvance("a"); // fires OnEraStart for each instance
    // Two entries (keyed by slot index), not one collapsed by card id.
    const entries = m.services.cardBan.entriesFor("p1");
    expect(entries.length).toBe(2);
    for (const e of entries) expect(e.letter).not.toBe("a");
  });
});

describe("CardBanService — a personal ban per card instance", () => {
  it("keeps a separate ban per slot and overwrites only that slot", () => {
    const svc = new CardBanService();
    svc.roll("p1", 0, "TollBooth", "z");
    svc.roll("p1", 1, "TollBooth", "q");
    expect(svc.entriesFor("p1")).toEqual([
      { cardId: "TollBooth", letter: "z" },
      { cardId: "TollBooth", letter: "q" },
    ]);
    expect(svc.bansFor("p1").sort()).toEqual(["q", "z"]);
    expect(svc.letterFor("p1", 0)).toBe("z");
    expect(svc.letterFor("p1", 1)).toBe("q");
    svc.roll("p1", 0, "TollBooth", "x"); // overwrites slot 0 only
    expect(svc.letterFor("p1", 0)).toBe("x");
    expect(svc.letterFor("p1", 1)).toBe("q");
  });
});

describe("Duplicate Toll Booths — each tolls its own letter", () => {
  it("tolls on the second booth's letter, proving per-instance lookup", () => {
    const m = make();
    m.state.players[0].bay = [{ id: "TollBooth" }, { id: "TollBooth" }];
    m.services.cardBan.roll("p1", 0, "TollBooth", "z"); // slot-0 booth
    m.services.cardBan.roll("p1", 1, "TollBooth", "p"); // slot-1 booth
    m.state.players[0].score = 0;
    m.state.bannedLetter = ""; // keep p2's word clean (no era tax)
    m.state.currentPlayerIndex = 1; // p2's turn, free choice
    m.state.requiredLetter = "";
    const r = m.submitWord("p2", "apple"); // contains 'p' (slot-1) but not 'z'
    expect(r.submission!.taxed).toBe(false);
    expect(r.submission!.taxBounty).toBeGreaterThan(0);
    expect(m.state.players[0].score).toBe(r.submission!.taxBounty);
  });
});
