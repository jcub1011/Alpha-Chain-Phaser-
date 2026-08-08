/*
 * <ac-lobby> — match setup. Edits a working copy of the settings via steppers /
 * a difficulty segment, then emits `ac-start` with the chosen settings.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AlphaChainSettings, BotDifficulty } from "../../game/types";
import { DEFAULT_SETTINGS, saveSettings } from "../../game/settings";
import { AcElement } from "../app/AcElement";
import { RARITY_WEIGHT_BOUNDS, renderRarityWeights } from "./rarity-weights";
import { SETTING_HINTS } from "./settings-hints";

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

  /** Label + a subtext line carrying the setting's explanation. */
  private setText(label: string, hint?: string): TemplateResult {
    return html`<div class="set-text">
      <span class="set-label">${label}</span>
      ${hint ? html`<span class="set-desc">${hint}</span>` : nothing}
    </div>`;
  }

  private stepper(
    label: string,
    value: string,
    onMinus: () => void,
    onPlus: () => void,
    hint?: string,
  ): TemplateResult {
    return html`
      <div class="set-row">
        ${this.setText(label, hint)}
        <div class="set-ctl">
          <!-- Name the row in each button's label: the rarity group puts four near-identical
               steppers in a row, and a bare "decrease"/"increase" leaves a screen-reader user
               with eight indistinguishable buttons. -->
          <button class="set-btn" @click=${onMinus} aria-label="decrease ${label}">−</button>
          <span class="set-value" aria-live="polite">${value}</span>
          <button class="set-btn" @click=${onPlus} aria-label="increase ${label}">+</button>
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
    hint?: string,
  ): TemplateResult {
    return html`
      <div class="set-row set-row--seg">
        ${this.setText(label, hint)}
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

  private toggle(
    label: string,
    on: boolean,
    set: (v: boolean) => void,
    hint?: string,
  ): TemplateResult {
    return this.segmented(
      label,
      on ? "on" : "off",
      [
        { value: "on", text: "on" },
        { value: "off", text: "off" },
      ],
      (v) => set(v === "on"),
      hint,
    );
  }

  /** The "Rarity Weights" group — shared with the multiplayer lobby (see rarity-weights.ts). */
  private rarityWeights(): TemplateResult {
    return renderRarityWeights(
      this.draft,
      (key, delta) => this.step(key, delta, RARITY_WEIGHT_BOUNDS.min, RARITY_WEIGHT_BOUNDS.max),
      this.stepper.bind(this),
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
              SETTING_HINTS.botCount,
            )}
            ${this.segmented<BotDifficulty>(
              "Difficulty",
              d.botDifficulty,
              DIFFS.map((diff) => ({ value: diff, text: diff })),
              (v) => this.set("botDifficulty", v),
              SETTING_HINTS.botDifficulty,
            )}
            ${this.stepper(
              "Shot Clock",
              `${d.shotClockSeconds}s`,
              () => this.step("shotClockSeconds", -5, 5, 60),
              () => this.step("shotClockSeconds", 5, 5, 60),
              SETTING_HINTS.shotClockSeconds,
            )}
            ${this.segmented<AlphaChainSettings["banMode"]>(
              "Letter Ban Mode",
              d.banMode,
              [
                { value: "All", text: "all" },
                { value: "VowelsOnly", text: "vowels" },
                { value: "ConsonantsOnly", text: "conson." },
              ],
              (v) => this.set("banMode", v),
              SETTING_HINTS.banMode,
            )}
            ${this.segmented<AlphaChainSettings["banRepeatRule"]>(
              "Letter Ban Repeats",
              d.banRepeatRule,
              [
                { value: "AllowRepeat", text: "allow" },
                { value: "NoConsecutive", text: "no consec." },
                { value: "NoRepeat", text: "never" },
              ],
              (v) => this.set("banRepeatRule", v),
              SETTING_HINTS.banRepeatRule,
            )}
            ${this.stepper(
              "Letter Ban Time",
              `${d.sniperBanSeconds}s`,
              () => this.step("sniperBanSeconds", -5, 5, 120),
              () => this.step("sniperBanSeconds", 5, 5, 120),
              SETTING_HINTS.sniperBanSeconds,
            )}
            ${this.stepper(
              "Eras",
              String(d.eraCount),
              () => this.step("eraCount", -1, 1, 50),
              () => this.step("eraCount", 1, 1, 50),
              SETTING_HINTS.eraCount,
            )}
            ${this.stepper(
              "Rounds Per Era",
              String(d.eraInterval),
              () => this.step("eraInterval", -1, 1, 50),
              () => this.step("eraInterval", 1, 1, 50),
              SETTING_HINTS.eraInterval,
            )}
            ${this.stepper(
              "Cards Per Era",
              String(d.modifiersDealtPerEra),
              () => this.step("modifiersDealtPerEra", -1, 0, 10),
              () => this.step("modifiersDealtPerEra", 1, 0, 10),
              SETTING_HINTS.modifiersDealtPerEra,
            )}
            ${this.rarityWeights()}
            ${this.stepper(
              "Starting Slots",
              String(d.modifierSlotsStart),
              () => this.step("modifierSlotsStart", -1, 1, 20),
              () => this.step("modifierSlotsStart", 1, 1, 20),
              SETTING_HINTS.modifierSlotsStart,
            )}
            ${this.stepper(
              "Slots Increase Every",
              d.slotIncreaseEveryNEras === 0
                ? "Never"
                : `${d.slotIncreaseEveryNEras} era${d.slotIncreaseEveryNEras === 1 ? "" : "s"}`,
              () => this.step("slotIncreaseEveryNEras", -1, 0, 20),
              () => this.step("slotIncreaseEveryNEras", 1, 0, 20),
              SETTING_HINTS.slotIncreaseEveryNEras,
            )}
            ${this.stepper(
              "Slots Per Increase",
              String(d.slotIncreaseAmount),
              () => this.step("slotIncreaseAmount", -1, 1, 10),
              () => this.step("slotIncreaseAmount", 1, 1, 10),
              SETTING_HINTS.slotIncreaseAmount,
            )}
            ${this.stepper(
              "Max Slots",
              String(d.modifierSlotsMax),
              () => this.step("modifierSlotsMax", -1, 1, 20),
              () => this.step("modifierSlotsMax", 1, 1, 20),
              SETTING_HINTS.modifierSlotsMax,
            )}
            ${this.toggle(
              "Start With Engine Cards",
              d.dealEngineCardsFirstEra,
              (v) => this.set("dealEngineCardsFirstEra", v),
              SETTING_HINTS.dealEngineCardsFirstEra,
            )}
            ${this.stepper(
              "Engine Management Time",
              `${d.intermissionCardSelectSeconds}s`,
              () => this.step("intermissionCardSelectSeconds", -10, 10, 180),
              () => this.step("intermissionCardSelectSeconds", 10, 10, 180),
              SETTING_HINTS.intermissionCardSelectSeconds,
            )}
            ${this.stepper(
              "Engine Animation Duration",
              `${d.engineAnimationSeconds.toFixed(1)}s`,
              () => this.step("engineAnimationSeconds", -0.5, 0.5, 10),
              () => this.step("engineAnimationSeconds", 0.5, 0.5, 10),
              SETTING_HINTS.engineAnimationSeconds,
            )}
            ${this.stepper(
              "Countdown",
              `${d.preRoundCountdownSeconds}s`,
              () => this.step("preRoundCountdownSeconds", -1, 3, 15),
              () => this.step("preRoundCountdownSeconds", 1, 3, 15),
              SETTING_HINTS.preRoundCountdownSeconds,
            )}
            ${this.toggle(
              "Survival Mode",
              d.survivalMode,
              (v) => this.set("survivalMode", v),
              SETTING_HINTS.survivalMode,
            )}
            ${this.toggle(
              "Tutorials",
              d.enableTutorials,
              (v) => this.set("enableTutorials", v),
              SETTING_HINTS.enableTutorials,
            )}
          </div>
        </div>

        <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>
        <button class="lobby-bay" @click=${this.openBay}>Testing Bay</button>

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
