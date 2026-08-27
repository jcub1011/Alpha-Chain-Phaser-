// @vitest-environment happy-dom
//
// <ac-word-builder> — Word Builder input surface tests.

import { beforeEach, describe, expect, it } from "vitest";
import { Dictionary } from "../../game/dictionary";
import { canConstructWordFromTiles } from "../../game/builder/rack";
import { MatchController, type PlayerSeed } from "../../game/match";
import { dictionaryWordPool } from "../../game/picker/wordPool";
import { DEFAULT_SETTINGS } from "../../game/settings";
import { GameMode } from "../../game/types";
import type { GameController, MatchLike } from "../../net/controller";
import "./ac-word-builder";
import type { AcWordBuilder } from "./ac-word-builder";

const WORDS = [
  "candle",
  "cat",
  "action",
  "builder",
  "building",
  "running",
  "faster",
  "kindness",
  "softly",
  "quartz",
  "tigers",
  "eagles",
];

const seeds: PlayerSeed[] = [
  { id: "you", name: "You", isBot: false },
  { id: "bot1", name: "Bot", isBot: true },
];

const threeSeats: PlayerSeed[] = [
  { id: "bot1", name: "Bot One", isBot: true },
  { id: "bot2", name: "Bot Two", isBot: true },
  { id: "you", name: "You", isBot: false },
];

interface Calls {
  staged: { ids: string[]; word?: string }[];
  commits: (string | undefined)[];
  redraws: number;
}

function harness(
  overrides: Partial<typeof DEFAULT_SETTINGS> = {},
  words: string[] = WORDS,
  roster: PlayerSeed[] = seeds,
): {
  match: MatchController;
  controller: GameController;
  calls: Calls;
} {
  const dict = new Dictionary(words);
  const match = new MatchController(
    roster,
    {
      ...DEFAULT_SETTINGS,
      gameMode: GameMode.Picker,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      rackSize: 9,
      ...overrides,
    },
    { isWord: (w) => dict.has(w), rng: () => 0.5, wordPool: dictionaryWordPool(dict) },
  );
  match.start();
  match.tick(1);

  const calls: Calls = { staged: [], commits: [], redraws: 0 };
  const controller: GameController = {
    match: match as MatchLike,
    events: match.events,
    humanId: "you",
    isOwner: true,
    start: () => {},
    tick: () => {},
    submitWord: () => ({ accepted: false }),
    reportDraft: () => {},
    commitSelection: (w) => {
      calls.commits.push(w);
      return match.commitSelection("you", w);
    },
    redrawRack: () => {
      calls.redraws++;
      match.redrawRack("you");
    },
    stageTiles: (ids, word) => {
      calls.staged.push({ ids, word });
      if (word) match.setSelection("you", word);
    },
    destroy: () => {},
  };
  return { match, controller, calls };
}

async function mount(controller: GameController): Promise<AcWordBuilder> {
  const el = document.createElement("ac-word-builder") as AcWordBuilder;
  el.controller = controller;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const standby = (el: AcWordBuilder): HTMLElement =>
  el.querySelector(".ac-standby") as HTMLElement;

const rackTiles = (el: AcWordBuilder): HTMLButtonElement[] =>
  [...el.querySelectorAll(".ac-tile-rack .ac-tile")] as HTMLButtonElement[];
const stagedTiles = (el: AcWordBuilder): HTMLButtonElement[] =>
  [...el.querySelectorAll(".ac-staging-track .ac-tile")] as HTMLButtonElement[];
const submitBtn = (el: AcWordBuilder): HTMLButtonElement =>
  el.querySelector(".ac-btn--submit") as HTMLButtonElement;
const clearBtn = (el: AcWordBuilder): HTMLButtonElement =>
  el.querySelector(".ac-btn--clear") as HTMLButtonElement;

/** A word this turn's rack can actually build — the only kind the engine will now accept, since
 *  Word Builder is the sole Picker surface and there is no Offer to borrow a word from. */
const firstRackWord = (match: MatchController): string => {
  const word = WORDS.find((w) => canConstructWordFromTiles(w, match.state.rack));
  if (!word) throw new Error("rack cannot build any fixture word");
  return word;
};

describe("<ac-word-builder>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all tiles from the active Tile Rack", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);

    expect(match.state.rack.length).toBeGreaterThan(0);
    expect(rackTiles(el).length).toBe(match.state.rack.length);
    for (const tile of match.state.rack) {
      expect(el.textContent).toContain(tile.text.toUpperCase());
    }
  });

  it("stages tiles on tap, fires preview events, and unstages on second tap in staging track", async () => {
    const { controller } = harness();
    const el = await mount(controller);

    let previewWord = "";
    el.addEventListener("ac-offer-preview", (e: Event) => {
      previewWord = (e as CustomEvent).detail.word;
    });

    const tiles = rackTiles(el);
    expect(tiles.length).toBeGreaterThan(2);

    // Tap first tile
    tiles[0].click();
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(1);
    expect(previewWord.length).toBeGreaterThan(0);
    expect(submitBtn(el).disabled).toBe(false);

    // Tap second tile
    tiles[1].click();
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(2);

    // Tap first staged tile to unstage it
    stagedTiles(el)[0].click();
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(1);

    // Clear all
    clearBtn(el).click();
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(0);
    expect(previewWord).toBe("");
    expect(submitBtn(el).disabled).toBe(true);
  });

  it("supports keyboard typing to stage tiles, Backspace to pop, and Enter to commit", async () => {
    const { match, controller, calls } = harness();
    const el = await mount(controller);

    const firstTile = match.state.rack[0];
    const letter = firstTile.text[0];

    // Simulate keydown with the tile's starting letter
    window.dispatchEvent(new KeyboardEvent("keydown", { key: letter }));
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(1);

    // Press Backspace
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(0);

    // Type again and press Enter
    window.dispatchEvent(new KeyboardEvent("keydown", { key: letter }));
    await el.updateComplete;
    expect(stagedTiles(el).length).toBe(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(calls.commits.length).toBe(1);
  });

  it("submits the constructed word through the SUBMIT button", async () => {
    const { controller, calls } = harness();
    const el = await mount(controller);

    rackTiles(el)[0].click();
    await el.updateComplete;

    submitBtn(el).click();
    await el.updateComplete;

    expect(calls.commits.length).toBe(1);
  });

  it("disables staging and submission when not the human player's turn", async () => {
    const { match, controller } = harness();
    // Advance turn to bot with a word this turn's rack can actually build.
    match.commitSelection("you", firstRackWord(match));
    const el = await mount(controller);

    expect(match.current.id).toBe("bot1");
    expect(rackTiles(el).every((t) => t.disabled)).toBe(true);
    expect(submitBtn(el).disabled).toBe(true);
  });

  it("stages morpheme chunks and renders chunk badges", async () => {
    const { match, controller } = harness();
    // Inject a chunk tile
    match.state.rack = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "ar", isChunk: false },
      { id: "t2", text: "ing", isChunk: true },
    ];
    match.state.rackRedrawAvailable = true;

    const el = await mount(controller);
    expect(el.querySelectorAll(".ac-tile--chunk").length).toBe(1);

    // Click the chunk tile
    const chunkBtn = el.querySelector(".ac-tile-rack .ac-tile--chunk") as HTMLButtonElement;
    chunkBtn.click();
    await el.updateComplete;

    expect(stagedTiles(el).length).toBe(1);
    expect(stagedTiles(el)[0].textContent).toContain("ING");
  });

  it("triggers Winnower redraw and clears staging", async () => {
    const { match, controller, calls } = harness();
    match.state.rackRedrawAvailable = true;
    const el = await mount(controller);

    // Stage a tile
    rackTiles(el)[0].click();
    await el.updateComplete;
    expect(stagedTiles(el).length).toBe(1);

    // Click redraw button
    const redrawBtn = el.querySelector(".ac-btn--redraw") as HTMLButtonElement;
    expect(redrawBtn).toBeTruthy();
    redrawBtn.click();
    await el.updateComplete;

    expect(calls.redraws).toBe(1);
    expect(stagedTiles(el).length).toBe(0);
  });

  it("renders banned letter indicator when highlightBannedLetters is enabled", async () => {
    const { match, controller } = harness({ highlightBannedLetters: true });
    match.state.bannedLetter = "e";
    match.state.rack = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "ed", isChunk: true },
    ];

    const el = await mount(controller);
    expect(el.querySelectorAll(".ac-tile.is-banned").length).toBe(1);
  });

  it("shuffles available rack tiles on clicking Shuffle button", async () => {
    const { controller } = harness();
    const el = await mount(controller);

    const shuffleBtn = el.querySelector(".ac-btn--shuffle") as HTMLButtonElement;
    expect(shuffleBtn).toBeTruthy();
    expect(shuffleBtn.disabled).toBe(false);

    // Clicking shuffle updates the view
    shuffleBtn.click();
    await el.updateComplete;
    expect(rackTiles(el).length).toBeGreaterThan(0);
  });

  it("applies is-starter green tint class to tiles starting with the required letter", async () => {
    const { match, controller } = harness();
    match.state.requiredLetter = "t";
    match.state.rack = [
      { id: "t0", text: "t", isChunk: false },
      { id: "t1", text: "tion", isChunk: true },
      { id: "t2", text: "a", isChunk: false },
      { id: "t3", text: "r", isChunk: false },
    ];

    const el = await mount(controller);
    const starterTiles = el.querySelectorAll(".ac-tile-rack .ac-tile.is-starter");
    expect(starterTiles.length).toBe(2);
    expect(starterTiles[0].textContent).toContain("T");
    expect(starterTiles[1].textContent).toContain("TION");
  });

  it("ignores modifier chords instead of staging a tile for them", async () => {
    /* The handler is on the WINDOW and `e.key` for Ctrl+R is still a bare "r", so every Ctrl/Cmd/Alt
     * combo used to be preventDefault-ed AND staged a tile: Ctrl+R staged an `r` rather than
     * reloading, and Ctrl+A/C/V/F were simply swallowed for the length of your turn. */
    const { match, controller } = harness();
    const el = await mount(controller);
    const letter = match.state.rack[0].text[0];

    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const ev = new KeyboardEvent("keydown", { key: letter, cancelable: true, ...mods });
      window.dispatchEvent(ev);
      await el.updateComplete;
      expect(ev.defaultPrevented).toBe(false);
      expect(stagedTiles(el).length).toBe(0);
    }

    // The same key without a modifier still stages, so the guard is not simply swallowing input.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: letter, cancelable: true }));
    await el.updateComplete;
    expect(stagedTiles(el).length).toBe(1);
  });

  it("flushes a throttled stage at the buzzer instead of submitting the fragment", async () => {
    /* The regression this exists for: the 80ms stage throttle defers a send, the engine's expiry
     * commits whatever the last stage left behind, and a player who taps their final tiles quickly
     * into the buzzer had their FRAGMENT submitted, rejected as not-a-word, and counted as a no-show
     * — which in Survival is an elimination on a turn they actually finished. Solo has no submit
     * grace to hide behind, so this is the case with no other protection. */
    const { match, controller } = harness({ survivalMode: true });
    // A two-tile "cat" makes the fragment and the finished word distinguishable: the first tap
    // stages "c" (buildable, so the engine accepts it as a selection) and the second completes it
    // inside the throttle window.
    match.state.rack = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "at", isChunk: false },
    ];
    match.state.requiredLetter = "c";
    const el = await mount(controller);
    expect(match.current.id).toBe("you");

    const tiles = rackTiles(el);
    tiles[0].click();
    tiles[1].click(); // within the throttle window, so this send is deferred
    await el.updateComplete;

    // Run the clock out. The engine emits clockTick before its own timeout check, which is the
    // window the flush uses.
    match.tick(match.state.clockRemaining + 0.1);

    expect(match.state.history[match.state.history.length - 1]?.word).toBe("cat");
    expect(match.state.players.find((p) => p.id === "you")?.eliminated).toBe(false);
  });

  it("shows the standby cover when the seat before the human is eliminated", async () => {
    /* A bare (currentPlayerIndex + 1) lands on the eliminated seat and denies the cover to the
     * player who is genuinely next — the opposite of what the comment there used to claim. */
    const { match, controller } = harness({}, WORDS, threeSeats);
    match.state.currentPlayerIndex = match.state.players.findIndex((p) => p.id === "bot1");
    const between = match.state.players.find((p) => p.id === "bot2")!;
    between.eliminated = true;

    const el = await mount(controller);
    expect(standby(el).classList.contains("is-shown")).toBe(true);
    expect(standby(el).textContent).toContain("You're Next");
  });

  it("keeps SUBMIT dead through the round settle window", async () => {
    /* `live` is re-derived on every clockTick and state does not say "this turn is over", so the
     * derivation flipped it back on over a rack belonging to the previous turn. commitSelection
     * refuses during the settle window and emits no `rejected`, so the button was silently dead.
     *
     * Driven by the human's own ERA-ENDING word, which is the case that reaches it. submitWord emits
     * `submission` BEFORE endTurn runs, so the last derivation of `live` still sees the human as the
     * current seat; endTurn then arms the settle window and returns without arming a turn, and no
     * further event fires (tick returns early while settling, so not even a clockTick). `live` was
     * therefore left true over the rack of a turn that had already resolved. */
    const { match, controller, calls } = harness({ eraInterval: 1 }, WORDS, threeSeats);
    // Eliminating the other seats makes the human's own turn the one that wraps the round, so the
    // settle window is armed with the human still the current seat. Survival is off, so no game over.
    for (const p of match.state.players) if (p.id !== "you") p.eliminated = true;
    match.state.currentPlayerIndex = match.state.players.findIndex((p) => p.id === "you");
    match.state.rack = [
      { id: "t0", text: "c", isChunk: false },
      { id: "t1", text: "at", isChunk: false },
    ];
    match.state.requiredLetter = "c";
    const el = await mount(controller);

    for (const tile of rackTiles(el)) tile.click();
    await el.updateComplete;
    submitBtn(el).click();
    await el.updateComplete;

    expect(match.state.history[match.state.history.length - 1]?.word).toBe("cat");
    expect(match.isSettling()).toBe(true);
    expect(match.state.phase).toBe("Round");
    expect(match.current.id).toBe("you"); // still the current seat, but the turn is over
    expect(match.state.rack.length).toBeGreaterThan(0); // and its rack is still on screen

    const commitsBefore = calls.commits.length;
    await el.updateComplete;

    // The stale rack must refuse the tap outright — otherwise the player builds a word and presses a
    // button the engine will silently ignore.
    expect(rackTiles(el).length).toBeGreaterThan(0);
    expect(rackTiles(el).every((t) => t.disabled)).toBe(true);
    for (const tile of rackTiles(el)) tile.click();
    await el.updateComplete;
    expect(stagedTiles(el).length).toBe(0);

    submitBtn(el).click();
    await el.updateComplete;
    expect(submitBtn(el).disabled).toBe(true);
    expect(calls.commits.length).toBe(commitsBefore);
  });
});

