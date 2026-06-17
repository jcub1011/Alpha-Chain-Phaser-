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

  /** Window listener for the deferred score reveal (engine-replay completion). */
  private onRevealed?: (e: Event) => void;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      this.items = [...this.controller.match.state.history].slice(-24).reverse();

      // Prepend a word only when its engine replay finishes (ac-score-revealed),
      // not on the raw `submission` event — otherwise the chip's score spoils the
      // result before the animation lands. Mirrors <ac-leaderboard>.
      if (this.onRevealed) window.removeEventListener("ac-score-revealed", this.onRevealed);
      this.onRevealed = (ev: Event): void => {
        const sub = (ev as CustomEvent<{ submission: Submission }>).detail?.submission;
        if (!sub || sub.timedOut) return; // a timeout is no word — keep it out of the feed
        // Guard against a double-dispatch (e.g. two theaters): skip if this exact
        // submission is already at the head rather than listing the word twice.
        const head = this.items[0];
        const dup =
          head &&
          head.playerId === sub.playerId &&
          head.word === sub.word &&
          head.breakdown.seed === sub.breakdown.seed;
        if (!dup) this.items = [sub, ...this.items].slice(0, 24);
      };
      window.addEventListener("ac-score-revealed", this.onRevealed);

      // Safety net for any reveal that didn't fire (e.g. an aborted replay): resync
      // from history at phase boundaries only. Safe there because the era-end
      // transition already waits out the replay; resyncing on turnArmed would spoil
      // (history is credited immediately on submission).
      this.listen(this.controller.events, "phaseChanged", () => {
        this.items = [...this.controller.match.state.history].slice(-24).reverse();
      });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.onRevealed) window.removeEventListener("ac-score-revealed", this.onRevealed);
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
