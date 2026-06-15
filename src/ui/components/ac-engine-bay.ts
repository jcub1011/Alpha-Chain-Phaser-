/*
 * <ac-engine-bay> — a player's engine as a horizontal, scroll-if-needed row of
 * cards plus empty-slot placeholders up to capacity. Sizing flows to the cards
 * via --gc-w / --gc-h so the same component renders large (your bay) or compact
 * (opponent summaries). It's a pure display: all scoring animation now plays in
 * the shared "last play" theater (<ac-score-replay>), which renders its own copy
 * of the submitter's bay and walks the cards there.
 */

import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { BayCard } from "../../game/types";
import { AcElement } from "../app/AcElement";
import "./ac-card";

@customElement("ac-engine-bay")
export class AcEngineBay extends AcElement {
  @property({ attribute: false }) cards: BayCard[] = [];
  @property({ type: Number }) slots = 3;
  @property() label = "ENGINE";
  @property({ type: Boolean, reflect: true }) compact = false;

  override render(): TemplateResult {
    const empties = Math.max(0, this.slots - this.cards.length);
    return html`
      <div class="bay-head">
        <span class="ac-eyebrow">${this.label}</span>
        <span class="bay-flow">seed + Σ adds → × mults</span>
      </div>
      <div class="bay-slots" role="list">
        ${this.cards.map(
          (c, i) => html`
            <ac-card
              role="listitem"
              data-slot=${i}
              data-card-id=${c.id}
              .cardId=${c.id}
              ?isNew=${c.isNew ?? false}
              ?compact=${this.compact}
            ></ac-card>
          `,
        )}
        ${Array.from(
          { length: empties },
          () => html`<div class="bay-empty" role="listitem" aria-hidden="true"></div>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-engine-bay": AcEngineBay;
  }
}
