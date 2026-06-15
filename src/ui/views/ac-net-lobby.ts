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
    const next = Math.max(min, Math.min(max, (this.draft[key] as number) + delta));
    this.draft = { ...this.draft, [key]: next };
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

        <div class="ac-panel lobby-panel">
          <div class="set-row"><span class="set-label">Players</span>
            <span class="set-value">${roster.length}</span></div>
          <ul class="net-roster">
            ${roster.map(
              (p, i) => html`<li>${p.displayName}${i === 0 ? html` <em>(host)</em>` : null}</li>`,
            )}
          </ul>

          ${isHost
            ? html`
                ${this.stepper("Shot clock", `${d.shotClockSeconds}s`,
                  () => this.step("shotClockSeconds", -5, 5, 60),
                  () => this.step("shotClockSeconds", 5, 5, 60))}
                ${this.stepper("Eras", String(d.eraCount),
                  () => this.step("eraCount", -1, 2, 6),
                  () => this.step("eraCount", 1, 2, 6))}
                ${this.stepper("Rounds / era", String(d.eraInterval),
                  () => this.step("eraInterval", -1, 2, 8),
                  () => this.step("eraInterval", 1, 2, 8))}
                <div class="set-row">
                  <span class="set-label">Host plays</span>
                  <div class="seg">
                    <button class="seg-btn ${d.hostPlays ? "is-on" : ""}"
                      @click=${() => (this.draft = { ...d, hostPlays: true })}>yes</button>
                    <button class="seg-btn ${!d.hostPlays ? "is-on" : ""}"
                      @click=${() => (this.draft = { ...d, hostPlays: false })}>spectate</button>
                  </div>
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
