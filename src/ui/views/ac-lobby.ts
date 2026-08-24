/*
 * <ac-lobby> — match setup. Edits a working copy of the settings via the shared preset bar and
 * settings sections, then emits `ac-start` with the chosen settings.
 *
 * The rows themselves live in settings-sections.ts, shared with <ac-net-lobby>. What stays here
 * is this lobby's own machinery: the draft, persistence, the row primitives it lends the shared
 * sections, and the solo-only host preferences (bots).
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { GameMode } from "../../game/types";
import type { AlphaChainSettings } from "../../game/types";
import { applyPreset, type PresetId } from "../../game/presets";
import { DEFAULT_SETTINGS, saveSettings } from "../../game/settings";
import { AcElement } from "../app/AcElement";
import type { SettingControls } from "./setting-controls";
import { renderSettingsPresets } from "./settings-presets";
import { renderHostPreferences, renderMatchRules } from "./settings-sections";

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

  /** Apply a preset's match rules. Rides the same persistence path as a single stepper — the
   *  only difference is that it writes many keys at once. The host's own preferences survive:
   *  see applyPreset. */
  private applyPreset(id: PresetId): void {
    this.draft = applyPreset(this.draft, id);
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

  /** The row primitives lent to the shared sections. */
  private get controls(): SettingControls {
    return {
      step: this.step.bind(this),
      set: this.set.bind(this),
      stepper: this.stepper.bind(this),
      segmented: this.segmented.bind(this),
      toggle: this.toggle.bind(this),
    };
  }

  override render(): TemplateResult {
    const d = this.draft;
    const c = this.controls;
    return html`
      <div class="lobby">
        <header class="lobby-head">
          <h1 class="lobby-title">ALPHA<span>CHAIN</span></h1>
          <p class="lobby-tag">Shiritori but worse</p>
        </header>

        <div class="ac-panel lobby-panel net-panel">
          <div class="net-settings">
            ${renderSettingsPresets(d, this.applyPreset.bind(this))}
            ${renderHostPreferences(d, c, { bots: true })} ${renderMatchRules(d, c)}
          </div>
        </div>

        <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>
        <button class="lobby-bay" @click=${this.openBay}>Testing Bay</button>

        <!-- Mode-specific, because the two modes ask for genuinely different things: Word Builder
             asks you to assemble a word from what you are dealt, Classic asks you to think of
             one. The succession rule and the joke are common to both. -->
        <p class="lobby-rules">
          ${d.gameMode === GameMode.Picker
            ? html`Every word must start with the last letter of the previous word — but you build
              yours from a rack of tiles, so it's your engine doing the work, not your spelling. It
              sounds simple but don't worry, I've massively overcomplicated it.`
            : html`Every word must start with the last letter of the previous word, and you type it
              yourself against the clock. It sounds simple but don't worry, I've massively
              overcomplicated it.`}
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
