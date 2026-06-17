/*
 * <ac-word-history> — the post-game word log (port of the Blazor
 * SubmissionHistoryPanel). Every accepted word with its score and the engine
 * (Engine Bay scoring trace) that produced it, so players can review which
 * engine designs actually worked. Three sort orders, defaulting to
 * highest-scoring first. The engine strip mirrors <ac-score-replay> statically
 * (no animation): a "len N" seed marker, each card with its delta + running
 * chips (dimmed when it didn't trigger), then a final score / tax end-cap.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Submission } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";
import type { FanCard } from "./ac-card-fan";
import "./ac-card-fan";

type SortOrder = "high" | "old" | "new";

@customElement("ac-word-history")
export class AcWordHistory extends AcElement {
  /** The match's full submission history (chronological, oldest → newest). */
  @property({ attribute: false }) history: Submission[] = [];

  @state() private sort: SortOrder = "high";

  /** Pair each entry with its chronological index so ties (and the time-based
   *  orders) stay stable, mirroring the Blazor Resort(). */
  private sorted(): Submission[] {
    const indexed = this.history.map((s, i) => ({ s, i }));
    switch (this.sort) {
      case "old":
        indexed.sort((a, b) => a.i - b.i);
        break;
      case "new":
        indexed.sort((a, b) => b.i - a.i);
        break;
      default:
        indexed.sort((a, b) => b.s.score - a.s.score || a.i - b.i);
    }
    return indexed.map((x) => x.s);
  }

  private renderRow(s: Submission): TemplateResult {
    const b = s.breakdown;
    // The engine cards as an overlapping fan; each card's delta + running-score
    // chip is revealed on hover (no room for it inline once cards overlap).
    const fanCards: FanCard[] = b.steps.map((step) => ({
      id: step.cardId,
      dimmed: !step.triggered,
      hover: html`
        <span class="go-wh-delta">${step.triggered ? step.valueText : "—"}</span>
        <span class="go-wh-run">${fmtScore(step.runningScore)}</span>
      `,
    }));
    return html`
      <div class="go-wh-row" style="--accent:${playerAccentVar(s.accentIndex)};">
        <div class="go-wh-main">
          <span class="go-wh-word ${s.taxed ? "is-taxed" : ""}">${s.word.toUpperCase()}</span>
          <span class="go-wh-who">${s.displayName}</span>
          ${s.taxed
            ? html`<span class="go-wh-tax"
                >${s.score > 0 ? `tax +${fmtScore(s.score)}` : "tax"}</span
              >`
            : html`<span class="go-wh-pts">+${fmtScore(s.score)}</span>`}
        </div>

        <div class="go-wh-strip">
          <span class="go-wh-seed">
            <span class="go-wh-op">len</span>
            <span class="go-wh-run">${b.seed}</span>
          </span>
          ${b.steps.length === 0
            ? html`<ac-card-fan mini .slots=${1}></ac-card-fan>`
            : html`<ac-card-fan mini .cards=${fanCards}></ac-card-fan>`}
          <span class="go-wh-final ${b.taxed ? "is-taxed" : ""}">
            <span class="go-wh-op">${b.taxed ? "tax" : "score"}</span>
            <span class="go-wh-run"
              >${b.taxed && b.finalScore <= 0 ? "0" : `+${fmtScore(b.finalScore)}`}</span
            >
          </span>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const empty = this.history.length === 0;
    const btn = (order: SortOrder, label: string): TemplateResult => html`
      <button
        type="button"
        class="go-sort-btn ${this.sort === order ? "is-active" : ""}"
        @click=${() => (this.sort = order)}
      >
        ${label}
      </button>
    `;
    return html`
      <header class="go-wh-head">
        <h3 class="go-section-head ac-eyebrow">word history</h3>
        ${empty
          ? nothing
          : html`<div class="go-sort" role="group" aria-label="Sort word history">
              ${btn("high", "Highest")}${btn("old", "Oldest")}${btn("new", "Newest")}
            </div>`}
      </header>
      ${empty
        ? html`<p class="go-wh-empty">No words were submitted.</p>`
        : html`<div class="go-wh-list">${this.sorted().map((s) => this.renderRow(s))}</div>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-word-history": AcWordHistory;
  }
}
