/*
 * <ac-game-over> — final standings. Celebrates a human win with confetti and a
 * VICTORY banner; otherwise names the winner. Emits `ac-return` to go back to
 * the lobby.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { PlayerState } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { fx } from "../fx/fx";
import { AcElement } from "../app/AcElement";

@customElement("ac-game-over")
export class AcGameOver extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  @state() private standings: PlayerState[] = [];
  @state() private winnerId: string | null = null;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const s = this.controller.match.state;
      this.standings = this.controller.match.standings();
      this.winnerId = s.winnerId;
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
                  <span class="go-rank">${i + 1}</span>
                  <span class="go-name"
                    >${p.name}${p.id === human ? html`<i> you</i>` : nothing}</span
                  >
                  <span class="go-score">${fmtScore(p.score)}</span>
                </li>
              `,
            )}
          </ol>

          <button
            class="ac-btn go-return"
            @click=${() =>
              this.dispatchEvent(new CustomEvent("ac-return", { bubbles: true, composed: true }))}
          >
            RETURN TO LOBBY
          </button>
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
