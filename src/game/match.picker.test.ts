/*
 * Word Builder mode through the real MatchController — Tile Rack generation per turn, the
 * two-stage stage/commit, and the timeout rules that differ from Classic (no point penalty,
 * Survival keyed on the no-show, the Prism still rescuing a poisoned pick).
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
import { subWordFinder } from "./builder/rack";
import { dictionaryWordPool } from "./picker/wordPool";
import { serializeState, deserializeState } from "../net/serialize";
import { DEFAULT_SETTINGS } from "./settings";
import { GameMode } from "./types";
import type { AlphaChainSettings } from "./types";

/** The real shipped Reduced pool: a rack seeded from a toy fixture exercises the fallback rungs
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

/** The Reduced pool as a lookup, for building a rack string the dictionary provably rejects. */
const REDUCED_SET = new Set(REDUCED.map((w) => w.toLowerCase()));

/** One seat, so every commit re-arms the SAME player — the only way to see a bay set before the
 *  turn arms take effect on that player's own rack. */
const solo: PlayerSeed = { id: "p1", name: "You", isBot: false };

/** A varying rng, for the cases where the constant 0.5 would mask a change. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Word Builder match over `words`, with the pool and the validator agreeing (the shipped
 *  invariant: words-common.txt is a strict subset of words.txt, so isWord always accepts a word
 *  the rack can build). */
function makePicker(
  overrides: Partial<AlphaChainSettings> = {},
  words: string[] = REDUCED,
  roster: PlayerSeed[] = seeds,
  rng: () => number = () => 0.5,
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
    { isWord: (w) => dict.has(w), rng, wordPool: dictionaryWordPool(dict) },
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

/** A string constructible from this turn's Tile Rack that is NOT a word — i.e. what
 *  <ac-word-builder> streams to the engine on every tile tap while you are still mid-build. */
function rackFragment(m: MatchController): string {
  const tiles = m.state.rack;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = 0; j < tiles.length; j++) {
      if (i === j) continue;
      const frag = (tiles[i].text + tiles[j].text).toLowerCase();
      if (!REDUCED_SET.has(frag)) return frag;
    }
  }
  throw new Error("no non-word rack fragment available");
}

/** A word the current Tile Rack can actually build — the Word Builder analogue of "pick offer[0]".
 *  Drawn straight from the engine's own profiler, so a case can commit without guessing. */
function rackWord(m: MatchController, index = 0): string {
  const w = rackWords(m)[index];
  if (!w) throw new Error(`rack has no buildable word at index ${index}`);
  return w;
}

/** Every word the current rack can build, respecting Succession and words already played.
 *  Succession is waived when the rack itself was drawn free of the letter (Wildcard), the same
 *  way the engine's own no-show pick waives it — otherwise a Wildcard turn reads as barren. */
function rackWords(m: MatchController): string[] {
  const pool = m.wordPoolInstance;
  if (!pool || m.state.rack.length === 0) return [];
  const letter = m.successionWaivedThisTurn ? "" : m.state.requiredLetter;
  return subWordFinder(m.state.rack, pool, m.offerIndex, letter, {
    usedWords: m.state.usedWords,
  });
}

describe("word builder — the Tile Rack", () => {
  let m: MatchController;
  beforeEach(() => {
    m = started(makePicker());
  });

  it("serves a full Tile Rack on the first armed turn", () => {
    expect(m.state.phase).toBe("Round");
    expect(m.state.rack.length).toBe(DEFAULT_SETTINGS.rackSize);
    expect(new Set(m.state.rack.map((t) => t.id)).size).toBe(m.state.rack.length);
  });

  it("retires the Offer entirely — the rack is the only surface", () => {
    // Word Builder is the ONLY Picker surface, so `offer` is gone from MatchState outright. That
    // is what makes submitWord's rack-keyed gate airtight: there is no second surface to consult,
    // so no tampered client can commit a word it was dealt no tiles for.
    for (let turn = 0; turn < 4 && m.state.phase === "Round"; turn++) {
      expect("offer" in m.state).toBe(false);
      m.commitSelection(m.current.id, rackWord(m));
    }
  });

  it("honours the Succession letter after the first word", () => {
    const first = rackWord(m);
    m.commitSelection("p1", first);
    const required = first[first.length - 1];
    // Either the required letter is honoured, or it was cleared (banned-letter tail, a dead-end
    // letter the pool cannot support, or an exhausted one) — never a mismatch.
    if (m.state.requiredLetter !== "") {
      expect(m.state.requiredLetter).toBe(required);
      for (const w of rackWords(m)) expect(w[0]).toBe(required);
    }
  });

  it("regenerates the rack every turn", () => {
    const first = m.state.rack.map((t) => t.text).join("|");
    m.commitSelection("p1", rackWord(m));
    expect(m.current.id).toBe("p2");
    expect(m.state.rack.map((t) => t.text).join("|")).not.toEqual(first);
    expect(m.state.rack.length).toBe(DEFAULT_SETTINGS.rackSize);
  });

  it("never yields a buildable word already played", () => {
    const played: string[] = [];
    for (let turn = 0; turn < 6 && m.state.phase === "Round"; turn++) {
      for (const w of rackWords(m)) expect(played).not.toContain(w);
      const words = rackWords(m);
      if (words.length === 0) break;
      played.push(words[0]);
      m.commitSelection(m.current.id, words[0]);
    }
    expect(played.length).toBeGreaterThan(3);
  });

  it("only yields words the validator accepts", () => {
    // The packaging invariant, seen from the engine: a word the rack can build must never be
    // rejected as "not-a-word" when committed.
    for (let turn = 0; turn < 8 && m.state.phase === "Round"; turn++) {
      const words = rackWords(m);
      if (words.length === 0) break;
      const r = m.commitSelection(m.current.id, words[0]);
      expect(r.reason).not.toBe("not-a-word");
    }
  });

  it("always leaves at least one buildable word — no forced timeout", () => {
    /* The Succession dead-end guard. `subWordFinder` only returns words STARTING with the required
     * letter, so before the guard a chain landing on `x` — one word in the whole Reduced list —
     * handed the next player a rack whose only buildable word was the Golden Seed itself: a
     * near-certain timeout on a 25s clock, and an elimination in Survival. */
    const m2 = started(makePicker({}, REDUCED, seeds, mulberry(99)));
    for (let turn = 0; turn < 40 && m2.state.phase === "Round"; turn++) {
      const words = rackWords(m2);
      expect(words.length).toBeGreaterThan(0);
      m2.commitSelection(m2.current.id, words[0]);
      m2.tick(0.001);
    }
  });

  it("arms the Picker clock, not Classic's", () => {
    const m2 = started(makePicker({ shotClockSeconds: 20, pickerShotClockSeconds: 40 }));
    expect(m2.state.clockTotal).toBe(40);
    // The SAME number bots score clock-scaling cards against: one channel, not two.
    expect(m2.baseClockSeconds).toBe(40);
  });

  it("clears the rack at game over", () => {
    const m2 = started(makePicker({ eraInterval: 1, eraCount: 1 }));
    for (let i = 0; i < 12 && m2.state.phase !== "GameOver"; i++) {
      const words = rackWords(m2);
      if (words.length > 0) m2.commitSelection(m2.current.id, words[0]);
      else runClockOut(m2);
      m2.tick(5); // clear any settle window
    }
    expect(m2.state.phase).toBe("GameOver");
    expect(m2.state.rack).toEqual([]);
  });

  it("survives the wire round-trip with no serialize.ts handling", () => {
    const wire = serializeState(m.state);
    const back = deserializeState(JSON.parse(JSON.stringify(wire)));
    expect(back.rack).toEqual(m.state.rack);
  });
});

describe("word builder — stage and commit", () => {
  let m: MatchController;
  beforeEach(() => {
    m = started(makePicker());
  });

  it("rejects a word the rack cannot build", () => {
    const rejects: string[] = [];
    m.events.on("rejected", ({ reason }) => rejects.push(reason));
    // "banana" is a perfectly legal word; the point is that legality is not enough — and the
    // reason must name the real problem, since there is no Offer to "not be on" any more.
    const r = m.commitSelection("p1", "banana");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not-constructible");
    expect(rejects).toEqual(["not-constructible"]);
    expect(m.current.id).toBe("p1"); // turn did not advance
  });

  it("refuses an off-turn commit silently — no event, no state change", () => {
    const events: string[] = [];
    m.events.on("rejected", ({ reason }) => events.push(reason));
    const r = m.commitSelection("p2", rackWord(m));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBeUndefined();
    expect(events).toEqual([]); // a null-returning intent cannot make the server fan out state
    expect(m.current.id).toBe("p1");
  });

  it("commits the streamed selection when called with no argument", () => {
    const chosen = rackWord(m);
    m.setSelection("p1", chosen);
    const r = m.commitSelection("p1");
    expect(r.accepted).toBe(true);
    expect(r.submission?.word).toBe(chosen);
  });

  it("ignores a selection the rack cannot build", () => {
    m.setSelection("p1", "banana");
    // Nothing was selected, so a bare commit is a no-op rather than committing "banana".
    expect(m.commitSelection("p1").accepted).toBe(false);
    expect(m.current.id).toBe("p1");
  });

  it("ignores an off-turn selection", () => {
    const target = rackWord(m);
    m.setSelection("p2", target);
    expect(m.commitSelection("p1").accepted).toBe(false); // p2's selection never landed
  });
});

describe("word builder — timeout", () => {
  it("commits the selection with NO point penalty", () => {
    const m = started(makePicker());
    const chosen = rackWord(m);
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

  it("commits a word built from the player's OWN RACK on a no-show, and still scores it", () => {
    /* The word has to be one they could actually have built from the tiles in front of them.
     * Committing from the retired Offer credited them a word they never saw and had no tiles for,
     * while the tutorial promises "a word is built for you". */
    const m = started(makePicker());
    const buildable = rackWords(m);
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.score).toBeGreaterThan(0);
    expect(buildable).toContain(lastWord(m));
  });

  it("does not eliminate a slow picker who did select, in Survival", () => {
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    m.setSelection("p1", rackWord(m));
    runClockOut(m);
    expect(m.state.players.find((p) => p.id === "p1")!.eliminated).toBe(false);
  });

  it("eliminates a no-show in Survival, while the random pick still resolves", () => {
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    const buildable = rackWords(m);
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(true); // Survival keys on the no-show, not the timeout
    expect(buildable).toContain(lastWord(m)); // ...and the chain continued
  });

  it("eliminates a builder who only ever staged a fragment, in Survival", () => {
    /* The regression. <ac-word-builder> streams a selection on EVERY tile tap, so two tiles that
     * spell nothing used to read as "they picked something" — sparing a Survival player who
     * plainly ran out of clock. Showing up means producing a word the engine ACCEPTS. */
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    m.setSelection("p1", rackFragment(m));
    runClockOut(m);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(true);
    expect(m.state.requiredLetter).not.toBe(""); // ...and the chain still continued on a real word
  });

  it("treats a cleared board as a no-show, even after a valid word was staged", () => {
    /* clearStaging streams "" to mean "I unstaged everything". setSelection used to refuse the
     * empty target, leaving the stale pick to spare the player. */
    const m = started(makePicker({ survivalMode: true }, REDUCED, seeds3));
    m.setSelection("p1", rackWord(m));
    m.setSelection("p1", "");
    runClockOut(m);
    expect(m.state.players.find((p) => p.id === "p1")!.eliminated).toBe(true);
  });

  it("commits a real word rather than a dead turn when the staged fragment is rejected", () => {
    // Survival aside: a rejected fragment must fall through to the same random pick a total
    // no-show gets, not strand the chain on a blank "—" submission.
    const m = started(makePicker());
    const frag = rackFragment(m);
    m.setSelection("p1", frag);
    runClockOut(m);
    expect(lastWord(m)).not.toBe("—");
    expect(lastWord(m)).not.toBe(frag);
    expect(m.state.players.find((p) => p.id === "p1")!.score).toBeGreaterThan(0);
  });

  it("never auto-picks a word that has already been played", () => {
    /* The candidate list has to exclude used words. `submitWord` rejects one at the already-used
     * gate, and the rejection lands on a player whose only sin was timing out: "Already used"
     * flashes at them and the turn resolves as the dead "—" submission with the chain letter
     * unmoved. Every buildable word but one is played here, so an unfiltered pick is a near-certain
     * hit — in a real match the odds simply climb with every word played. */
    const m = started(makePicker({}, REDUCED, [solo], mulberry(11)));
    const buildable = rackWords(m);
    expect(buildable.length).toBeGreaterThan(3);
    const survivor = buildable[buildable.length - 1];
    for (const w of buildable) if (w !== survivor) m.state.usedWords.add(w);

    const rejects: string[] = [];
    m.events.on("rejected", ({ reason }) => rejects.push(reason));
    runClockOut(m);

    expect(rejects).toEqual([]);
    expect(lastWord(m)).toBe(survivor); // the one word left, not the dead "—"
  });

  it("auto-picks from a Wildcard rack, which carries no required letter", () => {
    /* In Word Builder the Wildcard is spent at GENERATION: the rack is drawn free of the required
     * letter while the letter itself stands, since the chain still advances from it. Filtering the
     * auto-pick by that letter searches a rack deliberately built without it — reliably nothing,
     * so the turn died on "—" and the chain stalled on exactly the turn the card was spent. */
    const m = makePicker({}, REDUCED, [solo], mulberry(5));
    m.benchSetBay(solo.id, ["Wildcard"]);
    started(m);
    m.commitSelection(solo.id, rackWord(m)); // era openers are free; turn 2 imposes a letter
    expect(m.state.requiredLetter).not.toBe("");
    expect(m.successionWaivedThisTurn).toBe(true);

    let deadTurns = 0;
    m.events.on("timeout", () => deadTurns++); // only the "—" path emits this in Word Builder
    const buildable = rackWords(m);
    runClockOut(m);

    expect(deadTurns).toBe(0);
    expect(buildable).toContain(lastWord(m));
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

describe("word builder — degenerate pools", () => {
  it("frees an exhausted required letter rather than stalling", () => {
    /* Built so committing "music" sets the required letter to `c` at the exact moment every c-word
     * has already been played — the turn is then literally unseedable, and generateRackForTurn has
     * to redraw from the whole pool while the engine clears the letter to match. Without the
     * rescue the turn arms with the degenerate three-tile fallback rack: a guaranteed timeout. */
    const words = ["music", "cat", "cog", "cub", "melon", "maple"];
    const m = makePicker({}, words);
    m.start();
    m.state.usedWords.add("cat");
    m.state.usedWords.add("cog");
    m.state.usedWords.add("cub");
    m.tick(3); // arm turn 1 with a free letter
    // Hand-build the rack so "music" is provably committable. This case is about what the engine
    // does with the required letter AFTER it lands, not about which seed the generator picked.
    m.state.rack = [..."music"].map((ch, i) => ({ id: `t${i}`, text: ch, isChunk: false }));

    expect(m.commitSelection("p1", "music").accepted).toBe(true);

    // Succession would demand `c`, and there is no unplayed c-word anywhere.
    expect(m.state.requiredLetter).toBe("");
    expect(m.state.rack.length).toBeGreaterThan(0);
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
    expect(m.state.rack).toEqual([]);
    // Crucially the CLOCK falls back too — arming the pick timer for a typing match would be
    // worse than either mode.
    expect(m.state.clockTotal).toBe(20);
    expect(m.baseClockSeconds).toBe(20); // ...and bots score against the same fallback
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

  it("keeps the rack empty and the typed pipeline intact", () => {
    const m = started(classic());
    expect(m.state.rack).toEqual([]);
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

describe("word builder — Winnower", () => {
  /** A solo-roster Word Builder match whose only player holds `ids`, with the rack already drawn
   *  from that bay. Solo because `benchSetBay` does NOT redraw the rack — the bay has to be in
   *  place before the turn arms, and with one seat every commit re-arms the same player. */
  const withBay = (
    ids: string[],
    over: Partial<AlphaChainSettings> = {},
    rng: () => number = () => 0.5,
  ): MatchController => {
    const m = makePicker({ ...over }, REDUCED, [solo], rng);
    m.benchSetBay(solo.id, ids);
    return started(m);
  };

  it("redraws the rack and charges 30% of the ARMED clock", () => {
    // A varying rng: makePicker's default is the constant 0.5, which would redraw the same tiles.
    const m = withBay(["Winnower"], {}, mulberry(7));
    const before = m.state.rack.map((t) => t.text).join("|");
    const total = m.state.clockTotal;
    m.tick(2); // burn a little, so the charge is provably off clockTotal and not off what is left
    const remainingBefore = m.state.clockRemaining;

    expect(m.redrawRack(solo.id)).toBe(true);
    expect(m.state.rack.map((t) => t.text).join("|")).not.toEqual(before);
    expect(m.state.rack.length).toBe(DEFAULT_SETTINGS.rackSize);
    expect(remainingBefore - m.state.clockRemaining).toBeCloseTo(0.3 * total, 5);
  });

  it("is once per TURN, and re-arms on the next one", () => {
    const m = withBay(["Winnower"]);
    expect(m.redrawRack(solo.id)).toBe(true);
    expect(m.redrawRack(solo.id)).toBe(false); // charge spent
    expect(m.state.rackRedrawAvailable).toBe(false);

    m.commitSelection(solo.id, rackWord(m)); // solo roster: the turn comes straight back
    expect(m.canRedrawRack(solo.id)).toBe(true); // fireTurnStarted reset it
  });

  it("does not burn the previous rack's buildable words", () => {
    // They were never played. Marking them used would quietly shrink the pool on every redraw.
    const m = withBay(["Winnower"], {}, mulberry(3));
    const before = rackWords(m);
    m.redrawRack(solo.id);
    for (const w of before) expect(m.state.usedWords.has(w)).toBe(false);
  });

  it("refuses a player with no Winnower", () => {
    const m = withBay(["TheAnchor"]);
    expect(m.canRedrawRack(solo.id)).toBe(false);
    expect(m.redrawRack(solo.id)).toBe(false);
  });

  it("refuses an off-turn player", () => {
    const m = started(makePicker());
    m.benchSetBay(m.current.id, ["Winnower"]);
    const notUp = m.state.players.find((p) => p.id !== m.current.id)!.id;
    expect(m.redrawRack(notUp)).toBe(false);
  });

  it("keeps the Wildcard's free rack across a redraw", () => {
    /* The redraw re-derived wildcard availability, and by then the charge was spent — so the
     * replacement rack came back drawn WITH the required letter while the turn still counted as
     * waived. The player paid 30% of their clock for a rack strictly more constrained than the
     * free one they had just discarded, with the Wildcard already gone.
     *
     * Measured over several RNG seeds because a rack drawn WITH the letter is seeded from a word
     * starting with it and can therefore always build one, whereas a free rack only sometimes
     * can — so "every single redraw is letter-constrained" is the signal, and one lucky draw
     * proves nothing either way. */
    const seeds = [3, 5, 7, 11, 13, 17, 19, 23];
    let redraws = 0;
    let letterConstrained = 0;
    for (const seed of seeds) {
      const m = withBay(["Wildcard", "Winnower"], {}, mulberry(seed));
      m.commitSelection(solo.id, rackWord(m)); // era openers are free; turn 2 imposes a letter
      const letter = m.state.requiredLetter;
      if (letter === "" || !m.successionWaivedThisTurn) continue; // no charge spent this turn
      expect(m.redrawRack(solo.id)).toBe(true);
      expect(m.successionWaivedThisTurn).toBe(true); // the receipt survives the redraw...
      redraws++;
      // Read the fresh rack BEFORE committing — a commit re-arms the turn and draws another one.
      const onLetter = subWordFinder(m.state.rack, m.wordPoolInstance!, m.offerIndex, letter, {
        maxResults: 1,
      });
      if (onLetter.length > 0) letterConstrained++;
      const free = rackWords(m).filter((w) => w[0] !== letter);
      expect(free.length).toBeGreaterThan(0);
      expect(m.commitSelection(solo.id, free[0]).accepted).toBe(true); // ...and so does the bypass
    }
    expect(redraws).toBeGreaterThan(4);
    expect(letterConstrained).toBeLessThan(redraws); // ...so the new rack was NOT seeded on it
  });
});

describe("word builder — Preference Cards through the engine", () => {
  it("bubbles a Preference Card to the left of the scoring chain", () => {
    const m = started(makePicker());
    const p = m.state.players[0];
    p.bay = [
      { id: "TheAnchor", uid: "a" },
      { id: "Sieve", uid: "s" },
      { id: "Dividend", uid: "d" },
    ];
    m.setPlayerBay(p.id, ["a", "s", "d"], []);
    expect(p.bay.map((b) => b.id)).toEqual(["Sieve", "TheAnchor", "Dividend"]);
  });

  it("shapes the rack seed from the bay", () => {
    /* Sieve raises the Golden Seed floor. The floor is min(minSeedLength, rackSize) — an 8-letter
     * seed cannot be decomposed into a smaller rack — so this pins the EFFECTIVE guarantee at a
     * rack size large enough for the card to bite. */
    const m = makePicker({ rackSize: 9 }, REDUCED, [solo]);
    m.benchSetBay(solo.id, ["Sieve"]);
    started(m);
    expect(m.state.rack.length).toBe(9);
    expect(m.state.rack.map((t) => t.text).join("").length).toBeGreaterThanOrEqual(8);
  });

  it("applies Wide Net and Tunnel Vision to the rack size", () => {
    const wide = makePicker({ rackSize: 9 }, REDUCED, [solo]);
    wide.benchSetBay(solo.id, ["WideNet"]);
    started(wide);
    expect(wide.state.rack.length).toBe(11);

    const tunnel = makePicker({ rackSize: 9 }, REDUCED, [solo]);
    tunnel.benchSetBay(solo.id, ["TunnelVision"]);
    started(tunnel);
    expect(tunnel.state.rack.length).toBe(7);
  });

  it("never serves an unplayable rack, however many Tunnel Visions are stacked", () => {
    const m = makePicker({ rackSize: 9 }, REDUCED, [solo]);
    m.benchSetBay(solo.id, ["TunnelVision", "TunnelVision", "TunnelVision"]);
    started(m);
    // Floored by MIN_RACK_SIZE rather than shrinking toward zero, and still buildable.
    expect(m.state.rack.length).toBeGreaterThanOrEqual(3);
    expect(rackWords(m).length).toBeGreaterThan(0);
  });

  it("keeps a working engine when an idle player is trimmed to capacity", () => {
    /* The AFK path: nothing discarded, more cards than slots. Bubbling puts Preference Cards first,
     * so a naive "keep the first N" would leave a player who never touched the screen holding
     * nothing but shape filters and scoring almost nothing. */
    const m = makePicker({ dealEngineCardsFirstEra: true, modifiersDealtPerEra: 3 }, REDUCED, [
      solo,
    ]);
    m.start();
    m.tick(0.001); // → the pre-era-1 setup intermission → deal → optimize
    expect(m.state.intermissionPhase).toBe("optimize");

    const p = m.state.players[0];
    p.slots = 2;
    p.bay = [
      { id: "Sieve", uid: "s" },
      { id: "Tide", uid: "t" },
      { id: "TheAnchor", uid: "a" },
      { id: "Dividend", uid: "d" },
    ];
    m.skipOptimize();
    m.tick(0.001);

    expect(p.bay.length).toBe(2);
    // At least one real scoring card survived rather than two shape filters.
    expect(p.bay.some((b) => b.id === "TheAnchor" || b.id === "Dividend")).toBe(true);
  });
});

describe("effectiveMode — which mode's card values a match scores with", () => {
  it("is Picker for a real Picker match", () => {
    expect(makePicker().effectiveMode).toBe(GameMode.Picker);
  });

  it("is Classic for a Picker match built without a word pool", () => {
    /* The fallback: such a match types its words and levies a real timeout penalty through
     * timeoutCurrent, so it must score on Classic's curves — pairing Classic's timeout drain with
     * Picker's compensating buff would be strictly worse than either mode. Same reasoning as
     * baseClockSeconds, which keys on the same accessor. */
    const dict = new Dictionary(REDUCED);
    const m = new MatchController(
      seeds,
      { ...DEFAULT_SETTINGS, gameMode: GameMode.Picker, enableTutorials: false },
      { isWord: (w) => dict.has(w), rng: () => 0.5 }, // no wordPool
    );
    expect(m.effectiveMode).toBe(GameMode.Classic);
    // The REPLICATED setting is deliberately left alone: `dealCards` keys on it so the deal depends
    // only on replicated state, and rewriting a host's chosen setting would desync the pool a guest
    // mirror expects.
    expect(m.state.settings.gameMode).toBe(GameMode.Picker);
  });

  it("is Classic for a Classic match", () => {
    const dict = new Dictionary(REDUCED);
    const m = new MatchController(
      seeds,
      { ...DEFAULT_SETTINGS, gameMode: GameMode.Classic, enableTutorials: false },
      { isWord: (w) => dict.has(w), rng: () => 0.5, wordPool: dictionaryWordPool(dict) },
    );
    expect(m.effectiveMode).toBe(GameMode.Classic);
  });
});
describe("word builder — Succession dead ends", () => {
  /* `u` is the shipped Reduced list's one rack-size-sensitive letter: 73 buildable words at rack
   * size 9, but 57 at size 7 — under MIN_SUCCESSION_POOL_WORDS and under half the per-letter
   * average, so it dead-ends a Tunnel Vision holder while being perfectly playable for everyone
   * else. That is the whole point of `letterSupportsRack`, and measuring the base setting instead
   * of the successor's actual rack asked about a rack nobody was going to be dealt.
   *
   * The rack is hand-built: this is about the letter the chain hands on, not which seed the
   * generator happened to pick. */
  const commitEndingInU = (m: MatchController): boolean => {
    m.state.rack = [..."bureau"].map((ch, i) => ({ id: `t${i}`, text: ch, isChunk: false }));
    return m.commitSelection(m.current.id, "bureau").accepted;
  };

  it("waives a letter that dead-ends the NEXT player's smaller rack", () => {
    const m = started(makePicker({ rackSize: 9 }, REDUCED, seeds));
    m.benchSetBay(m.state.players[1].id, ["TunnelVision"]); // their rack is 7 tiles, not 9
    expect(commitEndingInU(m)).toBe(true);
    expect(m.state.requiredLetter).toBe("");
  });

  it("keeps the letter when the next player's rack is big enough to work it", () => {
    const m = started(makePicker({ rackSize: 9 }, REDUCED, seeds));
    expect(commitEndingInU(m)).toBe(true);
    expect(m.state.requiredLetter).toBe("u");
  });
});
