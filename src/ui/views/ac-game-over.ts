/*
 * <ac-game-over> — final standings. Celebrates a human win with confetti and a
 * VICTORY banner; otherwise names the winner. Emits `ac-return` to go back to
 * the lobby.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { PlayerState } from "../../game/types";
import { fmtDuration, fmtScore, playerAccentVar } from "../app/util";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";
import "../components/ac-word-history";
import "../components/ac-engine-bay";

@customElement("ac-game-over")
export class AcGameOver extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  @state() private standings: PlayerState[] = [];
  @state() private winnerId: string | null = null;
  @state() private wordsPlayed = new Map<string, number>();
  @state() private totalWords = 0;
  @state() private durationMs = 0;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const s = this.controller.match.state;
      this.standings = this.controller.match.standings();
      this.winnerId = s.winnerId;
      this.totalWords = s.history.length;
      this.durationMs = s.startedAt && s.endedAt ? s.endedAt - s.startedAt : 0;
      const counts = new Map<string, number>();
      for (const h of s.history) counts.set(h.playerId, (counts.get(h.playerId) ?? 0) + 1);
      this.wordsPlayed = counts;
      if (this.winnerId === this.controller.humanId) fx.confetti(1600);
    }
  }

  override render(): TemplateResult {
    const human = this.controller.humanId;
    const youWon = this.winnerId === human;
    const winner = this.standings.find((p) => p.id === this.winnerId);
    return html`
      <div class="overlay gameover">
        <div class="go-card ac-panel">
          <span class="ac-eyebrow">match complete</span>
          <h1 class="go-title ${youWon ? "is-win" : ""}">${youWon ? "VICTORY" : "GAME OVER"}</h1>
          ${winner && !youWon
            ? html`<p class="go-winner">${winner.name} takes the match.</p>`
            : nothing}

          <ol class="go-standings">
            ${this.standings.map(
              (p, i) => html`
                <li
                  class="go-row ${i === 0 ? "is-first" : ""} ${p.id === human ? "is-me" : ""}"
                  style="--accent:${playerAccentVar(p.accentIndex)};"
                >
                  <div class="go-row-main">
                    <span class="go-rank">${i + 1}</span>
                    <span class="go-name"
                      >${p.name}${p.id === human ? html`<i> you</i>` : nothing}${p.eliminated
                        ? html`<span class="go-out">out</span>`
                        : nothing}</span
                    >
                    <span class="go-words">${this.wordsPlayed.get(p.id) ?? 0} words</span>
                    <span class="go-score">${fmtScore(p.score)}</span>
                  </div>
                  <ac-engine-bay
                    class="go-row-engine"
                    mini
                    .cards=${p.bay}
                    .slots=${p.slots}
                    label="engine"
                  ></ac-engine-bay>
                </li>
              `,
            )}
          </ol>

          <p class="go-totals">
            ${this.totalWords} words
            played${this.durationMs > 0 ? html` · ${fmtDuration(this.durationMs)}` : nothing}
          </p>

          <button
            class="ac-btn go-return"
            @click=${() =>
              this.dispatchEvent(new CustomEvent("ac-return", { bubbles: true, composed: true }))}
          >
            RETURN TO LOBBY
          </button>
        </div>

        <div class="go-breakdown ac-panel">
          <ac-word-history .history=${this.controller.match.state.history}></ac-word-history>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-game-over": AcGameOver;
  }
}
