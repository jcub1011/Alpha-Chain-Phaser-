/*
 * <ac-lobby> — match setup. Edits a working copy of the settings via steppers /
 * a difficulty segment, then emits `ac-start` with the chosen settings.
 */

import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AlphaChainSettings, BotDifficulty } from "../../game/types";
import { DEFAULT_SETTINGS } from "../../game/settings";
import { AcElement } from "../app/AcElement";

const DIFFS: BotDifficulty[] = ["easy", "medium", "hard"];

@customElement("ac-lobby")
export class AcLobby extends AcElement {
  @property({ attribute: false }) settings: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  @state() private draft: AlphaChainSettings = { ...DEFAULT_SETTINGS };

  override willUpdate(changed: PropertyValues): void {
    // The real settings arrive as a property after first paint; sync the draft.
    if (changed.has("settings") && this.settings) this.draft = { ...this.settings };
  }

  private step<K extends keyof AlphaChainSettings>(
    key: K,
    delta: number,
    min: number,
    max: number,
  ): void {
    const next = Math.max(min, Math.min(max, (this.draft[key] as number) + delta));
    this.draft = { ...this.draft, [key]: next };
  }

  private start(): void {
    this.dispatchEvent(
      new CustomEvent("ac-start", { detail: { ...this.draft }, bubbles: true, composed: true }),
    );
  }

  private stepper(
    label: string,
    value: string,
    onMinus: () => void,
    onPlus: () => void,
  ): TemplateResult {
    return html`
      <div class="set-row">
        <span class="set-label">${label}</span>
        <div class="set-ctl">
          <button class="set-btn" @click=${onMinus} aria-label="decrease">−</button>
          <span class="set-value">${value}</span>
          <button class="set-btn" @click=${onPlus} aria-label="increase">+</button>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const d = this.draft;
    return html`
      <div class="lobby">
        <header class="lobby-head">
          <h1 class="lobby-title">ALPHA<span>CHAIN</span></h1>
          <p class="lobby-tag">word-chain × engine-builder</p>
        </header>

        <div class="ac-panel lobby-panel">
          ${this.stepper(
            "Opponents",
            String(d.botCount),
            () => this.step("botCount", -1, 1, 5),
            () => this.step("botCount", 1, 1, 5),
          )}

          <div class="set-row">
            <span class="set-label">Difficulty</span>
            <div class="seg">
              ${DIFFS.map(
                (diff) => html`
                  <button
                    class="seg-btn ${d.botDifficulty === diff ? "is-on" : ""}"
                    @click=${() => (this.draft = { ...this.draft, botDifficulty: diff })}
                  >
                    ${diff}
                  </button>
                `,
              )}
            </div>
          </div>

          ${this.stepper(
            "Shot clock",
            `${d.shotClockSeconds}s`,
            () => this.step("shotClockSeconds", -5, 5, 60),
            () => this.step("shotClockSeconds", 5, 5, 60),
          )}
          ${this.stepper(
            "Eras",
            String(d.eraCount),
            () => this.step("eraCount", -1, 2, 6),
            () => this.step("eraCount", 1, 2, 6),
          )}
          ${this.stepper(
            "Rounds / era",
            String(d.eraInterval),
            () => this.step("eraInterval", -1, 2, 8),
            () => this.step("eraInterval", 1, 2, 8),
          )}
        </div>

        <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>

        <p class="lobby-rules">
          Chain words by their last letter. Build an engine of modifier cards.
          Beat the shot clock — and the Zero-Point Tax.
        </p>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-lobby": AcLobby;
  }
}
