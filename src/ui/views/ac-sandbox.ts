/*
 * <ac-sandbox> — the developer "Testing Bay" (ports the Blazor AlphaChainBench).
 * Stack arbitrary modifier cards on a bay, type any word, set the turn context
 * (clock, previous-word length, tax), and see the exact ScoreBreakdown the
 * engine produces — the verification tool for card parity. Pure presentation
 * over src/game (scoreWord / armedClockSeconds); no dictionary, no networking.
 *
 * Reached with ?sandbox in the URL.
 */

import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { CARD_LIBRARY } from "../../game/cards/library";
import { armedClockSeconds, scoreWord } from "../../game/scoring";
import { DEFAULT_SETTINGS } from "../../game/settings";
import type { BayCard } from "../../game/types";
import { AcElement } from "../app/AcElement";
import "../components/ac-engine-bay";
import "../components/ac-card";

@customElement("ac-sandbox")
export class AcSandbox extends AcElement {
  @state() private bayIds: string[] = [];
  @state() private word = "elephant";
  @state() private clockTotal = 20;
  @state() private clockRemaining = 10;
  @state() private prevWordLength = 0;
  @state() private taxed = false;

  private get bay(): BayCard[] {
    return this.bayIds.map((id) => ({ id }));
  }

  private addCard(id: string): void {
    this.bayIds = [...this.bayIds, id];
  }
  private removeAt(i: number): void {
    this.bayIds = this.bayIds.filter((_, idx) => idx !== i);
  }
  private clear(): void {
    this.bayIds = [];
  }

  private num(e: Event, set: (n: number) => void): void {
    set(Number((e.target as HTMLInputElement).value));
  }

  override render(): TemplateResult {
    const breakdown = scoreWord(this.word.trim().toLowerCase(), this.bay, {
      prevWordLength: this.prevWordLength,
      clockRemaining: this.clockRemaining,
      clockTotal: this.clockTotal,
      taxed: this.taxed,
      baseClockSeconds: this.clockTotal,
    });
    const armed = armedClockSeconds(DEFAULT_SETTINGS.shotClockSeconds, this.bay);

    return html`
      <div class="sandbox">
        <header class="sandbox-head">
          <h1>Testing Bay</h1>
          <p>Stack cards, type a word, and inspect the exact score breakdown.</p>
        </header>

        <section class="sandbox-controls">
          <label>Word
            <input
              .value=${this.word}
              @input=${(e: Event) => (this.word = (e.target as HTMLInputElement).value)}
            />
          </label>
          <label>Prev word length
            <input type="number" min="0" .value=${String(this.prevWordLength)}
              @input=${(e: Event) => this.num(e, (n) => (this.prevWordLength = n))} />
          </label>
          <label>Clock remaining
            <input type="number" min="0" .value=${String(this.clockRemaining)}
              @input=${(e: Event) => this.num(e, (n) => (this.clockRemaining = n))} />
          </label>
          <label>Clock total
            <input type="number" min="1" .value=${String(this.clockTotal)}
              @input=${(e: Event) => this.num(e, (n) => (this.clockTotal = n))} />
          </label>
          <label class="sandbox-check">
            <input type="checkbox" .checked=${this.taxed}
              @change=${(e: Event) => (this.taxed = (e.target as HTMLInputElement).checked)} />
            Zero-Point Tax
          </label>
        </section>

        <section class="sandbox-bay">
          <ac-engine-bay .cards=${this.bay} .slots=${Math.max(3, this.bayIds.length)} label="TESTING BAY"></ac-engine-bay>
          <div class="sandbox-bay-actions">
            ${this.bayIds.map(
              (id, i) => html`<button class="chip" @click=${() => this.removeAt(i)} title="remove">
                ${i + 1}. ${CARD_LIBRARY[id]?.name ?? id} ✕
              </button>`,
            )}
            ${this.bayIds.length ? html`<button class="chip danger" @click=${this.clear}>clear</button>` : null}
          </div>
        </section>

        <section class="sandbox-result">
          <div class="sandbox-total">
            <span>Armed clock: <b>${armed}s</b></span>
            <span>Seed: <b>${breakdown.seed}</b></span>
            <span>Pre-tax: <b>${breakdown.finalBeforeTax}</b></span>
            <span class="big">Score: <b>${breakdown.finalScore}</b></span>
          </div>
          <ol class="sandbox-steps">
            ${breakdown.steps.map(
              (s) => html`<li class=${s.triggered ? "on" : "off"}>
                <span class="step-name">${s.name}</span>
                <span class="step-val">${s.valueText}</span>
                <span class="step-run">${s.runningScore}</span>
              </li>`,
            )}
          </ol>
        </section>

        <section class="sandbox-palette">
          <h2>Card palette</h2>
          <div class="palette-grid">
            ${Object.values(CARD_LIBRARY).map(
              (c) => html`<button class="palette-card" title=${c.description} @click=${() => this.addCard(c.id)}>
                <ac-card .cardId=${c.id} compact></ac-card>
              </button>`,
            )}
          </div>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-sandbox": AcSandbox;
  }
}
