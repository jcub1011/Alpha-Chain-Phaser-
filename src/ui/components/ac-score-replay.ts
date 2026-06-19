/*
 * <ac-score-replay> — the shared "last play" theater above the word entry. On
 * ANY player's submission it shows that player's engine as an overlapping fan of
 * mini-cards on the LEFT with the running score on the RIGHT. The score breakdown
 * then walks the fan left → right (via runEngineReplay): each card lights up in
 * place (lift + glow), pops a chip with its point contribution, bursts particles,
 * and ramps the running total; skipped cards take a beat but change nothing. The
 * fan compresses its spacing so it always fits one line (mobile or desktop) — the
 * left-most card sits on top, and hovering any card lifts it to the front so it can
 * be read even when clustered. Cards that didn't activate gray out as the walk
 * passes them; every card consumes the same beat whether it fired or not. A taxed
 * word slams the total to zero; a clean word erupts (+ confetti) — both localized to
 * this zone. The theater is always visible: between plays it shows the human's own
 * engine (centered score when the bay is empty). The whole run is a cancelable async
 * sequencer.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { BayCard, EngineEffectNotice, Submission } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";
import { runEngineReplay } from "./engine-replay";
import { fanStep } from "./card-fan";
import "./ac-card";

/** Mini-card footprint (keep in sync with `--mini-w` in hud.css). */
const MINI_W = 132;

@customElement("ac-score-replay")
export class AcScoreReplay extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private active = false;
  @state() private heading = "";
  @state() private accent = "";
  @state() private word = "";
  @state() private cards: BayCard[] = [];
  /** Index of the card currently firing (gets the lift + glow), or -1. */
  @state() private current = -1;
  /** Highest card index the walk has reached; cards ≤ this that didn't activate
   *  gray out. -1 means nothing resolved yet (idle / pre-walk). */
  @state() private revealed = -1;
  /** Per-card activation flags for the play being replayed (by bay index). Empty
   *  while idle, so the engine preview shows every card at full strength. */
  @state() private activated: boolean[] = [];
  /** Measured width of the fan, drives the overlap math. */
  @state() private fanWidth = 0;
  /** Off-turn effects (siphons banked + aggression hits) that fired as this word
   *  resolved — shown once the engine walk settles, empty while idle. */
  @state() private effects: EngineEffectNotice[] = [];
  @query(".sr-num") private numEl?: HTMLElement;
  @query(".sr-fan") private fanEl?: HTMLElement;

  private abort?: AbortController;
  private resizeObs?: ResizeObserver;

  override firstUpdated(): void {
    this.resizeObs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w && Math.abs(w - this.fanWidth) > 0.5) this.fanWidth = w;
    });
    if (this.fanEl) this.resizeObs.observe(this.fanEl);
  }

  override updated(changed: Map<string, unknown>): void {
    // The fan element comes and goes with `active`; (re)observe it once present.
    if (this.fanEl && this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs.observe(this.fanEl);
      const w = this.fanEl.clientWidth;
      if (w && Math.abs(w - this.fanWidth) > 0.5) this.fanWidth = w;
    }
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const human = this.controller.humanId;
      this.listen(this.controller.events, "submission", ({ submission }) => {
        void this.run(submission, submission.playerId === human);
      });
      // A phase change (intermission / countdown / game over) ends the current
      // replay; the theater stays up showing the human's own engine.
      this.listen(this.controller.events, "phaseChanged", () => this.showIdle());
      this.showIdle();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.abort?.abort();
    this.resizeObs?.disconnect();
  }

  /** Drop back to the always-on idle view: the human's current engine, no
   *  highlight or graying, score reset to zero. */
  private showIdle(): void {
    this.abort?.abort();
    const human = this.controller?.match.state.players.find(
      (p) => p.id === this.controller.humanId,
    );
    this.cards = human ? [...human.bay] : [];
    this.activated = [];
    this.effects = [];
    this.current = -1;
    this.revealed = -1;
    this.heading = "YOUR ENGINE";
    this.word = "";
    this.accent = human ? playerAccentVar(human.accentIndex) : "";
    this.active = true;
    void this.updateComplete.then(() => {
      this.numEl?.classList.remove("is-final", "is-taxed");
      if (this.numEl) {
        this.numEl.style.minWidth = ""; // release the per-play width reservation
        this.numEl.textContent = "0";
      }
    });
  }

  /** Horizontal advance per card so the whole fan fits `fanWidth`: spread out when
   *  there's room, compress (overlap) when there isn't. Shared with <ac-card-fan>. */
  private step(): number {
    return fanStep(this.cards.length, this.fanWidth, MINI_W);
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
    this.activated = sub.breakdown.steps.map((s) => s.triggered);
    this.effects = [];
    this.current = -1;
    this.revealed = -1;
    this.heading = sub.timedOut
      ? "TIMED OUT"
      : isHuman
        ? "YOUR ENGINE"
        : `${sub.displayName}'s engine`;
    this.accent = playerAccentVar(sub.accentIndex);
    this.word = sub.word.toUpperCase();
    this.active = true;
    this.numEl?.classList.remove("is-final", "is-taxed");

    await this.updateComplete;
    if (signal.aborted) return;
    if (this.numEl) {
      // Reserve space for the widest number this play will display so the fan
      // doesn't shift as the readout gains digits. The peak is the largest
      // formatted string across seed, every running-score step, and the final.
      const widest = [
        sub.breakdown.seed,
        sub.breakdown.finalBeforeTax,
        sub.score,
        ...sub.breakdown.steps.map((s) => s.runningScore),
      ]
        .map(fmtScore)
        .reduce((a, b) => (b.length > a.length ? b : a), "");
      this.numEl.style.minWidth = "0px"; // clear any prior reservation before measuring
      this.numEl.textContent = widest;
      this.numEl.style.minWidth = `${this.numEl.offsetWidth}px`;
      this.numEl.textContent = fmtScore(sub.breakdown.seed);
    }

    if (prefersReducedMotion()) {
      this.revealed = this.cards.length - 1; // gray out every card that didn't fire
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      // A taxed word that still scored positive (e.g. Tax Write-Off salvage) reads
      // as a partial, not a wipe — amber, not red.
      const partial = sub.taxed && sub.score > 0;
      this.numEl?.classList.add(
        partial ? "is-partial" : sub.taxed || sub.timedOut ? "is-taxed" : "is-final",
      );
      this.effects = sub.effects ?? [];
      this.announceRevealed(sub);
      return;
    }

    // Per-card beat scales down with card count so the whole walk fits the
    // configured engineAnimationSeconds budget regardless of how many cards fire.
    const steps = sub.breakdown.steps.length;
    const stepMs =
      (this.controller.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, steps);

    const theater = this.querySelector<HTMLElement>(".sr") ?? undefined;
    if (this.fanEl) {
      await runEngineReplay(sub, {
        signal,
        stepMs,
        fan: this.fanEl,
        shakeTarget: theater,
        onEnter: async (i) => {
          this.current = i;
          this.revealed = Math.max(this.revealed, i);
          await this.updateComplete;
        },
        onStep: (step, prevRunning) =>
          this.ramp(prevRunning, step.runningScore, Math.min(stepMs, 640), signal),
      });
    }

    if (signal.aborted) return;
    this.current = -1;
    this.revealed = this.cards.length - 1; // settle: non-activated cards stay gray

    if (sub.taxed && sub.score > 0) {
      // Taxed, but a salvage (e.g. Tax Write-Off) kept some points: crash the
      // pre-tax total down to the reduced score and settle in the partial (amber)
      // style — it scored, just not fully.
      this.numEl?.classList.add("is-partial");
      await this.ramp(sub.breakdown.finalBeforeTax, sub.score, 420, signal);
      fx.shake(0.4, theater);
    } else if (sub.taxed) {
      // Crash the pre-tax total down to zero.
      this.numEl?.classList.add("is-taxed");
      await this.ramp(sub.breakdown.finalBeforeTax, 0, 420, signal);
      fx.shake(0.8, theater);
      await new Promise((r) => setTimeout(r, 500));
    } else if (sub.timedOut) {
      // Settle on the net (negative) penalty in the taxed/red style — the per-card
      // red drains already popped during the walk.
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      this.numEl?.classList.add("is-taxed");
      if (sub.score < 0) fx.shake(Math.min(0.7, Math.abs(sub.score) / 80), theater);
    } else {
      if (this.numEl) this.numEl.textContent = fmtScore(sub.score);
      this.numEl?.classList.add("is-final");
      // Erupt from the score readout itself — not the whole stage, whose center
      // drifts to the HUD middle once the engine fan takes up the left side.
      const r = (this.numEl ?? this.querySelector(".sr-stage"))?.getBoundingClientRect();
      if (r) {
        fx.eruption(r, Math.min(1, sub.score / 300));
        if (sub.score >= 150) fx.confettiAt(r, Math.min(1, sub.score / 300));
        if (sub.score >= 120) fx.shake(Math.min(0.7, sub.score / 360), theater);
      }
    }

    if (signal.aborted) return;
    this.effects = sub.effects ?? [];
    this.announceRevealed(sub);
  }

  /** The replay for `sub` has fully settled — let the leaderboard reveal the score
   *  now, instead of the instant the submission landed (which spoils the result). */
  private announceRevealed(sub: Submission): void {
    this.dispatchEvent(
      new CustomEvent<{ submission: Submission }>("ac-score-revealed", {
        detail: { submission: sub },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    const n = this.cards.length;
    const step = this.step();
    return html`
      <div class="sr ${this.active ? "is-active" : ""}" style="--sr-accent:${this.accent};">
        ${this.active
          ? html`
              <div class="sr-head">
                <span class="sr-who">${this.heading}</span>
                <span class="sr-word">${this.word}</span>
              </div>
              <div class="sr-stage ${n === 0 ? "is-empty" : ""}">
                ${n > 0
                  ? html`<div class="sr-fan card-fan">
                      ${this.cards.map((c, j) => {
                        const fired = this.activated[j] === true;
                        const isCurrent = j === this.current;
                        return html`<ac-card
                          mini
                          .cardId=${c.id}
                          ?triggered=${isCurrent && fired}
                          ?dimmed=${j <= this.revealed && !fired}
                          style="left:${Math.round(j * step)}px; --z:${isCurrent ? 500 : n - j};"
                        ></ac-card>`;
                      })}
                    </div>`
                  : nothing}
                <div class="sr-num">0</div>
              </div>
              <!-- Always rendered: a hidden placeholder pill reserves the row so the
                   strip appearing on a play never shifts the layout below it. -->
              <div class="sr-effects">
                ${this.effects.length
                  ? this.effects.map((eff) => {
                      const tgt = this.controller.match.state.players.find(
                        (p) => p.id === eff.targetId,
                      );
                      const who = tgt?.id === this.controller.humanId ? "You" : (tgt?.name ?? "");
                      return html`<div
                        class="sr-effect ${eff.reflected ? "is-reflected" : ""}"
                        style="--accent:${tgt ? playerAccentVar(tgt.accentIndex) : ""};"
                      >
                        ${eff.reflected ? "⛊ " : ""}<b>${eff.source}</b> → ${who} · ${eff.text}
                      </div>`;
                    })
                  : html`<div class="sr-effect is-placeholder" aria-hidden="true">·</div>`}
              </div>
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
