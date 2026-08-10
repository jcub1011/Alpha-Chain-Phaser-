// @vitest-environment happy-dom
//
// <ac-offer-grid> — Picker's input surface. Covers the three rules that are requirements rather
// than styling: two-stage select-then-commit (touch has no hover), the shape annotations (an
// accessibility affordance, not decoration), and that NO projected score is ever rendered.
import { beforeEach, describe, expect, it } from "vitest";
import { Dictionary } from "../../game/dictionary";
import { MatchController, type PlayerSeed } from "../../game/match";
import { dictionaryWordPool } from "../../game/picker/wordPool";
import { DEFAULT_SETTINGS } from "../../game/settings";
import { GameMode } from "../../game/types";
import type { GameController } from "../../net/controller";
import type { MatchLike } from "../../net/controller";
import "./ac-offer-grid";
import type { AcOfferGrid } from "./ac-offer-grid";

const WORDS = [
  "candle",
  "cat",
  "quartz",
  "eagle",
  "tiger",
  "rabbit",
  "torch",
  "melon",
  "jazz",
  "xylem",
];

/* A chain-friendly pool: "apple" ends in e, and there are plenty of unused e-words behind it, so
 * the generator never has to free the letter. Needed wherever a test asserts on requiredLetter —
 * with a ten-word pool a letter genuinely runs dry, which is the generator working, not a bug. */
const CHAIN_WORDS = [
  "apple",
  "eagle",
  "eager",
  "early",
  "earth",
  "easel",
  "eaten",
  "edge",
  "elbow",
  "elder",
];

const seeds: PlayerSeed[] = [
  { id: "you", name: "You", isBot: false },
  { id: "bot1", name: "Bot", isBot: true },
];

/** Calls the grid made on the controller, so the two-stage contract can be asserted. */
interface Calls {
  selections: string[];
  commits: (string | undefined)[];
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
      offerCount: 4,
      ...overrides,
    },
    { isWord: (w) => dict.has(w), rng: () => 0.5, wordPool: dictionaryWordPool(dict) },
  );
  match.start();
  match.tick(1);
  const calls: Calls = { selections: [], commits: [] };
  const controller: GameController = {
    match: match as MatchLike,
    events: match.events,
    humanId: "you",
    isOwner: true,
    start: () => {},
    tick: () => {},
    submitWord: () => ({ accepted: false }),
    reportDraft: () => {},
    reportSelection: (w) => {
      calls.selections.push(w);
      match.setSelection("you", w);
    },
    commitSelection: (w) => {
      calls.commits.push(w);
      return match.commitSelection("you", w);
    },
    redrawOffer: () => match.redrawOffer("you"),
    destroy: () => {},
  };
  return { match, controller, calls };
}

async function mount(controller: GameController): Promise<AcOfferGrid> {
  const el = document.createElement("ac-offer-grid") as AcOfferGrid;
  el.controller = controller;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Wait past the select throttle (120 ms) so any trailing send has fired. Real timers rather than
 *  fake ones: the component reads Date.now() directly, so faking the clock without also faking
 *  Date would leave the throttle comparing a frozen `now` against a real `lastSelectAt`. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 180));

const cards = (el: AcOfferGrid): HTMLButtonElement[] =>
  [...el.querySelectorAll(".og-card")] as HTMLButtonElement[];
const go = (el: AcOfferGrid): HTMLButtonElement => el.querySelector(".og-go") as HTMLButtonElement;

describe("<ac-offer-grid>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one card per Offer word", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);
    expect(match.state.offer.length).toBe(4);
    expect(cards(el).length).toBe(4);
    for (const w of match.state.offer) expect(el.textContent).toContain(w);
  });

  it("selects on the first tap and commits on the second", async () => {
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    const word = match.state.offer[0];

    cards(el)[0].click();
    await el.updateComplete;
    expect(calls.selections).toEqual([word]);
    expect(calls.commits).toEqual([]); // NOT yet submitted — touch needs an explicit first tap
    expect(cards(el)[0].classList.contains("is-selected")).toBe(true);

    cards(el)[0].click();
    await el.updateComplete;
    expect(calls.commits).toEqual([word]);
    expect(match.state.usedWords.has(word)).toBe(true);
  });

  it("moves the selection when a different card is tapped, without committing", async () => {
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    const [first, second] = match.state.offer;
    cards(el)[0].click();
    await el.updateComplete;
    cards(el)[1].click();
    await el.updateComplete;

    expect(calls.commits).toEqual([]);
    // The visible selection moves immediately — the throttle only delays the WIRE message.
    expect(cards(el)[0].classList.contains("is-selected")).toBe(false);
    expect(cards(el)[1].classList.contains("is-selected")).toBe(true);
    // First tap sent on the leading edge; the second is coalesced into a trailing send.
    expect(calls.selections).toEqual([first]);
    await settle();
    expect(calls.selections).toEqual([first, second]);
  });

  it("coalesces a burst of taps into one trailing send", async () => {
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    const offer = [...match.state.offer];
    for (let i = 0; i < 4; i++) {
      cards(el)[i].click();
      await el.updateComplete;
    }
    await settle();
    // Leading edge, then ONE trailing send carrying whatever ended up selected — not four.
    expect(calls.selections).toEqual([offer[0], offer[3]]);
  });

  it("cancels a queued send when the selection is cleared", async () => {
    /* A trailing timer must not resurrect a word the player moved off: the authority would commit
     * THAT on a clock expiry. `turnArmed` clears the selection, so drive it through the engine. */
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    const first = match.state.offer[0];
    cards(el)[0].click(); // leading-edge send
    await el.updateComplete;
    cards(el)[1].click(); // queued trailing send
    await el.updateComplete;

    match.commitSelection("you", first); // resolves the turn → turnArmed → select(null)
    await el.updateComplete;
    await settle();
    expect(calls.selections).toEqual([first]); // the queued second word never went out
  });

  it("cancels a queued send when the selection is committed", async () => {
    /* The commit carries the word, so a queued select is redundant — and cancelling it removes any
     * chance of it landing AFTER the commit and re-selecting on a resolved turn. */
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    const [first, second] = match.state.offer;
    cards(el)[0].click(); // leading-edge send
    await el.updateComplete;
    cards(el)[1].click(); // queued
    await el.updateComplete;
    cards(el)[1].click(); // second tap on the same card commits
    await el.updateComplete;
    await settle();

    expect(calls.commits).toEqual([second]);
    expect(calls.selections).toEqual([first]); // no select after the commit
  });

  it("repaints a new Offer arriving without a replayed event", async () => {
    /* Networked play only paints the match surface from replayed events, so a client that joins or
     * reconnects mid-turn holds the Offer in state with no `turnArmed` to render it. clockTick is
     * the fallback signal. */
    const { match, controller } = harness();
    const el = await mount(controller);
    match.state.offer = ["zebra", "zombie"];
    match.events.emit("clockTick", 12);
    await el.updateComplete;

    expect(cards(el).length).toBe(2);
    expect(el.textContent).toContain("zebra");
  });

  it("does not re-render the grid when an identical Offer is re-synced", async () => {
    // The mirror rebuilds state (and a fresh offer array) every snapshot; assigning the reference
    // would re-render at the server's tick rate and fight the player's own taps.
    const { match, controller } = harness();
    const el = await mount(controller);
    const before = cards(el)[0];
    match.state.offer = [...match.state.offer]; // new array, same contents
    match.events.emit("clockTick", 11);
    await el.updateComplete;
    expect(cards(el)[0]).toBe(before); // same DOM node — Lit did not re-render
  });

  it("commits the selection through the GO button", async () => {
    const { match, controller, calls } = harness();
    const el = await mount(controller);
    // Read the word BEFORE committing: the turn advances and the Offer is regenerated, so
    // match.state.offer is a different array by the time the assertion runs.
    const word = match.state.offer[2];
    expect(go(el).disabled).toBe(true); // nothing selected yet
    cards(el)[2].click();
    await el.updateComplete;
    expect(go(el).disabled).toBe(false);
    go(el).click();
    expect(calls.commits).toEqual([word]);
  });

  it("publishes the selection so the HUD can project it onto the bay", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);
    const seen: (string | null)[] = [];
    el.addEventListener("ac-offer-preview", (e) => seen.push(e.detail.word));
    cards(el)[1].click();
    await el.updateComplete;
    expect(seen).toEqual([match.state.offer[1]]);
  });

  it("annotates every card with letter and vowel counts", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);
    cards(el).forEach((card, i) => {
      const word = match.state.offer[i];
      const vowels = [...word].filter((c) => "aeiou".includes(c)).length;
      expect(card.textContent).toContain(`${word.length}L`);
      expect(card.textContent).toContain(`${vowels}v`);
    });
  });

  it("flags rare letters anywhere in the word, not just at the start", async () => {
    // `quartz` starts with q AND contains z; the existing RARE_START set is about the starting
    // letter, so a mid-word rare letter needs its own check.
    const { controller } = harness();
    const el = await mount(controller);
    const quartz = cards(el).find((c) => c.textContent?.includes("quartz"));
    if (quartz) expect(quartz.querySelector(".og-tag--rare")?.textContent).toContain("Q");
  });

  it("never renders a projected score", async () => {
    /* Rule 3. A displayed figure turns the decision into a lookup: the player stops evaluating and
     * clicks the biggest number. Selecting must change the bay highlight and nothing else. */
    const { controller } = harness();
    const el = await mount(controller);
    cards(el)[0].click();
    await el.updateComplete;
    // The only digits allowed are the annotation counts ("6L", "2v"), never a score.
    const digits = (el.textContent ?? "").match(/\d+/g) ?? [];
    for (const d of digits) expect(Number(d)).toBeLessThan(30);
    expect(el.textContent).not.toMatch(/points|score|pts/i);
  });

  it("disables every card when it is not the human's turn", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);
    match.commitSelection("you", match.state.offer[0]); // hand the turn to the bot
    await el.updateComplete;
    expect(match.current.id).toBe("bot1");
    for (const c of cards(el)) expect(c.disabled).toBe(true);
    expect(go(el).disabled).toBe(true);
  });

  it("shows the required letter once Succession is in force", async () => {
    // Solo roster so the human is live again immediately after committing — the letter is only
    // shown on a live turn (otherwise the header reads "waiting…"). Chain pool so the letter
    // survives rather than being freed as exhausted.
    const { match, controller } = harness({}, CHAIN_WORDS, [
      { id: "you", name: "You", isBot: false },
    ]);
    const el = await mount(controller);
    expect(match.state.offer).toContain("apple");
    match.commitSelection("you", "apple");
    await el.updateComplete;

    expect(match.current.id).toBe("you");
    expect(match.state.requiredLetter).toBe("e");
    expect(el.querySelector(".og-letter")?.textContent?.trim()).toBe("E");
    for (const c of cards(el)) expect(c.textContent?.trim().startsWith("e")).toBe(true);
  });

  it("surfaces a rejection as feedback", async () => {
    const { match, controller } = harness();
    const el = await mount(controller);
    match.commitSelection("you", "notoffered"); // emits rejected → "not-offered"
    await el.updateComplete;
    expect(el.querySelector(".og-feedback")?.textContent).toContain("isn't on offer");
  });

  it("marks the banned letter only when the setting is on", async () => {
    const off = harness({ highlightBannedLetters: false });
    off.match.state.bannedLetter = "a";
    const elOff = await mount(off.controller);
    expect(elOff.querySelector(".og-ban")).toBeNull();

    document.body.innerHTML = "";
    const on = harness({ highlightBannedLetters: true });
    on.match.state.bannedLetter = "a";
    const elOn = await mount(on.controller);
    // Only meaningful if some offered word actually contains an "a".
    if (on.match.state.offer.some((w) => w.includes("a"))) {
      expect(elOn.querySelector(".og-ban")?.textContent).toBe("a");
    }
  });
});
