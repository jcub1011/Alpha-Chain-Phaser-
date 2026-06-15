/*
 * <ac-intermission> — between eras. Two sub-phases:
 *   1. optimize — reorder your engine (drag, or ◄/► nudges) and drop overflow
 *      past your slot capacity; lock in writes the order back via setPlayerBay.
 *   2. sniper ban — the last-place player taxes a letter for the next era. If
 *      that's you, pick from the legal grid; if it's a bot, it auto-picks.
 * Each sub-phase has a countdown that applies a sensible default on timeout.
 * State is derived from the match (the 'intermission' event fires before this
 * mounts), so we read computeLastPlaceId() / the bay directly.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import { legalBanLetters } from "../../game/settings";
import { AcElement } from "../app/AcElement";
import "../components/ac-card";

type Sub = "optimize" | "ban" | "ban-wait";

@customElement("ac-intermission")
export class AcIntermission extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private sub: Sub = "optimize";
  @state() private order: string[] = [];
  @state() private slots = 3;
  @state() private seconds = 0;
  @state() private bannerName = "";

  private dragId: string | null = null;
  private timer = 0;
  private deadline = 0;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const m = this.controller.match;
      const me = m.state.players.find((p) => p.id === this.controller.humanId);
      this.order = me ? me.bay.map((b) => b.id) : [];
      this.slots = me?.slots ?? 3;
      this.startTimer(m.state.settings.intermissionCardSelectSeconds, () => this.lockIn());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopTimer();
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  private startTimer(secs: number, onEnd: () => void): void {
    this.stopTimer();
    this.deadline = performance.now() + secs * 1000;
    this.seconds = Math.ceil(secs);
    this.timer = window.setInterval(() => {
      const left = Math.max(0, this.deadline - performance.now());
      this.seconds = Math.ceil(left / 1000);
      if (left <= 0) {
        this.stopTimer();
        onEnd();
      }
    }, 200);
  }

  private stopTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  // ── Reorder ──────────────────────────────────────────────────────────────
  private move(id: string, dir: -1 | 1): void {
    const i = this.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.order.length) return;
    const next = [...this.order];
    [next[i], next[j]] = [next[j], next[i]];
    this.order = next;
  }

  private onDragStart(id: string): void {
    this.dragId = id;
  }

  private onDrop(targetId: string): void {
    if (!this.dragId || this.dragId === targetId) return;
    const from = this.order.indexOf(this.dragId);
    const to = this.order.indexOf(targetId);
    const next = this.order.filter((x) => x !== this.dragId);
    // Insert after the target when dragging rightward, before it otherwise —
    // so a card dragged onto the last slot lands at the very end of the list.
    const idx = next.indexOf(targetId) + (from < to ? 1 : 0);
    next.splice(idx, 0, this.dragId);
    this.order = next;
    this.dragId = null;
  }

  // ── Phase transitions ──────────────────────────────────────────────────────
  private lockIn(): void {
    this.stopTimer();
    const m = this.controller.match;
    m.setPlayerBay(this.controller.humanId, this.order);
    const lastId = m.computeLastPlaceId();
    if (lastId === this.controller.humanId) {
      this.sub = "ban";
      this.startTimer(m.state.settings.sniperBanSeconds, () => this.pickBan(m.randomBanLetter()));
    } else {
      this.bannerName = m.state.players.find((p) => p.id === lastId)?.name ?? "Opponent";
      this.sub = "ban-wait";
      const wait = Math.min(2.5, m.state.settings.sniperBanSeconds);
      this.startTimer(wait, () => this.pickBan(m.randomBanLetter()));
    }
  }

  private pickBan(letter: string): void {
    this.stopTimer();
    this.controller.match.applySniperBanAndAdvance(letter);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  private renderOptimize(): TemplateResult {
    return html`
      <div class="im-card ac-panel">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · optimize</span>
          <h2 class="im-title">Tune your engine</h2>
          <p class="im-sub">
            Cards score left → right. Keep adders left, multipliers right. Drag or use ◄ ► —
            anything past slot ${this.slots} is discarded.
          </p>
          <span class="im-timer">${this.seconds}s</span>
        </header>

        <div class="im-bay">
          ${this.order.map((id, i) => {
            const discard = i >= this.slots;
            return html`
              <div
                class="im-slot ${discard ? "is-discard" : ""}"
                draggable="true"
                @dragstart=${() => this.onDragStart(id)}
                @dragover=${(e: DragEvent) => e.preventDefault()}
                @drop=${() => this.onDrop(id)}
              >
                <span class="im-slot-no">${discard ? "✕" : i + 1}</span>
                <ac-card .cardId=${id}></ac-card>
                <div class="im-nudge">
                  <button @click=${() => this.move(id, -1)} aria-label="move left">◄</button>
                  <button @click=${() => this.move(id, 1)} aria-label="move right">►</button>
                </div>
              </div>
              ${i === this.slots - 1 && this.order.length > this.slots
                ? html`<div class="im-divider" aria-hidden="true"></div>`
                : nothing}
            `;
          })}
          ${this.order.length === 0
            ? html`<p class="im-empty">No cards yet — they're dealt at the next intermission.</p>`
            : nothing}
        </div>

        <button class="ac-btn im-lock" @click=${() => this.lockIn()}>LOCK IN</button>
      </div>
    `;
  }

  private renderBan(): TemplateResult {
    const mode = this.controller.match.state.settings.banMode;
    const letters = legalBanLetters(mode);
    return html`
      <div class="im-card ac-panel">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · sniper ban</span>
          <h2 class="im-title">You're last — strike back</h2>
          <p class="im-sub">Choose a letter. Words containing it score zero next era.</p>
          <span class="im-timer">${this.seconds}s</span>
        </header>
        <div class="ban-grid">
          ${letters.map(
            (l) => html`<button class="ban-key" @click=${() => this.pickBan(l)}>${l.toUpperCase()}</button>`,
          )}
        </div>
      </div>
    `;
  }

  private renderBanWait(): TemplateResult {
    return html`
      <div class="im-card ac-panel im-wait">
        <span class="ac-eyebrow">intermission · sniper ban</span>
        <div class="im-spinner"></div>
        <h2 class="im-title">${this.bannerName} is choosing a banned letter…</h2>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="overlay intermission">
        ${this.sub === "optimize"
          ? this.renderOptimize()
          : this.sub === "ban"
            ? this.renderBan()
            : this.renderBanWait()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-intermission": AcIntermission;
  }
}
