/*
 * <ac-engine-bay> — a player's engine as an overlapping card fan (<ac-card-fan>)
 * plus empty-slot placeholders up to capacity. The fan compresses to always fit
 * one line (no scrolling) and lifts the hovered card to the front. Sizing flows to
 * the cards via --gc-w / --gc-h so the same component renders large (your bay) or
 * mini (opponent / standings summaries). It's a pure display: all scoring animation
 * now plays in the shared "last play" theater (<ac-score-replay>), which renders
 * its own copy of the submitter's bay and walks the cards there.
 */

import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { BayCard } from "../../game/types";
import { AcElement } from "../app/AcElement";
import "./ac-card-fan";

@customElement("ac-engine-bay")
export class AcEngineBay extends AcElement {
  @property({ attribute: false }) cards: BayCard[] = [];
  @property({ type: Number }) slots = 3;
  @property() label = "ENGINE";
  @property({ type: Boolean, reflect: true }) mini = false;

  override render(): TemplateResult {
    return html`
      <div class="bay-head">
        <span class="ac-eyebrow">${this.label}</span>
        <span class="bay-flow">evaluated left → right</span>
      </div>
      <ac-card-fan .cards=${this.cards} .slots=${this.slots} ?mini=${this.mini}></ac-card-fan>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-engine-bay": AcEngineBay;
  }
}
