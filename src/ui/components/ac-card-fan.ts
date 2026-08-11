/*
 * <ac-card-fan> — a row of cards laid out as an overlapping fan that always fits its
 * width without scrolling: cards spread out (small gap) when there's room and
 * compress into an overlap when there isn't, so every card stays at least partly
 * visible. Hovering any card lifts it to the front (CSS), so a clustered card is
 * still readable. Empty-slot placeholders past `slots` join the fan too, keeping a
 * bay's remaining capacity visible. Cards may carry a `hover` chip revealed only
 * while that card is lifted (used by the word-history strip for its score deltas).
 *
 * Sizing flows from --gc-w / --gc-h on (or inherited by) this element — the same
 * vars that size <ac-card> — so the fan adapts to full, mini, and per-surface
 * overrides without hardcoding. The animated theater fan (<ac-score-replay>) shares
 * only the layout math (fanStep) and the `.card-fan` CSS; it renders its own cards.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { BayCard } from "../../game/types";
import { AcElement } from "../app/AcElement";
import { fanStep } from "./card-fan";
import "./ac-card";

export interface FanCard extends BayCard {
  /** Grayed out (e.g. a card that didn't trigger in a scoring trace). */
  dimmed?: boolean;
  /** Lit up — Picker highlights the bay cards that WOULD fire for the currently selected Offer
   *  word, which is the main way a player learns what their engine wants. Distinct from the score
   *  replay's transient `triggered`, which walks one card at a time after the fact. */
  triggered?: boolean;
  /** Content revealed in a chip above the card while it's hovered/lifted. */
  hover?: TemplateResult;
}

@customElement("ac-card-fan")
export class AcCardFan extends AcElement {
  @property({ attribute: false }) cards: FanCard[] = [];
  /** Capacity: empty placeholders fill the fan up to this count. */
  @property({ type: Number }) slots = 0;
  @property({ type: Boolean, reflect: true }) mini = false;

  /** Measured width of the fan, drives the overlap math. */
  @state() private fanWidth = 0;
  @query(".card-fan") private fanEl?: HTMLElement;

  private resizeObs?: ResizeObserver;

  override firstUpdated(): void {
    // The observer fires once on observe() with the initial size, so we don't read
    // clientWidth synchronously here (that would schedule an extra reactive update).
    this.resizeObs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w && Math.abs(w - this.fanWidth) > 0.5) this.fanWidth = w;
    });
    if (this.fanEl) this.resizeObs.observe(this.fanEl);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
  }

  /** Card footprint from the cascaded --gc-w (matches the cards' own width).
   *  CONTRACT: --gc-w must be set on an ANCESTOR of the fan (it cascades in here).
   *  `ac-card[mini]` sets --gc-w on the card itself, which does NOT reach this host —
   *  so any surface using mini cards in a fan must also restate --gc-w on an ancestor,
   *  or the overlap math silently falls back to 132 and desyncs from the real cards. */
  private cardWidth(): number {
    const w = parseFloat(getComputedStyle(this).getPropertyValue("--gc-w"));
    return Number.isFinite(w) && w > 0 ? w : 132;
  }

  override render(): TemplateResult {
    const n = this.cards.length;
    const empties = Math.max(0, this.slots - n);
    const total = n + empties;
    const step = fanStep(total, this.fanWidth, this.cardWidth());
    const at = (i: number): string => `left:${Math.round(i * step)}px; --z:${total - i};`;
    return html`
      <div class="card-fan" role="list">
        ${this.cards.map(
          (c, i) => html`
            <ac-card
              role="listitem"
              .cardId=${c.id}
              ?mini=${this.mini}
              ?dimmed=${c.dimmed ?? false}
              ?triggered=${c.triggered ?? false}
              style=${at(i)}
            ></ac-card>
            ${c.hover
              ? html`<span class="fan-chip" style=${at(i)} aria-hidden="true">${c.hover}</span>`
              : nothing}
          `,
        )}
        ${Array.from(
          { length: empties },
          (_, k) =>
            html`<div
              class="fan-empty"
              role="listitem"
              aria-hidden="true"
              style=${at(n + k)}
            ></div>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-card-fan": AcCardFan;
  }
}
