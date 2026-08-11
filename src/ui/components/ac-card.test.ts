// @vitest-environment happy-dom
//
// Smoke coverage for the <ac-card> Lit component — the leaf the engine bay,
// intermission, replay piles and sandbox all render. Runs in happy-dom (the rest
// of the suite is node); see the docblock directive above. This is the seam that
// lets us add further component tests without standing the whole app up.
import { beforeEach, describe, expect, it } from "vitest";
import { CARD_CATALOGUE, getCard } from "../../game/cards/library";
import { GameMode } from "../../game/types";
import { setCardDisplayMode } from "../app/cardMode";
import "./ac-card";
import type { AcCard } from "./ac-card";

// Any card will do — this suite is about rendering, not the deal pool, so it deliberately
// reads the whole catalogue rather than a mode-scoped dealable list.
const sampleId = Object.keys(CARD_CATALOGUE)[0];

async function mount(props: Partial<AcCard> = {}): Promise<AcCard> {
  const el = document.createElement("ac-card") as AcCard;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("<ac-card>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // The display mode is ambient module state, so reset it or one test's mode leaks into the next.
    setCardDisplayMode(GameMode.Classic);
  });

  it("renders the card name and the sprite <use> reference for a known card", async () => {
    const card = getCard(sampleId, GameMode.Classic)!;
    const el = await mount({ cardId: sampleId });
    expect(el.textContent).toContain(card.name);
    expect(el.querySelector("use")?.getAttribute("href")).toBe(`#${sampleId}`);
  });

  it("renders nothing for an unknown card id", async () => {
    const el = await mount({ cardId: "definitely-not-a-card" });
    expect(el.querySelector(".gc-flip")).toBeNull();
  });

  it("flips a full-size card on click", async () => {
    const el = await mount({ cardId: sampleId });
    expect(el.flipped).toBe(false);
    el.querySelector<HTMLElement>(".gc-flip")!.click();
    await el.updateComplete;
    expect(el.flipped).toBe(true);
  });

  it("never flips a mini card", async () => {
    const el = await mount({ cardId: sampleId, mini: true });
    el.querySelector<HTMLElement>(".gc-flip")!.click();
    await el.updateComplete;
    expect(el.flipped).toBe(false);
  });

  it("exposes the card's rarity via data-rarity (drives the foil shine) and the back label", async () => {
    const card = getCard(sampleId, GameMode.Classic)!;
    const el = await mount({ cardId: sampleId });
    const flip = el.querySelector<HTMLElement>(".gc-flip")!;
    expect(flip.getAttribute("data-rarity")).toBe(card.rarity);
    // No gem element — rarity reads purely from the foil shine + back label.
    expect(el.querySelector(".gc-gem")).toBeNull();
    expect(el.querySelector(".gc-rarity-label")?.textContent).toBe(card.rarity);
  });
});

describe("<ac-card> renders the active mode's values", () => {
  // The only mechanical check on the ambient display mode, so it earns its place: it proves both
  // that the mode reaches the face AND that a card already on screen re-renders when it changes.
  it("drops Redline's timeout clause in Picker and keeps it in Classic", async () => {
    setCardDisplayMode(GameMode.Picker);
    const el = await mount({ cardId: "Redline" });
    expect(el.textContent).not.toContain("Time out");

    setCardDisplayMode(GameMode.Classic);
    await el.updateComplete;
    expect(el.textContent).toContain("Time out and lose 24 points");
  });

  it("honours a per-element mode override over the ambient one", async () => {
    setCardDisplayMode(GameMode.Classic);
    const el = await mount({ cardId: "Redline", mode: GameMode.Picker });
    expect(el.textContent).not.toContain("Time out");
  });
});
