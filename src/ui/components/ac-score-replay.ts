/*
 * <ac-score-replay> — the signature moment. On a human submission it walks the
 * score breakdown left→right over the real bay cards (via the shared
 * runEngineReplay): each triggered card lifts and bursts, a chip pops off it
 * showing its point contribution, and the running total ramps up; skipped cards
 * dim. A taxed word slams to zero; a clean word erupts (+ confetti scaled to
 * magnitude). The whole run is a cancelable async sequencer — a new submission
 * or phase change aborts it and snaps the cards back to rest.
 */

import { html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { Submission } from "../../game/types";
import { fmtScore } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";
import { resetBayCards, runEngineReplay, sleep } from "./engine-replay";

@customElement("ac-score-replay")
export class AcScoreReplay extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private active = false;
  @state() private word = "";
  @query(".sr-num") private numEl?: HTMLElement;

  private abort?: AbortController;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const human = this.controller.humanId;
      this.listen(this.controller.events, "submission", ({ submission }) => {
        if (submission.playerId === human) void this.run(submission);
      });
      // Any phase change (turn passing into intermission/over) ends a run.
      this.listen(this.controller.events, "phaseChanged", () => this.cancel());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancel();
  }

  private cancel(): void {
    this.abort?.abort();
    this.resetCards();
    this.active = false;
  }

  private bay(): Element | null {
    return document.querySelector("ac-engine-bay.mine");
  }

  private resetCards(): void {
    const bay = this.bay();
    if (bay) resetBayCards(bay);
  }

  /** Tween the big readout from `from` to `to` over `ms`, abortable. */
  private ramp(from: number, to: number, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (!this.numEl || prefersReducedMotion() || ms <= 0) {
        if (this.numEl) this.numEl.textContent = fmtScore(to);
        return resolve();
      }
      const start = performance.now();
      const tick = (now: number): void => {
        if (signal.aborted) return resolve();
        const t = Math.min(1, (now - start) / ms);
        const eased = 1 - Math.pow(1 - t, 3);
        this.numEl!.textContent = fmtScore(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private async run(sub: Submission): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const signal = ac.signal;

    this.resetCards();
    this.word = sub.word.toUpperCase();
    this.active = true;
    await this.updateComplete;
    if (this.numEl) this.numEl.textContent = fmtScore(sub.breakdown.seed);

    if (prefersReducedMotion()) {
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      await sleep(900, signal);
      if (!signal.aborted) this.active = false;
      return;
    }

    const steps = sub.breakdown.steps.length;
    const stepMs = Math.max(
      180,
      (this.controller.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, steps),
    );

    await sleep(260, signal);

    const bay = this.bay();
    if (bay) {
      await runEngineReplay(bay, sub, {
        signal,
        stepMs,
        onStep: (step, prevRunning) =>
          this.ramp(prevRunning, step.runningScore, Math.min(stepMs * 0.7, 520), signal),
      });
    }

    if (signal.aborted) return;

    if (sub.taxed) {
      // Crash the pre-tax total down to zero.
      this.numEl?.classList.add("is-taxed");
      await this.ramp(sub.breakdown.finalBeforeTax, 0, 420, signal);
      fx.shake(0.8);
      await sleep(700, signal);
      this.numEl?.classList.remove("is-taxed");
    } else {
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      this.numEl?.classList.add("is-final");
      if (this.numEl) {
        const r = this.numEl.getBoundingClientRect();
        fx.eruption(r, Math.min(1, sub.score / 300));
        if (sub.score >= 150) fx.confetti(900);
      }
      await sleep(900, signal);
      this.numEl?.classList.remove("is-final");
    }

    if (signal.aborted) return;
    this.resetCards();
    this.active = false;
  }

  override render(): TemplateResult {
    return html`
      <div class="sr ${this.active ? "is-active" : ""}">
        <div class="sr-word">${this.word}</div>
        <div class="sr-total"><span class="sr-num">0</span></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-score-replay": AcScoreReplay;
  }
}
