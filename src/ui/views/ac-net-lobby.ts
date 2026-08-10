/*
 * <ac-net-lobby> — the pre-match multiplayer surface. The owner sees the joined
 * roster + settings steppers + START MATCH (and can join as a player or sit out
 * as a shared display). Other players see the roster and wait for the owner to
 * start. Emits `ac-net-start` with the chosen settings (owner only).
 *
 * Server-authoritative: lobby powers gate on the owner (peer.isOwner), never the
 * host — in server mode there is no host client.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_SETTINGS, saveSettings } from "../../game/settings";
import type { AlphaChainSettings } from "../../game/types";
import type { ServerController } from "../../net/serverController";
import { AcElement } from "../app/AcElement";
import { RARITY_WEIGHT_BOUNDS, renderRarityWeights } from "./rarity-weights";
import { SETTING_HINTS } from "./settings-hints";

@customElement("ac-net-lobby")
export class AcNetLobby extends AcElement {
  @property({ attribute: false }) controller!: ServerController;
  @property({ attribute: false }) settings: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  @state() private draft: AlphaChainSettings = { ...DEFAULT_SETTINGS };
  private unsub?: () => void;

  override connectedCallback(): void {
    super.connectedCallback();
    // onLobbyChange fires on roster/owner changes AND (on a non-owner) when the owner's
    // settings arrive. A non-owner mirrors the owner's settings into its read-only draft;
    // the owner owns its own draft and ignores this.
    this.unsub = this.controller?.onLobbyChange(() => {
      const ls = this.controller?.lobbySettings;
      if (this.readOnly && ls) this.draft = { ...ls };
      this.requestUpdate();
    });
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
  }

  override willUpdate(changed: PropertyValues): void {
    // The persisted settings arrive as a property after first paint; sync the draft.
    // Skip on a guest once the host's settings have arrived, so we don't clobber the
    // host's choices with the guest's own local defaults.
    if (
      changed.has("settings") &&
      this.settings &&
      !(this.readOnly && this.controller?.lobbySettings)
    ) {
      this.draft = { ...this.settings };
      // Host: publish the initial / restored settings so guests see them immediately.
      this.pushSettings();
    }
  }

  override firstUpdated(): void {
    // Belt-and-suspenders: ensure the host publishes its settings even if the draft
    // was seeded before the controller property was wired up.
    this.pushSettings();
  }

  /** Owner only: publish the working settings so other players' read-only lobby mirrors
   *  them. No-op for non-owners (the controller method itself also guards on isOwner). */
  private pushSettings(): void {
    if (this.controller?.isOwner) this.controller.setLobbySettings(this.draft);
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
    this.pushSettings();
  }

  private set<K extends keyof AlphaChainSettings>(key: K, value: AlphaChainSettings[K]): void {
    this.draft = { ...this.draft, [key]: value };
    saveSettings(this.draft);
    this.pushSettings();
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

  /** Non-owners see the owner's settings but can't edit them. */
  private get readOnly(): boolean {
    return !(this.controller?.isOwner ?? false);
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
          <!-- Name the row in each button's label: the rarity group puts four near-identical
               steppers in a row, and a bare "decrease"/"increase" leaves a screen-reader user
               with eight indistinguishable buttons. -->
          <button class="set-btn" ?disabled=${ro} @click=${lo} aria-label="decrease ${label}">
            −
          </button>
          <span class="set-value" aria-live="polite">${value}</span>
          <button class="set-btn" ?disabled=${ro} @click=${hi} aria-label="increase ${label}">
            +
          </button>
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

  /** The "Rarity Weights" group — shared with the solo lobby (see rarity-weights.ts). Passing
   *  this element's own `stepper` is what keeps the guest read-only disabling. */
  private rarityWeights(): TemplateResult {
    return renderRarityWeights(
      this.draft,
      (key, delta) => this.step(key, delta, RARITY_WEIGHT_BOUNDS.min, RARITY_WEIGHT_BOUNDS.max),
      this.stepper.bind(this),
    );
  }

  override render(): TemplateResult {
    const c = this.controller;
    const roster = c?.roster ?? [];
    const isOwner = c?.isOwner ?? false;
    const ownerId = c?.ownerId ?? null;
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
              (p) =>
                html`<li>${p.displayName}${p.id === ownerId ? html` <em>(owner)</em>` : null}</li>`,
            )}
          </ul>

          <div class="net-settings">
            ${!isOwner
              ? html`<p class="set-readonly-note">
                  Settings (read-only) — the owner controls these.
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
          </div>
        </div>

        ${isOwner
          ? html`
              <button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>
              <button class="lobby-bay" @click=${this.openBay}>🧪 Testing Bay</button>
            `
          : html`<p class="lobby-rules">Waiting for the owner to start…</p>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-net-lobby": AcNetLobby;
  }
}
