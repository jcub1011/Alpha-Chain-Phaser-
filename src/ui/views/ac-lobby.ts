/*
 * <ac-lobby> — match setup. Edits a working copy of the settings via steppers /
 * a difficulty segment, then emits `ac-start` with the chosen settings.
 */

import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AlphaChainSettings, BotDifficulty } from "../../game/types";
import { DEFAULT_SETTINGS, saveSettings } from "../../game/settings";
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
    const raw = (this.draft[key] as number) + delta;
    const next = Math.round(Math.max(min, Math.min(max, raw)) * 10) / 10; // tame fp drift
    this.draft = { ...this.draft, [key]: next };
    saveSettings(this.draft);
  }

  private set<K extends keyof AlphaChainSettings>(key: K, value: AlphaChainSettings[K]): void {
    this.draft = { ...this.draft, [key]: value };
    saveSettings(this.draft);
  }

  private start(): void {
    this.dispatchEvent(
      new CustomEvent("ac-start", { detail: { ...this.draft }, bubbles: true, composed: true }),
    );
  }

  /** Open the Testing Bay (sandbox). URL-driven so it stays bookmarkable. */
  private openBay(): void {
    location.search = "?sandbox";
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

  /** A segmented control over a fixed set of options. */
  private segmented<T extends string>(
    label: string,
    current: T,
    options: { value: T; text: string }[],
    onPick: (v: T) => void,
  ): TemplateResult {
    return html`
      <div class="set-row set-row--seg">
        <span class="set-label">${label}</span>
        <div class="seg">
          ${options.map(
            (o) =>
              html`<button
                class="seg-btn ${current === o.value ? "is-on" : ""}"
                @click=${() => onPick(o.value)}
              >
                ${o.text}
              </button>`,
          )}
        </div>
      </div>
    `;
  }

  private toggle(label: string, on: boolean, set: (v: boolean) => void): TemplateResult {
    return this.segmented(
      label,
      on ? "on" : "off",
      [
        { value: "on", text: "on" },
        { value: "off", text: "off" },
      ],
      (v) => set(v === "on"),
    );
  }

  override render(): TemplateResult {
    const d = this.draft;
    return html`
      <div class="lobby">
        <header class="lobby-head">
          <h1 class="lobby-title">ALPHA<span>CHAIN</span></h1>
          <p class="lobby-tag">Shiritori but worse</p>
        </header>

        <div class="ac-panel lobby-panel net-panel">
          <div class="net-settings">
            ${this.stepper(
              "Opponents",
              String(d.botCount),
              () => this.step("botCount", -1, 1, 5),
              () => this.step("botCount", 1, 1, 5),
            )}
            ${this.segmented<BotDifficulty>(
              "Difficulty",
              d.botDifficulty,
              DIFFS.map((diff) => ({ value: diff, text: diff })),
              (v) => this.set("botDifficulty", v),
            )}
            ${this.segmented<AlphaChainSettings["banMode"]>(
              "Ban mode",
              d.banMode,
              [
                { value: "All", text: "all" },
                { value: "VowelsOnly", text: "vowels" },
                { value: "ConsonantsOnly", text: "conson." },
              ],
              (v) => this.set("banMode", v),
            )}
            ${this.stepper(
              "Shot clock",
              `${d.shotClockSeconds}s`,
              () => this.step("shotClockSeconds", -5, 5, 60),
              () => this.step("shotClockSeconds", 5, 5, 60),
            )}
            ${this.stepper(
              "Eras",
              String(d.eraCount),
              () => this.step("eraCount", -1, 1, 50),
              () => this.step("eraCount", 1, 1, 50),
            )}
            ${this.stepper(
              "Rounds / era",
              String(d.eraInterval),
              () => this.step("eraInterval", -1, 1, 50),
              () => this.step("eraInterval", 1, 1, 50),
            )}
            ${this.stepper(
              "Cards / era",
              String(d.modifiersDealtPerEra),
              () => this.step("modifiersDealtPerEra", -1, 0, 10),
              () => this.step("modifiersDealtPerEra", 1, 0, 10),
            )}
            ${this.stepper(
              "Card select",
              `${d.intermissionCardSelectSeconds}s`,
              () => this.step("intermissionCardSelectSeconds", -10, 10, 180),
              () => this.step("intermissionCardSelectSeconds", 10, 10, 180),
            )}
            ${this.stepper(
              "Sniper ban",
              `${d.sniperBanSeconds}s`,
              () => this.step("sniperBanSeconds", -5, 5, 120),
              () => this.step("sniperBanSeconds", 5, 5, 120),
            )}
            ${this.stepper(
              "Countdown",
              `${d.preRoundCountdownSeconds}s`,
              () => this.step("preRoundCountdownSeconds", -1, 3, 15),
              () => this.step("preRoundCountdownSeconds", 1, 3, 15),
            )}
            ${this.stepper(
              "Engine anim",
              `${d.engineAnimationSeconds.toFixed(1)}s`,
              () => this.step("engineAnimationSeconds", -0.5, 0.5, 10),
              () => this.step("engineAnimationSeconds", 0.5, 0.5, 10),
            )}
            ${this.toggle("Survival", d.survivalMode, (v) => this.set("survivalMode", v))}
            ${this.toggle("Tutorials", d.enableTutorials, (v) => this.set("enableTutorials", v))}
          </div>
        </div>

        <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>
        <button class="lobby-bay" @click=${this.openBay}>🧪 Testing Bay</button>

        <p class="lobby-rules">
          Every word must start with the last letter of the previous word. It sounds simple but
          don't worry, I've massively overcomplicated it.
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
