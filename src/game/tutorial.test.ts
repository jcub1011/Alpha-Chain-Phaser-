/*
 * Tutorial FSM: the Shiritori phase before the first round, and the engine/tax
 * intermission sub-phases — host-authoritative dwell, shown once, skippable.
 */

import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS } from "./settings";
import type { AlphaChainSettings } from "./types";

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
