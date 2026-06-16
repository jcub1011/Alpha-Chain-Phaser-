/*
 * <ac-card> — one engine-bay card, rendered in HTML/SVG to mirror the Blazor
 * GameCard. The icon is a cross-document-free <use> reference into the sprite
 * injected at boot. Two colors drive the look: the family accent (--gc-accent,
 * the border) and the card's own identity color (--gc-card-color, the gradient
 * / icon box / watermark tint); the latter falls back to the accent.
 *
 * Front face: a faint watermark glyph, the bare icon + type/magnitude chips,
 * the name (shrunk to fit one line), and a clamped description teaser. Back face:
 * name + full rules text. Full-size cards flip on click; mini cards (opponent
 * bays, sandbox, the replay piles) drop the inline description and instead
 * reveal it as a hover tooltip overlay (the back-face markup, repurposed).
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
  if (clock.pctDelta)
    parts.push(`${clock.pctDelta > 0 ? "+" : "−"}${Math.round(Math.abs(clock.pctDelta) * 100)}%`);
  if (clock.flatDelta)
    parts.push(`${clock.flatDelta > 0 ? "+" : "−"}${Math.abs(clock.flatDelta)}s`);
  return `${parts.join(" ")} ⏱`;
};

@customElement("ac-card")
export class AcCard extends AcElement {
  @property() cardId = "";
  @property({ type: Boolean }) isNew = false;
  /** Mini cards (opponent bays, sandbox, replay piles): icon + magnitude + name
   *  only — no description, flip, or back face. Full width but shorter. */
  @property({ type: Boolean, reflect: true }) mini = false;
  /** Whether the card is showing its back (rules text). Full-size only. */
  @property({ type: Boolean, reflect: true }) flipped = false;
  /** Visual states used by the score replay. */
  @property({ type: Boolean, reflect: true }) dimmed = false;
  @property({ type: Boolean, reflect: true }) triggered = false;

  private onFlip = (): void => {
    if (this.mini) return;
    this.flipped = !this.flipped;
  };

  /** Refits the title whenever the card resizes (responsive --gc-w/--gc-h). */
  private resizeObs?: ResizeObserver;

  override firstUpdated(): void {
    const flip = this.querySelector<HTMLElement>(".gc-flip");
    if (flip && typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.fitName());
      this.resizeObs.observe(flip);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
  }

  override updated(): void {
    this.fitName();
  }

  /** Shrink the front title's font until it fits on one line. Font width scales
   *  linearly with font-size, so one ratio pass (one reflow) is enough. Mini
   *  cards skip this — their titles wrap freely since no description crowds them. */
  private fitName = (): void => {
    if (this.mini) return;
    const el = this.querySelector<HTMLElement>(".gc-name");
    if (!el) return;
    el.style.fontSize = ""; // reset to the CSS-driven size before measuring
    const avail = el.clientWidth;
    const needed = el.scrollWidth;
    if (avail > 0 && needed > avail) {
      const base = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = `${Math.max(base * (avail / needed) * 0.98, 8)}px`;
    }
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
          <svg
            class="gc-watermark"
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
          ${this.mini ? nothing : html`<span class="gc-flip-hint">tap to flip</span>`}
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
