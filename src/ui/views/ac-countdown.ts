/*
 * <ac-countdown> — the "get ready" overlay shown during the Countdown phase.
 * Big ticking number, the era, and the banned letter callout for the new era.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import { AcElement } from "../app/AcElement";

@customElement("ac-countdown")
export class AcCountdown extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  @state() private n = 0;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      // The first countdownTick fires synchronously inside start()/era-advance,
      // before this element subscribes — so seed from the full count now rather
      // than flashing 0 until the next per-second tick.
      this.n = Math.ceil(this.controller.match.state.settings.preRoundCountdownSeconds);
      this.listen(this.controller.events, "countdownTick", (n) => (this.n = n));
    }
  }

  override render(): TemplateResult {
    const s = this.controller.match.state;
    return html`
      <div class="overlay countdown">
        <span class="cd-era">ERA ${s.era}</span>
        <div class="cd-num" key=${this.n}>${this.n}</div>
        <span class="cd-ready">GET READY</span>
        ${s.bannedLetter
          ? html`<div class="cd-ban">
              <span class="ac-eyebrow">zero-point tax letter</span>
              <span class="cd-ban-letter">${s.bannedLetter.toUpperCase()}</span>
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-countdown": AcCountdown;
  }
}
