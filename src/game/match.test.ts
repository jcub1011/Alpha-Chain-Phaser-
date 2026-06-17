import { beforeEach, describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS } from "./settings";
import type { AlphaChainSettings } from "./types";

const WORDS = new Set(["cat", "tiger", "rabbit", "tractor", "rat", "torch", "house", "elephant"]);
const seeds: PlayerSeed[] = [
  { id: "p1", name: "You", isBot: false },
  { id: "p2", name: "Bot", isBot: true },
];

const makeMatch = (overrides: Partial<AlphaChainSettings> = {}) =>
  new MatchController(
    seeds,
    { ...DEFAULT_SETTINGS, enableTutorials: false, ...overrides },
    {
      isWord: (w) => WORDS.has(w),
      rng: () => 0.5,
    },
  );

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
    m2.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
    expect(m2.state.phase).toBe("GameOver");
    expect(winner).toBe("p2"); // 10 vs 9
  });

  it("opens each new era on a wildcard starting letter (not the carry-over)", () => {
    // eraInterval 1 → one full round (both players) ends era 1.
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 2 });
    m2.start();
    m2.tick(1); // era 1, p1 free choice
    m2.submitWord("p1", "cat"); // required letter → "t"
    m2.submitWord("p2", "tiger"); // wraps era 1 → intermission; word ends in "r"
    m2.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
    expect(m2.state.phase).toBe("Intermission");
    m2.applySniperBanAndAdvance("r"); // ban "r" for era 2, roll into the countdown
    m2.tick(1); // burn the era-2 countdown → beginEra
    expect(m2.state.phase).toBe("Round");
    expect(m2.state.era).toBe(2);
    // Free start: the opener is NOT forced onto "r" (which is now the ban) by the
    // previous era's carry-over.
    expect(m2.state.requiredLetter).toBe("");
  });

  it("keeps the engine order and drops the discard bin on optimize", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger"); // wraps era 1 → intermission
    m2.tick(2.001); // burn the era-end settle window into the optimize sub-phase
    expect(m2.state.phase).toBe("Intermission");
    expect(m2.state.intermissionPhase).toBe("optimize");

    const p1 = m2.state.players[0];
    p1.slots = 2;
    p1.bay = [{ id: "A" }, { id: "B" }, { id: "C" }];
    // Engine [C, A] in that order, B parked in the discard bin. The full set is
    // retained (with flags) so the player can keep rearranging during optimize.
    m2.setPlayerBay("p1", ["C", "A"], ["B"]);
    expect(p1.bay.map((b) => b.id)).toEqual(["C", "A", "B"]);
    expect(p1.bay.map((b) => !!b.discarded)).toEqual([false, false, true]);

    // Completing optimize drops the discarded card, keeping the engine order.
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["C", "A"]);
  });

  it("lets a player keep fewer cards than their slot capacity", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger");
    m2.tick(2.001);

    const p1 = m2.state.players[0];
    p1.slots = 3;
    p1.bay = [{ id: "A" }, { id: "B" }, { id: "C" }];
    m2.setPlayerBay("p1", ["B"], ["A", "C"]); // keep only one, discard the rest
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["B"]);
  });

  it("falls back to trimming the first slots when the player never edits", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger");
    m2.tick(2.001);

    const p1 = m2.state.players[0];
    p1.slots = 2;
    p1.bay = [{ id: "A" }, { id: "B" }, { id: "C" }]; // no setPlayerBay → no flags
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["A", "B"]);
  });

  it("times out the current player and skips their turn (no score)", () => {
    m.tick(m.state.clockTotal + 1); // run the shot clock out
    expect(m.state.players[0].score).toBe(0);
    expect(m.current.id).toBe("p2"); // advanced past the timed-out player
  });

  it("auto-submits the current player's drafted word when the shot clock times out", () => {
    m.setDraft("p1", "cat"); // streamed in as the player types
    m.tick(m.state.clockTotal + 1); // run the shot clock out
    expect(m.state.players[0].score).toBe(3); // "cat" was auto-submitted, not lost
    expect(m.current.id).toBe("p2"); // turn advanced via submission
    expect(m.state.requiredLetter).toBe("t");
  });

  it("times out (no score) when the drafted word is illegal", () => {
    m.setDraft("p1", "zzzz"); // not a dictionary word
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBe(0); // bad draft falls through to a normal timeout
    expect(m.current.id).toBe("p2");
  });

  it("ignores a draft from a player whose turn it is not", () => {
    m.setDraft("p2", "cat"); // p2 is not the current player
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBe(0); // p1's timeout must not submit p2's draft
    expect(m.current.id).toBe("p2");
  });

  it("returns an empty id (rather than throwing) when no active players remain", () => {
    // Defensive: the FSM guards this via gameOver(), but computeLastPlaceId must
    // not index into an empty active set if it is ever called bare.
    m.state.players.forEach((p) => (p.eliminated = true));
    expect(() => m.computeLastPlaceId()).not.toThrow();
    expect(m.computeLastPlaceId()).toBe("");
  });
});

describe("turn order shuffles every era", () => {
  const threeSeeds: PlayerSeed[] = [
    { id: "p1", name: "P1", isBot: false },
    { id: "p2", name: "P2", isBot: true },
    { id: "p3", name: "P3", isBot: true },
  ];
  // Fisher-Yates with rng 0.5 over [p1,p2,p3]: i=2 swaps idx2↔idx1 → [p1,p3,p2];
  // i=1 is a no-op. So the shuffled order is deterministic for this RNG.
  const makeThree = (rng: () => number) =>
    new MatchController(
      threeSeeds,
      { ...DEFAULT_SETTINGS, enableTutorials: false, preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1 },
      { isWord: (w) => WORDS.has(w), rng },
    );

  it("reorders the players and opens on the first live player of the shuffle", () => {
    const m = makeThree(() => 0.5);
    m.start();
    m.tick(1); // burn countdown → beginEra shuffles, then arms the opener
    expect(m.state.players.map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    expect(m.state.currentPlayerIndex).toBe(0);
    expect(m.current.id).toBe("p1");
  });

  it("skips an eliminated player when picking the era opener", () => {
    const m = makeThree(() => 0.5);
    // Eliminate p1 before the era-1 shuffle. With rng 0.5 the order becomes
    // [p1(dead), p3, p2], so the opener must skip seat 0 to the first live player.
    m.state.players.find((p) => p.id === "p1")!.eliminated = true;
    m.start();
    m.tick(1);
    expect(m.state.currentPlayerIndex).toBe(1);
    expect(m.current.id).toBe("p3");
    expect(m.current.eliminated).toBe(false);
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
