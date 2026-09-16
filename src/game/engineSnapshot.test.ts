// Engine snapshots: every submission freezes the bay order, glass
// magnification and streak/guard states as they scored, so replays and the
// word history play back what happened instead of today's bay.
import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS } from "./settings";
import { GameMode } from "./types";
import { serializeState, deserializeState } from "../net/serialize";

const WORDS = new Set(["cat", "tiger", "rabbit", "torch", "rat"]);
const seeds: PlayerSeed[] = [
  { id: "p1", name: "You", isBot: false },
  { id: "p2", name: "Dee", isBot: false },
];

const makeMatch = () =>
  new MatchController(
    seeds,
    { ...DEFAULT_SETTINGS, gameMode: GameMode.Classic, enableTutorials: false },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );

const startRound = (m: MatchController): void => {
  m.start();
  m.tick(99); // burn countdown + arm first turn (large tick is fine pre-round)
};

describe("engine snapshots", () => {
  it("freezes bay order, magnification and the pre-increment streak on a word", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["MagnifyingGlass", "Crescendo", "Vanilla"]);

    const res = m.submitWord("p1", "cat");
    expect(res.accepted).toBe(true);
    const eng = res.submission!.engine!;
    expect(eng.bay.map((s) => s.id)).toEqual(["MagnifyingGlass", "Crescendo", "Vanilla"]);
    // The glass sits left of Crescendo: ×1.5 frozen on that slot only.
    expect(eng.bay[0]!.magnification).toBe(1);
    expect(eng.bay[1]!.magnification).toBe(1.5);
    expect(eng.bay[2]!.magnification).toBe(1);
    // First clean word: the streak folds on 0, the increment lands after.
    expect(eng.streak).toBe(0);
    expect(m.liveStateFor("p1").streak).toBe(1);
    expect(m.state.players.find((p) => p.id === "p1")!.liveState!.streak).toBe(1);
  });

  it("sees the running streak on the next clean word", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["Crescendo"]);
    m.benchSetBay("p2", ["Vanilla"]);

    m.submitWord("p1", "cat"); // free → ends "t"
    const res = m.submitWord("p2", "tiger"); // starts "t" → ends "r"
    expect(res.accepted).toBe(true);
    expect(res.submission!.engine!.streak).toBe(0); // p2's own streak
    const p1 = m.submitWord("p1", "rabbit"); // starts "r"
    expect(p1.accepted).toBe(true);
    expect(p1.submission!.engine!.streak).toBe(1);
  });

  it("marks the word that spent the Wildcard charge", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["Wildcard", "Vanilla"]);
    m.submitWord("p1", "cat"); // free letter, ends "t" — next word must start "t"

    // p2 plays elsewhere; p1 then breaks succession via Wildcard.
    m.submitWord("p2", "torch"); // starts "t", ends "h" → p1 needs "h"
    const res = m.submitWord("p1", "rabbit"); // "r" ≠ "h" → wildcard bypass
    expect(res.accepted).toBe(true);
    const eng = res.submission!.engine!;
    expect(eng.wildcardUsed).toBe(true);
    expect(eng.wildcardAvailable).toBe(true); // available AS IT SCORED
    expect(m.liveStateFor("p1").wildcardAvailable).toBe(false); // spent after
  });

  it("survives a later bay reorder (frozen order wins)", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["Vanilla", "Crescendo"]);
    m.submitWord("p1", "cat");

    const p1 = m.state.players.find((p) => p.id === "p1")!;
    const reversed = [...p1.bay].reverse().map((b) => b.uid!);
    m.setPlayerBay("p1", reversed, []);
    expect(p1.bay.map((b) => b.id)).toEqual(["Crescendo", "Vanilla"]);
    // History still plays the scored order.
    expect(m.state.history[0]!.engine!.bay.map((s) => s.id)).toEqual(["Vanilla", "Crescendo"]);
  });

  it("rides the wire round-trip untouched", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["MagnifyingGlass", "Vanilla"]);
    m.submitWord("p1", "cat");

    const wire = serializeState(m.state);
    const back = deserializeState(JSON.parse(JSON.stringify(wire)));
    expect(back.history[0]!.engine!.bay.map((s) => s.id)).toEqual(["MagnifyingGlass", "Vanilla"]);
    expect(back.history[0]!.engine!.bay[1]!.magnification).toBe(1.5);
    expect(back.players.find((p) => p.id === "p1")!.liveState!.streak).toBe(1);
  });

  it("freezes the engine on a real timeout too", () => {
    const m = makeMatch();
    startRound(m);
    m.benchSetBay("p1", ["Crescendo", "Vanilla"]);
    m.submitWord("p1", "cat"); // streak 1, ends "t"

    let timedOut: { timedOut?: boolean; engine?: object } | undefined;
    m.events.on("submission", ({ submission }) => {
      timedOut = submission;
    });
    // p2's turn with an empty draft: run the clock out for a real timeout.
    m.tick(9999);
    expect(timedOut?.timedOut).toBe(true);
    expect(timedOut?.engine).toBeDefined();
  });
});
