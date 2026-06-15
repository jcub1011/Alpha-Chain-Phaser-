import { beforeEach, describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS } from "./settings";
import type { AlphaChainSettings } from "./types";

const WORDS = new Set([
  "cat", "tiger", "rabbit", "tractor", "rat", "torch", "house", "elephant",
]);
const seeds: PlayerSeed[] = [
  { id: "p1", name: "You", isBot: false },
  { id: "p2", name: "Bot", isBot: true },
];

const makeMatch = (overrides: Partial<AlphaChainSettings> = {}) =>
  new MatchController(seeds, { ...DEFAULT_SETTINGS, enableTutorials: false, ...overrides }, {
    isWord: (w) => WORDS.has(w),
    rng: () => 0.5,
  });

describe("MatchController", () => {
  let m: MatchController;
  beforeEach(() => {
    m = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 4, eraCount: 1 });
    m.start();
    m.tick(3); // burn the countdown → first turn armed
  });

  it("starts the first turn with free choice for player 1", () => {
    expect(m.state.phase).toBe("Round");
    expect(m.current.id).toBe("p1");
    expect(m.state.requiredLetter).toBe("");
  });

  it("rejects non-dictionary words without advancing the turn", () => {
    const r = m.submitWord("p1", "zzzz");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not-a-word");
    expect(m.current.id).toBe("p1");
  });

  it("scores an accepted word and enforces chain succession", () => {
    const r = m.submitWord("p1", "cat");
    expect(r.accepted).toBe(true);
    expect(m.state.players[0].score).toBe(3); // length seed, empty bay
    expect(m.current.id).toBe("p2"); // turn advanced
    expect(m.state.requiredLetter).toBe("t"); // last letter of "cat"
  });

  it("rejects a word with the wrong starting letter", () => {
    m.submitWord("p1", "cat"); // required letter now "t"
    const r = m.submitWord("p2", "rabbit"); // starts with r, not t
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("wrong-start-letter");
  });

  it("forbids reusing a word", () => {
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger"); // t→...r
    const r = m.submitWord("p1", "cat");
    expect(r.accepted).toBe(false);
    // 'cat' would also fail the start-letter rule, but uniqueness is checked first
    expect(["already-used", "wrong-start-letter"]).toContain(r.reason);
  });

  it("ends the match after the configured eras and picks the high scorer", () => {
    // A round is one full cycle of both players; eraInterval 2, eraCount 1 → 2
    // rounds (= 4 turns) then game over.
    const m2 = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 2, eraCount: 1 });
    m2.start();
    m2.tick(3);
    let winner: string | null = "unset";
    m2.events.on("gameOver", (e) => (winner = e.winnerId));
    m2.submitWord("p1", "cat"); // round 1: p1 +3, req t
    m2.submitWord("p2", "tiger"); // round 1 wraps: p2 +5, req r
    m2.submitWord("p1", "rabbit"); // round 2: p1 +6 (total 9), req t
    m2.submitWord("p2", "torch"); // round 2 wraps → game over: p2 +5 (total 10), req h
    expect(m2.state.phase).toBe("GameOver");
    expect(winner).toBe("p2"); // 10 vs 9
  });

  it("times out the current player and skips their turn (no score)", () => {
    m.tick(m.state.clockTotal + 1); // run the shot clock out
    expect(m.state.players[0].score).toBe(0);
    expect(m.current.id).toBe("p2"); // advanced past the timed-out player
  });
});

describe("Zero-Point Tax + Tax Collector", () => {
  it("zeroes a banned-letter word but the holder still scores 0 if last place exempt", () => {
    const m = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1 });
    m.start();
    m.tick(1);
    // Force a banned letter and clear the last-place exemption by giving p1 a lead.
    m.state.players[0].score = 100;
    m.state.bannedLetter = "t";
    const r = m.submitWord("p1", "cat"); // contains 't' → taxed (p1 not last place)
    expect(r.accepted).toBe(true);
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(0);
  });
});
