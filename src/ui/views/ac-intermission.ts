/*
 * <ac-intermission> — between eras. The sub-phase walk (optimize → [tax tutorial]
 * → sniper ban) and its timers are now host-authoritative in the MatchController;
 * this view is a thin renderer of the synced `intermissionPhase`:
 *   • optimize — reorder your engine (drag, or ◄/► nudges) and drop overflow past
 *     your slot capacity; the order is committed to the host on every change.
 *   • sniper ban — the last-place player taxes a letter for the next era. If
 *     that's you, pick from the legal grid; otherwise you wait. The host applies a
 *     random legal ban if the timer runs out.
 * The tutorial sub-phases render the optimize bay underneath the <ac-tutorial>
 * overlay (mounted by <ac-app>). The countdown shown is the synced sub-timer.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import { LocalController } from "../../net/localController";
import { legalBanLetters } from "../../game/settings";
import { AcElement } from "../app/AcElement";
import "../components/ac-card";

@customElement("ac-intermission")
export class AcIntermission extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private order: string[] = [];
  @state() private slots = 3;

  private dragId: string | null = null;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const me = this.controller.match.state.players.find((p) => p.id === this.controller.humanId);
      this.order = me ? me.bay.map((b) => b.id) : [];
      this.slots = me?.slots ?? 3;
      // Re-render the countdown whenever the synced sub-timer ticks; the FSM owns
      // the authoritative dwell (per-frame event, never broadcast over the network).
      this.clearSubs();
      this.listen(this.controller.match.events, "subTimerTick", () => this.requestUpdate());
    }
  }

  private get seconds(): number {
    return Math.ceil(this.controller.match.state.subTimerRemaining);
  }

  // ── Reorder (committed to the host on every change) ──────────────────────────
  private commit(): void {
    this.controller.match.setPlayerBay(this.controller.humanId, this.order);
  }

  private move(id: string, dir: -1 | 1): void {
    const i = this.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.order.length) return;
    const next = [...this.order];
    [next[i], next[j]] = [next[j], next[i]];
    this.order = next;
    this.commit();
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
    this.commit();
  }

  /** LOCK IN: commit the order; in solo, fast-forward the optimize dwell. */
  private lockIn(): void {
    this.commit();
    if (this.controller instanceof LocalController) this.controller.match.skipOptimize();
  }

  private pickBan(letter: string): void {
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
            Cards score left → right. Drag or use ◄ ► — anything past slot ${this.slots} is
            discarded.
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
            (l) =>
              html`<button class="ban-key" @click=${() => this.pickBan(l)}>
                ${l.toUpperCase()}
              </button>`,
          )}
        </div>
      </div>
    `;
  }

  private renderBanWait(): TemplateResult {
    const m = this.controller.match;
    const lastId = m.computeLastPlaceId();
    const name = m.state.players.find((p) => p.id === lastId)?.name ?? "Opponent";
    return html`
      <div class="im-card ac-panel im-wait">
        <span class="ac-eyebrow">intermission · sniper ban</span>
        <div class="im-spinner"></div>
        <h2 class="im-title">${name} is choosing a banned letter…</h2>
        <span class="im-timer">${this.seconds}s</span>
      </div>
    `;
  }

  override render(): TemplateResult {
    const m = this.controller.match;
    const sub = m.state.intermissionPhase;
    let body: TemplateResult | typeof nothing = nothing;
    if (sub === "optimize" || sub === "tutorial") {
      body = this.renderOptimize();
    } else if (sub === "sniperBan") {
      body =
        m.computeLastPlaceId() === this.controller.humanId
          ? this.renderBan()
          : this.renderBanWait();
    }
    return html`<div class="overlay intermission">${body}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-intermission": AcIntermission;
  }
}
