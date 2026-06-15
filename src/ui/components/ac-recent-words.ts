/*
 * <ac-recent-words> — a horizontal feed of recent submissions, newest first.
 * Each chip shows the word, who played it, and the score (or a TAXED tag). The
 * newest chip is accented and pops in.
 */

import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { Submission } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

@customElement("ac-recent-words")
export class AcRecentWords extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private items: Submission[] = [];

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      this.items = [...this.controller.match.state.history].slice(-24).reverse();
      this.listen(this.controller.events, "submission", ({ submission }) => {
        this.items = [submission, ...this.items].slice(0, 24);
      });
    }
  }

  override render(): TemplateResult {
    if (this.items.length === 0)
      return html`<div class="recent is-empty"><span class="ac-eyebrow">no words yet</span></div>`;
    return html`
      <div class="recent" role="list">
        ${this.items.map(
          (s, i) => html`
            <div
              class="recent-item ${i === 0 ? "is-new" : ""} ${s.taxed ? "is-taxed" : ""}"
              role="listitem"
              style="--accent:${playerAccentVar(s.accentIndex)};"
            >
              <span class="recent-word">${s.word}</span>
              <span class="recent-meta">
                <span class="recent-who">${s.displayName}</span>
                ${s.taxed
                  ? html`<span class="recent-tag">TAXED</span>`
                  : html`<span class="recent-pts">+${fmtScore(s.score)}</span>`}
              </span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-recent-words": AcRecentWords;
  }
}
