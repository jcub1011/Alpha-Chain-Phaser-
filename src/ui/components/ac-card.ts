/*
 * <ac-card> — one engine-bay card, rendered in HTML/SVG to mirror the Blazor
 * GameCard. The icon is a cross-document-free <use> reference into the sprite
 * injected at boot. Two colors drive the look: the family accent (--gc-accent,
 * the border) and the card's own identity color (--gc-card-color, the gradient
 * / icon box / watermark tint); the latter falls back to the accent.
 *
 * Front face: a faint watermark glyph, an icon-in-a-box + type/magnitude chips,
 * the name, and a clamped description teaser. Back face: name + full rules text.
 * Full-size cards flip on click; compact cards reveal the text on hover.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { getCard } from "../../game/cards/library";
import type { ClockModifier } from "../../game/cards/card";
import { familyAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

const chipVar = (op: string): string =>
  op === "additive"
    ? "var(--ac-additive)"
    : op === "multiplicative"
      ? "var(--ac-multiplicative)"
      : "var(--ac-action)";

/** A compact "−20% ⏱" / "+5s ⏱" clock chip for glass-cannon / utility cards. */
const clockText = (clock: ClockModifier): string => {
  const parts: string[] = [];
  if (clock.pctDelta) parts.push(`${clock.pctDelta > 0 ? "+" : "−"}${Math.round(Math.abs(clock.pctDelta) * 100)}%`);
  if (clock.flatDelta) parts.push(`${clock.flatDelta > 0 ? "+" : "−"}${Math.abs(clock.flatDelta)}s`);
  return `${parts.join(" ")} ⏱`;
};

@customElement("ac-card")
export class AcCard extends AcElement {
  @property() cardId = "";
  @property({ type: Boolean }) isNew = false;
  /** Compact cards (opponent summaries) reveal their text on hover, not flip. */
  @property({ type: Boolean, reflect: true }) compact = false;
  /** Mini cards (the engine-replay piles): icon + magnitude + name only, no flip. */
  @property({ type: Boolean, reflect: true }) mini = false;
  /** Whether the card is showing its back (rules text). Full-size only. */
  @property({ type: Boolean, reflect: true }) flipped = false;
  /** Visual states used by the score replay. */
  @property({ type: Boolean, reflect: true }) dimmed = false;
  @property({ type: Boolean, reflect: true }) triggered = false;

  private onFlip = (): void => {
    if (this.compact || this.mini) return;
    this.flipped = !this.flipped;
  };

  override render(): TemplateResult | typeof nothing {
    const card = getCard(this.cardId);
    if (!card) return nothing;
    const accent = familyAccentVar(card.family);
    const cardColor = card.color ?? accent;
    const chip = chipVar(card.op);
    return html`
      <div
        class="gc-flip"
        style="--gc-accent:${accent}; --gc-card-color:${cardColor}; color:${accent};"
        @click=${this.onFlip}
      >
        <div class="gc gc-front">
          <svg class="gc-watermark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <use href="#${this.cardId}"></use>
          </svg>
          <div class="gc-top">
            <span class="gc-ico-box">
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
            </span>
            <div class="gc-chips">
              <span class="gc-chip" style="--chip:${chip};">${card.magnitudeText}</span>
              ${card.clock
                ? html`<span class="gc-chip" style="--chip:var(--ac-accent-clock);"
                    >${clockText(card.clock)}</span
                  >`
                : nothing}
            </div>
          </div>
          <div class="gc-name">${card.name}</div>
          <p class="gc-front-desc">${card.description}</p>
          ${this.isNew ? html`<span class="gc-new-badge">NEW</span>` : nothing}
          ${this.compact ? nothing : html`<span class="gc-flip-hint">tap to flip</span>`}
        </div>
        <div class="gc gc-back">
          <span class="gc-back-name">${card.name}</span>
          <p class="gc-desc">${card.description}</p>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-card": AcCard;
  }
}
