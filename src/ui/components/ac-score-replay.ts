/*
 * <ac-score-replay> — the shared "last play" theater above the word entry. On
 * ANY player's submission it renders a copy of that player's engine bay and
 * walks the score breakdown left→right over those cards (via runEngineReplay):
 * each triggered card lifts and bursts, a chip pops off it showing its point
 * contribution, the running total ramps; skipped cards dim. A taxed word slams
 * to zero; a clean word erupts (+ confetti) — both localized to this zone so the
 * rest of the UI stays still. The last play stays on screen until the next
 * submission replaces it; leaving the Round phase clears it. The whole run is a
 * cancelable async sequencer — a new submission or phase change aborts it.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { BayCard, Submission } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";
import { resetBayCards, runEngineReplay, sleep } from "./engine-replay";
import "./ac-engine-bay";

@customElement("ac-score-replay")
export class AcScoreReplay extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private active = false;
  @state() private heading = "";
  @state() private accent = "";
  @state() private word = "";
  @state() private cards: BayCard[] = [];
  @state() private slots = 3;
  @query(".sr-num") private numEl?: HTMLElement;
  @query("ac-engine-bay") private bayEl?: HTMLElement & { updateComplete?: Promise<unknown> };

  private abort?: AbortController;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const human = this.controller.humanId;
      this.listen(this.controller.events, "submission", ({ submission }) => {
        void this.run(submission, submission.playerId === human);
      });
      // Leaving the Round phase (intermission / countdown / game over) clears it.
      this.listen(this.controller.events, "phaseChanged", () => this.hide());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.abort?.abort();
  }

  private hide(): void {
    this.abort?.abort();
    this.resetCards();
    this.active = false;
  }

  private resetCards(): void {
    if (this.bayEl) resetBayCards(this.bayEl);
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

  private async run(sub: Submission, isHuman: boolean): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const signal = ac.signal;

    // Render a copy of the submitter's engine (their current bay matches the
    // breakdown's step order — both flow from the same player state).
    const player = this.controller.match.state.players.find((p) => p.id === sub.playerId);
    this.cards = player ? [...player.bay] : [];
    this.slots = player?.slots ?? this.cards.length;
    this.heading = isHuman ? "YOUR ENGINE" : `${sub.displayName}'s engine`;
    this.accent = playerAccentVar(sub.accentIndex);
    this.word = sub.word.toUpperCase();
    this.active = true;
    this.numEl?.classList.remove("is-final", "is-taxed");

    await this.updateComplete;
    await this.bayEl?.updateComplete; // ensure the copied cards are in the DOM
    if (signal.aborted) return;
    this.resetCards();
    if (this.numEl) this.numEl.textContent = fmtScore(sub.breakdown.seed);

    if (prefersReducedMotion()) {
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      this.numEl?.classList.add(sub.taxed ? "is-taxed" : "is-final");
      return;
    }

    const steps = sub.breakdown.steps.length;
    const stepMs = Math.max(
      180,
      (this.controller.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, steps),
    );

    await sleep(260, signal);

    const theater = this.querySelector<HTMLElement>(".sr") ?? undefined;
    if (this.bayEl) {
      await runEngineReplay(this.bayEl, sub, {
        signal,
        stepMs,
        shakeTarget: theater,
        onStep: (step, prevRunning) =>
          this.ramp(prevRunning, step.runningScore, Math.min(stepMs * 0.7, 520), signal),
      });
    }

    if (signal.aborted) return;

    if (sub.taxed) {
      // Crash the pre-tax total down to zero.
      this.numEl?.classList.add("is-taxed");
      await this.ramp(sub.breakdown.finalBeforeTax, 0, 420, signal);
      fx.shake(0.8, theater);
      await sleep(500, signal);
    } else {
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      this.numEl?.classList.add("is-final");
      const r = (this.bayEl ?? this.numEl)?.getBoundingClientRect();
      if (r) {
        fx.eruption(r, Math.min(1, sub.score / 300));
        if (sub.score >= 150) fx.confettiAt(r, Math.min(1, sub.score / 300));
        if (sub.score >= 120) fx.shake(Math.min(0.7, sub.score / 360), theater);
      }
    }

    if (signal.aborted) return;
    // Leave the finished play on screen (cards at rest) until the next one.
    this.resetCards();
  }

  override render(): TemplateResult {
    return html`
      <div class="sr ${this.active ? "is-active" : ""}" style="--sr-accent:${this.accent};">
        ${this.active
          ? html`
              <div class="sr-head">
                <span class="sr-who">${this.heading}</span>
                <span class="sr-word">${this.word}</span>
              </div>
              <ac-engine-bay class="sr-bay" .cards=${this.cards} .slots=${this.slots}></ac-engine-bay>
              <div class="sr-total"><span class="sr-num">0</span></div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-score-replay": AcScoreReplay;
  }
}
