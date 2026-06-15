/*
 * <ac-net-lobby> — the pre-match multiplayer surface. The host sees the joined
 * roster + settings steppers + START MATCH (and can join as a player or sit out
 * as a shared display). Guests see the roster and wait for the host to start.
 * Emits `ac-net-start` with the chosen settings (host only).
 */

import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_SETTINGS } from "../../game/settings";
import type { AlphaChainSettings } from "../../game/types";
import type { KnockBoxController } from "../../net/knockBoxController";
import { AcElement } from "../app/AcElement";

@customElement("ac-net-lobby")
export class AcNetLobby extends AcElement {
  @property({ attribute: false }) controller!: KnockBoxController;
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

  private step<K extends keyof AlphaChainSettings>(key: K, delta: number, min: number, max: number): void {
    const raw = (this.draft[key] as number) + delta;
    const next = Math.round(Math.max(min, Math.min(max, raw)) * 10) / 10; // tame fp drift
    this.draft = { ...this.draft, [key]: next };
  }

  private set<K extends keyof AlphaChainSettings>(key: K, value: AlphaChainSettings[K]): void {
    this.draft = { ...this.draft, [key]: value };
  }

  private start(): void {
    this.dispatchEvent(
      new CustomEvent("ac-net-start", { detail: { ...this.draft }, bubbles: true, composed: true }),
    );
  }

  private stepper(label: string, value: string, lo: () => void, hi: () => void): TemplateResult {
    return html`
      <div class="set-row">
        <span class="set-label">${label}</span>
        <div class="set-ctl">
          <button class="set-btn" @click=${lo} aria-label="decrease">−</button>
          <span class="set-value">${value}</span>
          <button class="set-btn" @click=${hi} aria-label="increase">+</button>
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
            (o) => html`<button
              class="seg-btn ${current === o.value ? "is-on" : ""}"
              @click=${() => onPick(o.value)}
            >${o.text}</button>`,
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
          <div class="set-row"><span class="set-label">Players</span>
            <span class="set-value">${roster.length}</span></div>
          <ul class="net-roster">
            ${roster.map(
              (p, i) => html`<li>${p.displayName}${i === 0 ? html` <em>(host)</em>` : null}</li>`,
            )}
          </ul>

          ${isHost
            ? html`
              <div class="net-settings">
                ${this.segmented<AlphaChainSettings["banMode"]>("Ban mode", d.banMode,
                  [
                    { value: "All", text: "all" },
                    { value: "VowelsOnly", text: "vowels" },
                    { value: "ConsonantsOnly", text: "conson." },
                  ],
                  (v) => this.set("banMode", v))}
                ${this.stepper("Shot clock", `${d.shotClockSeconds}s`,
                  () => this.step("shotClockSeconds", -5, 5, 60),
                  () => this.step("shotClockSeconds", 5, 5, 60))}
                ${this.stepper("Eras", String(d.eraCount),
                  () => this.step("eraCount", -1, 1, 50),
                  () => this.step("eraCount", 1, 1, 50))}
                ${this.stepper("Rounds / era", String(d.eraInterval),
                  () => this.step("eraInterval", -1, 1, 50),
                  () => this.step("eraInterval", 1, 1, 50))}
                ${this.stepper("Cards / era", String(d.modifiersDealtPerEra),
                  () => this.step("modifiersDealtPerEra", -1, 0, 10),
                  () => this.step("modifiersDealtPerEra", 1, 0, 10))}
                ${this.stepper("Card select", `${d.intermissionCardSelectSeconds}s`,
                  () => this.step("intermissionCardSelectSeconds", -10, 10, 180),
                  () => this.step("intermissionCardSelectSeconds", 10, 10, 180))}
                ${this.stepper("Sniper ban", `${d.sniperBanSeconds}s`,
                  () => this.step("sniperBanSeconds", -5, 5, 120),
                  () => this.step("sniperBanSeconds", 5, 5, 120))}
                ${this.stepper("Countdown", `${d.preRoundCountdownSeconds}s`,
                  () => this.step("preRoundCountdownSeconds", -1, 3, 15),
                  () => this.step("preRoundCountdownSeconds", 1, 3, 15))}
                ${this.stepper("Engine anim", `${d.engineAnimationSeconds.toFixed(1)}s`,
                  () => this.step("engineAnimationSeconds", -0.5, 0.5, 10),
                  () => this.step("engineAnimationSeconds", 0.5, 0.5, 10))}
                ${this.toggle("Survival", d.survivalMode, (v) => this.set("survivalMode", v))}
                ${this.toggle("Tutorials", d.enableTutorials, (v) => this.set("enableTutorials", v))}
                ${this.segmented("Host plays", d.hostPlays ? "play" : "watch",
                  [
                    { value: "play", text: "yes" },
                    { value: "watch", text: "spectate" },
                  ],
                  (v) => this.set("hostPlays", v === "play"))}
              </div>
              `
            : null}
        </div>

        ${isHost
          ? html`<button class="ac-btn lobby-start" @click=${this.start}>START MATCH</button>`
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
