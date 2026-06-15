/*
 * <ac-score-replay> — the signature moment. On a human submission it walks the
 * score breakdown left→right over the real bay cards: each triggered card lifts
 * and bursts, a value chip pops off it, and the running total ramps up; skipped
 * cards dim. A taxed word slams to zero; a clean word erupts (+ confetti scaled
 * to magnitude). The whole run is a cancelable async sequencer — a new
 * submission or phase change aborts it and snaps the cards back to rest.
 */

import { html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { Submission } from "../../game/types";
import { familyAccentColor, fmtScore } from "../app/util";
import { getCard } from "../../game/cards/library";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(t);
      resolve();
    }, { once: true });
  });

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

  private cards(): HTMLElement[] {
    const bay = document.querySelector("ac-engine-bay.mine");
    return bay ? Array.from(bay.querySelectorAll("ac-card")) : [];
  }

  private resetCards(): void {
    for (const c of this.cards()) {
      c.removeAttribute("triggered");
      c.removeAttribute("dimmed");
    }
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

  /** Pop a value chip off a card's center, floating up and fading. */
  private chip(rect: DOMRect, text: string, color: string): void {
    if (prefersReducedMotion()) return;
    const el = document.createElement("span");
    el.className = "sr-chip";
    el.textContent = text;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.top + rect.height * 0.3}px`;
    el.style.color = color;
    document.body.appendChild(el);
    const anim = el.animate(
      [
        { transform: "translate(-50%, 0) scale(0.6)", opacity: 0 },
        { transform: "translate(-50%, -10px) scale(1.15)", opacity: 1, offset: 0.25 },
        { transform: "translate(-50%, -46px) scale(1)", opacity: 0 },
      ],
      { duration: 900, easing: "cubic-bezier(0.2,0.8,0.2,1)" },
    );
    anim.onfinish = () => el.remove();
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

    const cards = this.cards();
    const steps = sub.breakdown.steps;
    const total = Math.max(sub.breakdown.finalScore, sub.breakdown.finalBeforeTax, 1);
    const stepMs = Math.max(180, (this.controller.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, steps.length));

    let prev = sub.breakdown.seed;
    await sleep(260, signal);

    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return;
      const step = steps[i];
      const card = cards[i];
      const def = getCard(step.cardId);
      const color = def ? `var(--ac-accent-${def.family})` : "var(--ac-accent-neutral)";
      const colorNum = familyAccentColor(def?.family ?? "neutral");

      if (!step.triggered) {
        card?.setAttribute("dimmed", "");
        await sleep(stepMs * 0.5, signal);
        continue;
      }

      card?.setAttribute("triggered", "");
      const rect = card?.getBoundingClientRect();
      const delta = step.runningScore - prev;
      const intensity = Math.min(1, 0.3 + Math.abs(delta) / Math.max(40, total));
      if (rect) {
        this.chip(rect, step.valueText, color);
        fx.burstAt(rect, intensity, colorNum);
      }
      if (delta >= 60) fx.shake(Math.min(1, delta / 200));
      await this.ramp(prev, step.runningScore, Math.min(stepMs * 0.7, 520), signal);
      prev = step.runningScore;
      await sleep(stepMs * 0.3, signal);
      card?.removeAttribute("triggered");
    }

    if (signal.aborted) return;

    if (sub.taxed) {
      // Crash the pre-tax total down to zero.
      this.numEl?.classList.add("is-taxed");
      await this.ramp(prev, 0, 420, signal);
      fx.shake(0.8);
      await sleep(700, signal);
      this.numEl?.classList.remove("is-taxed");
    } else {
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
