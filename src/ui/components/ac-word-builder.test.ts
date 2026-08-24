// @vitest-environment happy-dom
//
// <ac-word-builder> — Word Builder input surface tests.

import { beforeEach, describe, expect, it } from "vitest";
import { Dictionary } from "../../game/dictionary";
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
    reportSelection: (w) => match.setSelection("you", w),
    commitSelection: (w) => {
      calls.commits.push(w);
      return match.commitSelection("you", w);
    },
    redrawOffer: () => {
      calls.redraws++;
      match.redrawOffer("you");
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

const rackTiles = (el: AcWordBuilder): HTMLButtonElement[] =>
  [...el.querySelectorAll(".ac-tile-rack .ac-tile")] as HTMLButtonElement[];
const stagedTiles = (el: AcWordBuilder): HTMLButtonElement[] =>
  [...el.querySelectorAll(".ac-staging-track .ac-tile")] as HTMLButtonElement[];
const submitBtn = (el: AcWordBuilder): HTMLButtonElement =>
  el.querySelector(".ac-btn--submit") as HTMLButtonElement;
const clearBtn = (el: AcWordBuilder): HTMLButtonElement =>
  el.querySelector(".ac-btn--clear") as HTMLButtonElement;

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
    // Advance turn to bot
    match.submitWord("you", match.state.offer[0] || "cat");
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
});
