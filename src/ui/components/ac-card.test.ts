// @vitest-environment happy-dom
//
// Smoke coverage for the <ac-card> Lit component — the leaf the engine bay,
// intermission, replay piles and sandbox all render. Runs in happy-dom (the rest
// of the suite is node); see the docblock directive above. This is the seam that
// lets us add further component tests without standing the whole app up.
import { beforeEach, describe, expect, it } from "vitest";
import { DEALABLE_CARD_IDS, getCard } from "../../game/cards/library";
import "./ac-card";
import type { AcCard } from "./ac-card";

const sampleId = DEALABLE_CARD_IDS[0];

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
  });

  it("renders the card name and the sprite <use> reference for a known card", async () => {
    const card = getCard(sampleId)!;
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
    const card = getCard(sampleId)!;
    const el = await mount({ cardId: sampleId });
    const flip = el.querySelector<HTMLElement>(".gc-flip")!;
    expect(flip.getAttribute("data-rarity")).toBe(card.rarity);
    // No gem element — rarity reads purely from the foil shine + back label.
    expect(el.querySelector(".gc-gem")).toBeNull();
    expect(el.querySelector(".gc-rarity-label")?.textContent).toBe(card.rarity);
  });
});
