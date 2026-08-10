/*
 * Tutorial FSM: the Shiritori phase before the first round, and the engine/tax
 * intermission sub-phases — host-authoritative dwell, shown once, skippable.
 */

import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS } from "./settings";
import { GameMode } from "./types";
import type { AlphaChainSettings } from "./types";
import { Dictionary } from "./dictionary";
import { dictionaryWordPool } from "./picker/wordPool";

const WORDS = new Set(["cat", "tap", "pat"]);
const one: PlayerSeed[] = [{ id: "p1", name: "P1", isBot: false }];

const make = (overrides: Partial<AlphaChainSettings> = {}) =>
  new MatchController(
    one,
    { ...DEFAULT_SETTINGS, preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3, ...overrides },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );

describe("Shiritori tutorial (top-level phase)", () => {
  it("opens on the Shiritori tutorial when tutorials are enabled", () => {
    const m = make({ enableTutorials: true });
    m.start();
    expect(m.state.phase).toBe("Tutorial");
    expect(m.state.currentTutorial).toBe("shiritori");
    expect(m.state.subTimerRemaining).toBeGreaterThan(0);
  });

  it("advances chain → timeout, then to the countdown once each dwell elapses", () => {
    const m = make({ enableTutorials: true });
    m.start();
    m.tick(m.state.subTimerRemaining + 0.1); // shiritori dwell → timeout page
    expect(m.state.phase).toBe("Tutorial");
    expect(m.state.currentTutorial).toBe("timeout");
    m.tick(m.state.subTimerRemaining + 0.1); // timeout dwell → countdown
    expect(m.state.phase).toBe("Countdown");
    expect(m.state.currentTutorial).toBeNull();
  });

  it("skipTutorial short-cuts each pre-game page in turn", () => {
    const m = make({ enableTutorials: true });
    m.start();
    m.skipTutorial(); // shiritori → timeout
    expect(m.state.phase).toBe("Tutorial");
    expect(m.state.currentTutorial).toBe("timeout");
    m.skipTutorial(); // timeout → countdown
    expect(m.state.phase).toBe("Countdown");
  });

  it("goes straight to the countdown when tutorials are disabled", () => {
    const m = make({ enableTutorials: false });
    m.start();
    expect(m.state.phase).toBe("Countdown");
    expect(m.state.currentTutorial).toBeNull();
  });
});

describe("Intermission tutorials (engine → cards → optimize → tax → sniper → sniperBan)", () => {
  /** Skip the pre-game pages, burn the countdown, and play one word to reach the
   *  first intermission. */
  const toFirstIntermission = (m: MatchController, word: string): void => {
    m.start();
    while (m.state.phase === "Tutorial") m.skipTutorial(); // chain → timeout → done
    m.tick(2); // countdown → Round
    m.submitWord("p1", word); // single player → wraps → intermission
    m.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
  };

  it("walks engine → cards → optimize → tax → sniper → sniperBan on the first intermission", () => {
    const m = make({ enableTutorials: true });
    toFirstIntermission(m, "cat");

    expect(m.state.phase).toBe("Intermission");
    expect(m.state.intermissionPhase).toBe("tutorial");
    expect(m.state.currentTutorial).toBe("engine");

    m.skipTutorial(); // engine → cards
    expect(m.state.intermissionPhase).toBe("tutorial");
    expect(m.state.currentTutorial).toBe("cards");

    m.skipTutorial(); // cards → optimize
    expect(m.state.intermissionPhase).toBe("optimize");
    expect(m.state.currentTutorial).toBeNull();

    m.tick(m.state.subTimerRemaining + 0.1); // optimize timer → tax tutorial
    expect(m.state.intermissionPhase).toBe("tutorial");
    expect(m.state.currentTutorial).toBe("tax");

    m.skipTutorial(); // tax → sniper
    expect(m.state.intermissionPhase).toBe("tutorial");
    expect(m.state.currentTutorial).toBe("sniper");

    m.skipTutorial(); // sniper → sniper ban
    expect(m.state.intermissionPhase).toBe("sniperBan");

    expect(m.state.shownTutorials.sort()).toEqual([
      "cards",
      "engine",
      "shiritori",
      "sniper",
      "tax",
      "timeout",
    ]);
  });

  it("does not repeat tutorials on later intermissions", () => {
    const m = make({ enableTutorials: true });
    // First intermission: clear every tutorial page and advance the era.
    toFirstIntermission(m, "cat");
    m.skipTutorial(); // engine → cards
    m.skipTutorial(); // cards → optimize
    m.skipOptimize(); // optimize → tax
    m.skipTutorial(); // tax → sniper
    m.skipTutorial(); // sniper → sniperBan
    m.applySniperBanAndAdvance(m.randomBanLetter()); // → era 2 countdown

    // Era 2 round → second intermission goes straight to optimize.
    m.tick(2); // countdown → Round
    m.submitWord("p1", "tap");
    m.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
    expect(m.state.phase).toBe("Intermission");
    expect(m.state.intermissionPhase).toBe("optimize");
    expect(m.state.currentTutorial).toBeNull();
  });
});

describe("pre-game tutorials are chosen by the mode actually being played", () => {
  /** A real Picker match: the word pool is what makes `isPicker` true. */
  const picker = (overrides: Partial<AlphaChainSettings> = {}) => {
    const dict = new Dictionary(["cat", "tap", "pat", "candle", "carrot", "camera"]);
    return new MatchController(
      one,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Picker,
        preRoundCountdownSeconds: 1,
        eraInterval: 1,
        eraCount: 3,
        enableTutorials: true,
        ...overrides,
      },
      { isWord: (w) => dict.has(w), rng: () => 0.5, wordPool: dictionaryWordPool(dict) },
    );
  };

  it("teaches the Offer and Picker's expiry rule in Picker", () => {
    const m = picker();
    m.start();
    expect(m.state.currentTutorial).toBe("offer");
    m.skipTutorial();
    // Picker's expiry commits your pick and costs nothing, which is the opposite of Classic's —
    // so it gets its own page rather than reusing the penalty one.
    expect(m.state.currentTutorial).toBe("pickerTimeout");
    m.skipTutorial();
    expect(m.state.phase).toBe("Countdown");
    expect(m.state.shownTutorials).toEqual(["offer", "pickerTimeout"]);
  });

  it("never shows a Classic page in Picker, or a Picker page in Classic", () => {
    const p = picker();
    p.start();
    while (p.state.phase === "Tutorial") p.skipTutorial();
    expect(p.state.shownTutorials).not.toContain("shiritori");
    expect(p.state.shownTutorials).not.toContain("timeout");

    const c = make({ enableTutorials: true, gameMode: GameMode.Classic });
    c.start();
    while (c.state.phase === "Tutorial") c.skipTutorial();
    expect(c.state.shownTutorials).toEqual(["shiritori", "timeout"]);
  });

  it("falls back to Classic's pages when Picker was asked for without a word pool", () => {
    /* Such a match presents typed entry (see MatchController.isPicker), so teaching the player to
     * tap Offer Cards that will never appear would be worse than either mode's tutorial. This is
     * also what keeps every pre-existing tutorial suite meaningful — they all spread
     * DEFAULT_SETTINGS, which now selects Picker, and inject no pool. */
    const m = make({ enableTutorials: true, gameMode: GameMode.Picker });
    m.start();
    expect(m.state.currentTutorial).toBe("shiritori");
  });
});
