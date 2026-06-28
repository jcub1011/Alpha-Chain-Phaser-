/*
 * <ac-net-lobby> — the pre-match multiplayer surface. The host sees the joined
 * roster + settings steppers + START MATCH (and can join as a player or sit out
 * as a shared display). Guests see the roster and wait for the host to start.
 * Emits `ac-net-start` with the chosen settings (host only).
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_SETTINGS, saveSettings } from "../../game/settings";
import type { AlphaChainSettings } from "../../game/types";
import type { KnockBoxController } from "../../net/knockBoxController";
import { AcElement } from "../app/AcElement";
import { SETTING_HINTS } from "./settings-hints";

@customElement("ac-net-lobby")
export class AcNetLobby extends AcElement {
  @property({ attribute: false }) controller!: KnockBoxController;
  @property({ attribute: false }) settings: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  @state() private draft: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  private unsub?: () => void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsub = this.controller?.onLobbyChange(() => this.requestUpdate());
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
  }

  override willUpdate(changed: PropertyValues): void {
    // The persisted settings arrive as a property after first paint; sync the draft.
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
      new CustomEvent("ac-net-start", { detail: { ...this.draft }, bubbles: true, composed: true }),
    );
  }

  /** Open the Testing Bay (sandbox). URL-driven so it stays bookmarkable. */
  private openBay(): void {
    location.search = "?sandbox";
  }

  /** Guests see the host's settings but can't edit them. */
  private get readOnly(): boolean {
    return !(this.controller?.isHost ?? false);
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
    lo: () => void,
    hi: () => void,
    hint?: string,
  ): TemplateResult {
    const ro = this.readOnly;
    return html`
      <div class="set-row">
        ${this.setText(label, hint)}
        <div class="set-ctl">
          <button class="set-btn" ?disabled=${ro} @click=${lo} aria-label="decrease">−</button>
          <span class="set-value">${value}</span>
          <button class="set-btn" ?disabled=${ro} @click=${hi} aria-label="increase">+</button>
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
    const ro = this.readOnly;
    return html`
      <div class="set-row set-row--seg">
        ${this.setText(label, hint)}
        <div class="seg">
          ${options.map(
            (o) =>
              html`<button
                class="seg-btn ${current === o.value ? "is-on" : ""}"
                ?disabled=${ro}
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

  override render(): TemplateResult {
    const c = this.controller;
    const roster = c?.roster ?? [];
    const isHost = c?.isHost ?? false;
    const d = this.draft;

    return html`
      <div class="lobby">
        <header class="lobby-head">
          <h1 class="lobby-title">ALPHA<span>CHAIN</span></h1>
          <p class="lobby-tag">multiplayer lobby</p>
        </header>

        <div class="ac-panel lobby-panel net-panel">
          <div class="set-row">
            <span class="set-label">Players</span> <span class="set-value">${roster.length}</span>
          </div>
          <ul class="net-roster">
            ${roster.map(
              (p, i) => html`<li>${p.displayName}${i === 0 ? html` <em>(host)</em>` : null}</li>`,
            )}
          </ul>

          <div class="net-settings">
            ${!isHost
              ? html`<p class="set-readonly-note">
                  Settings (read-only) — the host controls these.
                </p>`
              : nothing}
            ${this.stepper(
              "Shot Clock",
              `${d.shotClockSeconds}s`,
              () => this.step("shotClockSeconds", -5, 5, 60),
              () => this.step("shotClockSeconds", 5, 5, 60),
              SETTING_HINTS.shotClockSeconds,
            )}
            ${this.toggle(
              "Tutorials",
              d.enableTutorials,
              (v) => this.set("enableTutorials", v),
              SETTING_HINTS.enableTutorials,
            )}
            ${this.segmented(
              "Host plays",
              d.hostPlays ? "play" : "watch",
              [
                { value: "play", text: "yes" },
                { value: "watch", text: "spectate" },
              ],
              (v) => this.set("hostPlays", v === "play"),
              SETTING_HINTS.hostPlays,
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
          </div>
        </div>

        ${isHost
          ? html`
              <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>
              <button class="lobby-bay" @click=${this.openBay}>🧪 Testing Bay</button>
            `
          : html`<p class="lobby-rules">Waiting for the host to start…</p>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-net-lobby": AcNetLobby;
  }
}
