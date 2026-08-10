// @vitest-environment happy-dom
//
// <ac-tutorial>'s SKIP gate. The dwell is shared — one skip advances the page for
// EVERYONE — so the authority accepts the skipTutorial intent from the lobby owner
// only. This pins that the button is shown to exactly the clients that can use it:
// a non-owner offered SKIP gets a button the server silently refuses.
import { describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "../../game/match";
import { DEFAULT_SETTINGS } from "../../game/settings";
import type { GameController, MatchLike } from "../../net/controller";
import "./ac-tutorial";
import type { AcTutorial } from "./ac-tutorial";

const WORDS = new Set(["cat", "tap", "pat"]);
const seeds: PlayerSeed[] = [
  { id: "p1", name: "One", isBot: false },
  { id: "p2", name: "Two", isBot: false },
];

/** A two-human match parked on the first tutorial page, as every client sees it. */
function tutorialMatch(): MatchController {
  const m = new MatchController(
    seeds,
    { ...DEFAULT_SETTINGS, enableTutorials: true, preRoundCountdownSeconds: 1 },
    { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
  );
  m.start();
  return m;
}

/** The slice of GameController the view reads. `isOwner` is the property under test —
 *  it must come off the declared interface, not be sniffed off the concrete class. */
function controllerFor(match: MatchController, humanId: string, isOwner: boolean): GameController {
  return {
    match: match as MatchLike,
    events: match.events,
    humanId,
    isOwner,
    start: () => {},
    tick: () => {},
    submitWord: () => ({ accepted: false, reason: "invalid" }) as never,
    reportDraft: () => {},
    destroy: () => {},
  };
}

async function mount(controller: GameController): Promise<AcTutorial> {
  const el = document.createElement("ac-tutorial") as AcTutorial;
  el.controller = controller;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("<ac-tutorial> skip gate", () => {
  it("shows SKIP to the lobby owner", async () => {
    const m = tutorialMatch();
    expect(m.state.currentTutorial).toBe("shiritori"); // guard: the view has a page to render
    const el = await mount(controllerFor(m, "p1", true));
    expect(el.querySelector(".tut-skip")).not.toBeNull();
  });

  it("hides SKIP from a non-owner, who cannot skip for everyone", async () => {
    const m = tutorialMatch();
    const el = await mount(controllerFor(m, "p2", false));
    expect(el.querySelector(".tut-skip")).toBeNull();
    // The per-client "I've read this" control is unaffected — every player marks their own
    // page read, and the dwell auto-advances once all of them have.
    expect(el.querySelector(".tut-read")).not.toBeNull();
  });
});
