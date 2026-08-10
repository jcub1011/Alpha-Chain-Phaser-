/*
 * Picker mode through the real MatchController — Offer generation per turn, the two-stage
 * select/commit, and the timeout rules that differ from Classic (no point penalty, Survival keyed
 * on the no-show, the Prism still rescuing a poisoned pick).
 *
 * Separate from match.test.ts, in the `forgery.match.test.ts` idiom: those cases all drive Classic,
 * and interleaving two modes in one harness is how a "Classic unregressed" assertion quietly stops
 * testing Classic.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Dictionary } from "./dictionary";
import { MatchController, type PlayerSeed } from "./match";
import { dictionaryWordPool } from "./picker/wordPool";
import { serializeState, deserializeState } from "../net/serialize";
import { DEFAULT_SETTINGS } from "./settings";
import { GameMode } from "./types";
import type { AlphaChainSettings } from "./types";

/** The real shipped Reduced pool: an Offer drawn from a toy fixture exercises the fallback rungs
 *  rather than the normal path, which is not what most of these cases are about. */
const REDUCED = readFileSync(
  path.resolve(__dirname, "../../public/assets/words-common.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .map((w) => w.trim())
  .filter(Boolean);

const seeds: PlayerSeed[] = [
  { id: "p1", name: "You", isBot: false },
  { id: "p2", name: "Bot", isBot: true },
];

const seeds3: PlayerSeed[] = [...seeds, { id: "p3", name: "Bot2", isBot: true }];

/** A Picker match over `words`, with the pool and the validator agreeing (the shipped invariant:
 *  words-common.txt is a strict subset of words.txt, so isWord always accepts an offered word). */
function makePicker(
  overrides: Partial<AlphaChainSettings> = {},
  words: string[] = REDUCED,
  roster: PlayerSeed[] = seeds,
): MatchController {
  const dict = new Dictionary(words);
  return new MatchController(
    roster,
    {
      ...DEFAULT_SETTINGS,
      gameMode: GameMode.Picker,
      enableTutorials: false,
      preRoundCountdownSeconds: 3,
      eraInterval: 4,
      eraCount: 1,
      ...overrides,
    },
    { isWord: (w) => dict.has(w), rng: () => 0.5, wordPool: dictionaryWordPool(dict) },
  );
}

/** Start and burn the countdown so the first turn is armed. */
function started(m: MatchController): MatchController {
  m.start();
  m.tick(3);
  return m;
}

/** The most recent submission, and its word. `Array.prototype.at` is outside this project's
 *  compile target, so index arithmetic it is. */
function lastSub(m: MatchController) {
  return m.state.history[m.state.history.length - 1];
}
function lastWord(m: MatchController): string | undefined {
  return lastSub(m)?.word;
}

/** Run the shot clock out on the current turn. */
function runClockOut(m: MatchController): void {
  m.tick(m.state.clockTotal + 0.1);
}

describe("picker — the Offer", () => {
  let m: MatchController;
  beforeEach(() => {
    m = started(makePicker());
  });

  it("serves a full Offer on the first armed turn", () => {
    expect(m.state.phase).toBe("Round");
    expect(m.state.offer.length).toBe(DEFAULT_SETTINGS.offerCount);
    expect(new Set(m.state.offer).size).toBe(m.state.offer.length);
  });

  it("honours the Succession letter after the first word", () => {
    const first = m.state.offer[0];
    m.commitSelection("p1", first);
    const required = first[first.length - 1];
    // Either the required letter is honoured, or it was cleared (banned-letter tail / a dead
    // letter the generator had to free) — never a mismatch.
    if (m.state.requiredLetter !== "") {
      expect(m.state.requiredLetter).toBe(required);
      for (const w of m.state.offer) expect(w[0]).toBe(required);
    }
  });

  it("regenerates the Offer every turn", () => {
    const first = [...m.state.offer];
    m.commitSelection("p1", first[0]);
    expect(m.current.id).toBe("p2");
    expect(m.state.offer).not.toEqual(first);
    expect(m.state.offer.length).toBe(DEFAULT_SETTINGS.offerCount);
  });

  it("never offers a word already played", () => {
    const played: string[] = [];
    for (let turn = 0; turn < 6 && m.state.phase === "Round"; turn++) {
      for (const w of m.state.offer) expect(played).not.toContain(w);
      const pick = m.state.offer[0];
      if (!pick) break;
      played.push(pick);
      m.commitSelection(m.current.id, pick);
    }
    expect(played.length).toBeGreaterThan(3);
  });

  it("only offers words the validator accepts", () => {
    // The packaging invariant, seen from the engine: an offered word must never be rejected as
    // "not-a-word" when committed.
    for (let turn = 0; turn < 8 && m.state.phase === "Round"; turn++) {
      const pick = m.state.offer[0];
      if (!pick) break;
      const r = m.commitSelection(m.current.id, pick);
      expect(r.reason).not.toBe("not-a-word");
    }
  });

  it("arms the Picker clock, not Classic's", () => {
    const m2 = started(makePicker({ shotClockSeconds: 20, pickerShotClockSeconds: 40 }));
    expect(m2.state.clockTotal).toBe(40);
  });

  it("clears the Offer at game over", () => {
    const m2 = started(makePicker({ eraInterval: 1, eraCount: 1 }));
    for (let i = 0; i < 12 && m2.state.phase !== "GameOver"; i++) {
      const pick = m2.state.offer[0];
      if (pick) m2.commitSelection(m2.current.id, pick);
      else runClockOut(m2);
      m2.tick(5); // clear any settle window
    }
    expect(m2.state.phase).toBe("GameOver");
    expect(m2.state.offer).toEqual([]);
  });

  it("survives the wire round-trip with no serialize.ts handling", () => {
    const wire = serializeState(m.state);
    const back = deserializeState(JSON.parse(JSON.stringify(wire)));
    expect(back.offer).toEqual(m.state.offer);
  });
});

describe("picker — select and commit", () => {
  let m: MatchController;
  beforeEach(() => {
    m = started(makePicker());
  });

  it("rejects a word that is not on offer", () => {
    const rejects: string[] = [];
    m.events.on("rejected", ({ reason }) => rejects.push(reason));
    // "banana" is a perfectly legal word; the point is that legality is not enough.
    const r = m.commitSelection("p1", "banana");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not-offered");
    expect(rejects).toEqual(["not-offered"]);
    expect(m.current.id).toBe("p1"); // turn did not advance
  });

  it("refuses an off-turn commit silently — no event, no state change", () => {
    const events: string[] = [];
    m.events.on("rejected", ({ reason }) => events.push(reason));
    const r = m.commitSelection("p2", m.state.offer[0]);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBeUndefined();
    expect(events).toEqual([]); // a null-returning intent cannot make the server fan out state
    expect(m.current.id).toBe("p1");
  });

  it("commits the streamed selection when called with no argument", () => {
    const chosen = m.state.offer[2];
    m.setSelection("p1", chosen);
    const r = m.commitSelection("p1");
    expect(r.accepted).toBe(true);
    expect(r.submission?.word).toBe(chosen);
  });

  it("ignores a selection that is not on offer", () => {
    m.setSelection("p1", "banana");
    // Nothing was selected, so a bare commit is a no-op rather than committing "banana".
    expect(m.commitSelection("p1").accepted).toBe(false);
    expect(m.current.id).toBe("p1");
  });

  it("ignores an off-turn selection", () => {
    const target = m.state.offer[0];
    m.setSelection("p2", target);
    expect(m.commitSelection("p1").accepted).toBe(false); // p2's selection never landed
  });
});

describe("picker — timeout", () => {
  it("commits the selection with NO point penalty", () => {
    const m = started(makePicker());
    const chosen = m.state.offer[0];
    m.setSelection("p1", chosen);
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    // Classic would apply BASE_TIMEOUT_PENALTY (-10) before any card drain. Picker scores the
    // word normally instead: the clock enforces pace, not punishment.
    expect(p1.score).toBeGreaterThan(0);
    expect(m.state.usedWords.has(chosen)).toBe(true);
    expect(lastWord(m)).toBe(chosen);
    expect(lastSub(m)?.timedOut).toBeUndefined();
  });

  it("commits a random Offer word on a no-show, and still scores it", () => {
    const m = started(makePicker());
    const offered = [...m.state.offer];
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.score).toBeGreaterThan(0);
    expect(offered).toContain(lastWord(m));
  });

  it("does not eliminate a slow picker who did select, in Survival", () => {
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    m.setSelection("p1", m.state.offer[0]);
    runClockOut(m);
    expect(m.state.players.find((p) => p.id === "p1")!.eliminated).toBe(false);
  });

  it("eliminates a no-show in Survival, while the random pick still resolves", () => {
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    const offered = [...m.state.offer];
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(true); // Survival keys on the no-show, not the timeout
    expect(offered).toContain(lastWord(m)); // ...and the chain continued
    expect(m.state.requiredLetter).not.toBe("");
  });

  it("ends the match on the no-show turn when it leaves one player standing", () => {
    /* The ordering test. The elimination has to be visible to endTurn's Survival active-count
     * check — which runs INSIDE submitWord, below the commit — so a deferred flag applied at the
     * top of endTurn is the only place it can go. */
    const m = started(makePicker({ survivalMode: true }));
    m.state.players.find((p) => p.id === "p2")!.eliminated = true;
    runClockOut(m);
    expect(m.state.phase).toBe("GameOver");
  });
});

describe("picker — degenerate pools", () => {
  it("frees an exhausted required letter rather than stalling", () => {
    /* Reachable for real on the Reduced pool, where a single word starts with `x`. Built here so
     * committing "music" sets the required letter to `c` at the exact moment every c-word has
     * already been played — the turn is then literally unplayable, and the generator has to redraw
     * from the whole pool while the engine clears the letter to match.
     *
     * offerCount is set to the number of words left so the Offer provably contains "music",
     * rather than hoping the draw includes it. */
    const words = ["music", "cat", "cog", "cub", "melon", "maple"];
    const m = makePicker({ offerCount: 3 }, words);
    m.start();
    m.state.usedWords.add("cat");
    m.state.usedWords.add("cog");
    m.state.usedWords.add("cub");
    m.tick(3); // arm turn 1 with a free letter → offer is music/melon/maple
    expect(m.state.offer).toContain("music");

    expect(m.commitSelection("p1", "music").accepted).toBe(true);

    // Succession would demand `c`, and there is no unplayed c-word anywhere.
    expect(m.state.requiredLetter).toBe("");
    expect(m.state.offer.length).toBeGreaterThan(0);
    expect(m.state.offer.some((w) => w[0] === "c")).toBe(false);
  });

  it("falls back to Classic when Picker was asked for without a word pool", () => {
    const dict = new Dictionary(["cat", "tiger", "rat"]);
    const m = new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Picker,
        enableTutorials: false,
        preRoundCountdownSeconds: 3,
        shotClockSeconds: 20,
        pickerShotClockSeconds: 40,
      },
      { isWord: (w) => dict.has(w), rng: () => 0.5 },
    );
    started(m);
    expect(m.state.offer).toEqual([]);
    // Crucially the CLOCK falls back too — arming the pick timer for a typing match would be
    // worse than either mode.
    expect(m.state.clockTotal).toBe(20);
    expect(m.submitWord("p1", "cat").accepted).toBe(true); // typed entry still works
  });
});

describe("classic — unregressed by the Picker work", () => {
  const classic = (over: Partial<AlphaChainSettings> = {}): MatchController => {
    const dict = new Dictionary(["cat", "tiger", "rabbit", "rat", "torch", "house"]);
    return new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 3,
        shotClockSeconds: 20,
        ...over,
      },
      { isWord: (w) => dict.has(w), rng: () => 0.5 },
    );
  };

  it("keeps the Offer empty and the typed pipeline intact", () => {
    const m = started(classic());
    expect(m.state.offer).toEqual([]);
    expect(m.state.clockTotal).toBe(20);
    expect(m.submitWord("p1", "cat").accepted).toBe(true);
  });

  it("still applies the timeout point penalty", () => {
    const m = started(classic());
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.score).toBeLessThan(0); // BASE_TIMEOUT_PENALTY still bites
    expect(m.state.history.length).toBe(0); // a timeout is not a submission in Classic
  });

  it("refuses commitSelection outright", () => {
    const m = started(classic());
    expect(m.commitSelection("p1", "cat").accepted).toBe(false);
    expect(m.state.usedWords.size).toBe(0);
  });
});
