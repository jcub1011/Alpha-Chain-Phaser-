/*
 * <ac-shot-clock> — the draining SVG ring. clockTick fires every frame, so this
 * component deliberately bypasses Lit reactivity: it holds refs to the ring and
 * the readout and writes strokeDashoffset / textContent imperatively. CSS
 * transitions smooth the motion between ticks. Color escalates go → warn → danger.
 */

import { html, svg, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import { AcElement } from "../app/AcElement";

const R = 44;
const CIRC = 2 * Math.PI * R; // 276.46

@customElement("ac-shot-clock")
export class AcShotClock extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @query(".ring-fill") private fill?: SVGCircleElement;
  @query(".ring-num") private num?: HTMLElement;
  @query(".ring") private ring?: SVGElement;

  private total = 1;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      this.listen(e, "turnArmed", ({ clockTotal }) => {
        this.total = clockTotal || 1;
        this.draw(this.controller.match.state.clockRemaining);
      });
      this.listen(e, "clockTick", (remaining) => this.draw(remaining));
      // Seed from current state on (re)bind.
      const s = this.controller.match.state;
      this.total = s.clockTotal || 1;
      this.draw(s.clockRemaining);
    }
  }

  private draw(remaining: number): void {
    if (!this.fill || !this.num || !this.ring) return;
    const frac = Math.max(0, Math.min(1, remaining / this.total));
    this.fill.style.strokeDashoffset = String(CIRC * (1 - frac));
    this.num.textContent = String(Math.ceil(Math.max(0, remaining)));
    const state = remaining <= 3 ? "danger" : remaining <= 6 ? "warn" : "go";
    this.ring.dataset.state = state;
  }

  override render(): TemplateResult {
    return html`
      <div class="clock">
        ${svg`
          <svg class="ring" data-state="go" viewBox="0 0 100 100">
            <circle class="ring-track" cx="50" cy="50" r="${R}" />
            <circle
              class="ring-fill"
              cx="50" cy="50" r="${R}"
              stroke-dasharray="${CIRC}"
              stroke-dashoffset="0"
              transform="rotate(-90 50 50)"
            />
          </svg>
        `}
        <span class="ring-num">0</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-shot-clock": AcShotClock;
  }
}
