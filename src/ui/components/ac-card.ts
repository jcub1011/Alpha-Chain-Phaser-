/*
 * <ac-card> — one engine-bay card, rendered in HTML/SVG. The icon is a cross-
 * document-free <use> reference into the sprite injected at boot, tinted with
 * `currentColor` (the family accent). Size comes from the parent bay via the
 * --gc-w / --gc-h custom properties, so one component serves every context.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { getCard } from "../../game/cards/library";
import { familyAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

const chipVar = (op: string): string =>
  op === "additive"
    ? "var(--ac-additive)"
    : op === "multiplicative"
      ? "var(--ac-multiplicative)"
      : "var(--ac-action)";

@customElement("ac-card")
export class AcCard extends AcElement {
  @property() cardId = "";
  @property({ type: Boolean }) isNew = false;
  /** Visual states used by the score replay. */
  @property({ type: Boolean, reflect: true }) dimmed = false;
  @property({ type: Boolean, reflect: true }) triggered = false;

  override render(): TemplateResult | typeof nothing {
    const card = getCard(this.cardId);
    if (!card) return nothing;
    const accent = familyAccentVar(card.family);
    return html`
      <div class="gc" style="--gc-accent:${accent}; color:${accent};">
        <div class="gc-top">
          <svg
            class="gc-ico"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <use href="#${this.cardId}"></use>
          </svg>
          <span class="gc-mag" style="color:${chipVar(card.op)};">${card.magnitudeText}</span>
        </div>
        <div class="gc-name">${card.name}</div>
        ${this.isNew ? html`<span class="gc-new-badge">NEW</span>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-card": AcCard;
  }
}
