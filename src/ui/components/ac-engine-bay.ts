/*
 * <ac-engine-bay> — a player's engine as a horizontal, scroll-if-needed row of
 * cards plus empty-slot placeholders up to capacity. Sizing flows to the cards
 * via --gc-w / --gc-h so the same component renders large (your bay) or compact
 * (opponent summaries). The human's bay (.mine) is animated by <ac-score-replay>;
 * opponent bays mark themselves `live` and replay their own owner's scores in
 * place (compact), so every player's engine fires when they score.
 */

import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { BayCard, Submission } from "../../game/types";
import type { GameController } from "../../net/controller";
import { fmtScore } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { AcElement } from "../app/AcElement";
import { resetBayCards, runEngineReplay, sleep } from "./engine-replay";
import "./ac-card";

@customElement("ac-engine-bay")
export class AcEngineBay extends AcElement {
  @property({ attribute: false }) cards: BayCard[] = [];
  @property({ type: Number }) slots = 3;
  @property() label = "ENGINE";
  @property({ type: Boolean, reflect: true }) compact = false;

  /** Set on opponent bays so they self-animate their owner's submissions. */
  @property({ attribute: false }) controller?: GameController;
  @property() playerId = "";
  @property({ type: Boolean }) live = false;

  @state() private replayActive = false;
  @state() private replayTotal = 0;

  private abort?: AbortController;

  override willUpdate(changed: PropertyValues): void {
    if ((changed.has("controller") || changed.has("playerId")) && this.live && this.controller && this.playerId) {
      this.clearSubs();
      this.listen(this.controller.events, "submission", ({ submission }) => {
        if (submission.playerId === this.playerId) void this.runReplay(submission);
      });
      this.listen(this.controller.events, "phaseChanged", () => this.cancelReplay());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelReplay();
  }

  private slotsEl(): Element | null {
    return this.querySelector(".bay-slots");
  }

  private cancelReplay(): void {
    this.abort?.abort();
    const el = this.slotsEl();
    if (el) resetBayCards(el);
    this.replayActive = false;
  }

  private async runReplay(sub: Submission): Promise<void> {
    if (prefersReducedMotion()) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const signal = ac.signal;

    await this.updateComplete; // ensure the latest cards are rendered
    const el = this.slotsEl();
    if (!el) return;
    resetBayCards(el);
    this.replayActive = true;
    this.replayTotal = sub.breakdown.seed;

    const steps = sub.breakdown.steps.length;
    const stepMs = Math.max(
      130,
      (this.controller!.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, steps),
    );

    await runEngineReplay(el, sub, {
      signal,
      stepMs,
      compact: true,
      onStep: (step) => {
        this.replayTotal = step.runningScore;
      },
    });
    if (signal.aborted) return;

    this.replayTotal = sub.taxed ? 0 : sub.breakdown.finalScore;
    await sleep(800, signal);
    if (signal.aborted) return;
    this.replayActive = false;
    resetBayCards(el);
  }

  override render(): TemplateResult {
    const empties = Math.max(0, this.slots - this.cards.length);
    return html`
      <div class="bay-head">
        <span class="ac-eyebrow">${this.label}</span>
        ${this.replayActive
          ? html`<span class="bay-total ${this.replayTotal === 0 ? "is-taxed" : ""}"
              >${fmtScore(this.replayTotal)}</span
            >`
          : html`<span class="bay-flow">seed + Σ adds → × mults</span>`}
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
