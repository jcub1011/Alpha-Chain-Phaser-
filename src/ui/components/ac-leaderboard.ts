/*
 * <ac-leaderboard> — live standings. Re-renders only on low-frequency events
 * (turn changes, submissions, timeouts). The active player's row glows; the
 * human's row is bordered; a mint score-pop floats up on each fresh submission.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { PlayerState } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

@customElement("ac-leaderboard")
export class AcLeaderboard extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  @property({ type: Boolean, reflect: true }) strip = false;

  @state() private rows: PlayerState[] = [];
  @state() private activeId = "";
  @state() private pop: { id: string; amount: number; key: number } | null = null;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const refresh = (): void => {
        this.rows = this.controller.match.standings();
        this.activeId = this.controller.match.current?.id ?? "";
      };
      this.listen(e, "turnArmed", refresh);
      this.listen(e, "timeout", refresh);
      this.listen(e, "phaseChanged", refresh);
      this.listen(e, "submission", ({ submission }) => {
        refresh();
        if (submission.score > 0)
          this.pop = { id: submission.playerId, amount: submission.score, key: submission.breakdown.seed + Date.now() };
      });
      refresh();
    }
  }

  override render(): TemplateResult {
    const human = this.controller?.humanId;
    return html`
      <ol class="lb">
        ${this.rows.map((p, rank) => {
          const accent = playerAccentVar(p.accentIndex);
          const isMe = p.id === human;
          const isActive = p.id === this.activeId;
          return html`
            <li
              class="lb-row ${isActive ? "is-active" : ""} ${isMe ? "is-me" : ""} ${p.eliminated ? "is-out" : ""}"
              style="--accent:${accent};"
            >
              <span class="lb-rank">${rank + 1}</span>
              <span class="lb-name">${p.name}${isMe ? html`<i> you</i>` : nothing}</span>
              ${p.eliminated ? html`<span class="lb-tag">OUT</span>` : nothing}
              <span class="lb-score">${fmtScore(p.score)}</span>
              ${this.pop && this.pop.id === p.id
                ? html`<span class="lb-pop" @animationend=${() => (this.pop = null)}
                    >+${fmtScore(this.pop.amount)}</span
                  >`
                : nothing}
            </li>
          `;
        })}
      </ol>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-leaderboard": AcLeaderboard;
  }
}
