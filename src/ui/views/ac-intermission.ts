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
import { legalBanLetters } from "../../game/settings";
import { createLogger } from "../../log";
import { AcElement } from "../app/AcElement";
import "../components/ac-card";

const log = createLogger("input");

@customElement("ac-intermission")
export class AcIntermission extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private engine: string[] = [];
  @state() private discard: string[] = [];
  @state() private slots = 3;

  private dragId: string | null = null;
  private dragFrom: "engine" | "discard" | null = null;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const me = this.controller.match.state.players.find((p) => p.id === this.controller.humanId);
      // Split the bay into the two zones. Before any edit a card has no explicit
      // flag, so newly-dealt cards (isNew) default into the discard bin; once the
      // player commits, the stored `discarded` flag drives the split.
      const engine: string[] = [];
      const discard: string[] = [];
      for (const b of me?.bay ?? []) ((b.discarded ?? !!b.isNew) ? discard : engine).push(b.id);
      this.engine = engine;
      this.discard = discard;
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

  // ── Reorder / discard (committed to the host on every change) ────────────────
  private commit(): void {
    this.controller.match.setPlayerBay(this.controller.humanId, this.engine, this.discard);
  }

  /** Nudge-swap a card with its neighbour, within the engine only. */
  private move(id: string, dir: -1 | 1): void {
    const next = [...this.engine];
    const i = next.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    this.engine = next;
    this.commit();
  }

  /** ✕ — send an engine card to the discard bin. */
  private discardCard(id: string): void {
    if (!this.engine.includes(id)) return;
    this.engine = this.engine.filter((x) => x !== id);
    this.discard = [...this.discard, id];
    this.commit();
  }

  /** ＋ — pull a card back into the engine when there's a free slot. */
  private restoreCard(id: string): void {
    if (this.engine.length >= this.slots || !this.discard.includes(id)) return;
    this.discard = this.discard.filter((x) => x !== id);
    this.engine = [...this.engine, id];
    this.commit();
  }

  private onDragStart(id: string, from: "engine" | "discard"): void {
    this.dragId = id;
    this.dragFrom = from;
  }

  private endDrag(): void {
    this.dragId = null;
    this.dragFrom = null;
  }

  /** Drop onto a card: reorder within the same zone, or slide across zones. */
  private onDropCard(e: DragEvent, targetId: string, targetZone: "engine" | "discard"): void {
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the zone's empty-area drop
    const id = this.dragId;
    const from = this.dragFrom;
    if (!id || !from || id === targetId) return this.endDrag();

    if (from === targetZone) {
      // Same zone: insert the dragged card at the target's position (others shift,
      // but only within this zone — nothing spills across the boundary).
      const list = [...(from === "engine" ? this.engine : this.discard)];
      const fromIdx = list.indexOf(id);
      const toIdx = list.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) return this.endDrag();
      list.splice(fromIdx, 1);
      list.splice(list.indexOf(targetId) + (fromIdx < toIdx ? 1 : 0), 0, id);
      if (from === "engine") this.engine = list;
      else this.discard = list;
    } else if (targetZone === "engine") {
      // Discard → engine: insert before the target; the rest slide right. If that
      // overflows the engine, the last card slides out into the discard bin.
      const engine = [...this.engine];
      engine.splice(engine.indexOf(targetId), 0, id);
      let discard = this.discard.filter((x) => x !== id);
      while (engine.length > this.slots) discard = [engine.pop()!, ...discard];
      this.engine = engine;
      this.discard = discard;
    } else {
      // Engine → discard: insert before the target; the engine just shrinks.
      const discard = [...this.discard];
      discard.splice(discard.indexOf(targetId), 0, id);
      this.discard = discard;
      this.engine = this.engine.filter((x) => x !== id);
    }
    this.endDrag();
    this.commit();
  }

  /** Drop onto a zone's empty area: move the card into that zone (no swap). */
  private onDropZone(zone: "engine" | "discard"): void {
    const id = this.dragId;
    const from = this.dragFrom;
    if (!id || !from || from === zone) return this.endDrag();
    if (zone === "engine") {
      if (this.engine.length >= this.slots) return this.endDrag(); // no free slot
      this.discard = this.discard.filter((x) => x !== id);
      this.engine = [...this.engine, id];
    } else {
      this.engine = this.engine.filter((x) => x !== id);
      this.discard = [...this.discard, id];
    }
    this.endDrag();
    this.commit();
  }

  /** LOCK IN: commit the order, then fast-forward the optimize dwell. Solo advances
   *  the match directly; networked play routes a lockInOptimize intent to the host. */
  private lockIn(): void {
    log.debug(`locked in engine (${this.engine.length} cards, ${this.discard.length} discarded)`);
    this.commit();
    this.controller.match.skipOptimize();
  }

  private pickBan(letter: string): void {
    log.info(`sniper ban: "${letter}"`);
    this.controller.match.applySniperBanAndAdvance(letter);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  private renderEngineSlot(id: string, i: number): TemplateResult {
    return html`
      <div
        class="im-slot"
        draggable="true"
        @dragstart=${() => this.onDragStart(id, "engine")}
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => this.onDropCard(e, id, "engine")}
      >
        <span class="im-slot-no">${i + 1}</span>
        <ac-card .cardId=${id}></ac-card>
        <div class="im-actions">
          <button @click=${() => this.move(id, -1)} aria-label="move left">◄</button>
          <button @click=${() => this.move(id, 1)} aria-label="move right">►</button>
          <button class="im-x" @click=${() => this.discardCard(id)} aria-label="discard">✕</button>
        </div>
      </div>
    `;
  }

  private renderDiscardSlot(id: string): TemplateResult {
    const full = this.engine.length >= this.slots;
    return html`
      <div
        class="im-slot is-discard"
        draggable="true"
        @dragstart=${() => this.onDragStart(id, "discard")}
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => this.onDropCard(e, id, "discard")}
      >
        <ac-card .cardId=${id}></ac-card>
        <div class="im-actions">
          <button
            class="im-restore"
            ?disabled=${full}
            title=${full ? "Engine is full — swap a card out first" : "Keep in engine"}
            @click=${() => this.restoreCard(id)}
            aria-label="keep in engine"
          >
            ＋ keep
          </button>
        </div>
      </div>
    `;
  }

  private renderOptimize(): TemplateResult {
    const free = Math.max(0, this.slots - this.engine.length);
    // Lock-in is per-player: optimize ends once every active human locks in (or the
    // timer elapses). Once you've locked in, wait on the rest rather than ending it
    // for everyone. (Solo never sets these, so it always shows a live LOCK IN button.)
    const players = this.controller.match.state.players;
    const humans = players.filter((p) => !p.isBot && !p.eliminated);
    const lockedCount = humans.filter((p) => p.lockedIn).length;
    const locked = !!players.find((p) => p.id === this.controller.humanId)?.lockedIn;
    return html`
      <div class="im-card ac-panel">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · optimize</span>
          <h2 class="im-title">Tune your engine</h2>
          <p class="im-sub">
            Cards score left → right. Drag within the engine to reorder, or use ◄ ►. New cards
            start in the discard bin — drag one into the engine to slot it in (the rest slide
            over), or press ＋. Anything left in the bin is discarded when the timer ends.
          </p>
          <span class="im-timer">${this.seconds}s</span>
        </header>

        <div
          class="im-zone im-engine"
          @dragover=${(e: DragEvent) => e.preventDefault()}
          @drop=${() => this.onDropZone("engine")}
        >
          <span class="im-zone-label">Engine · ${this.engine.length}/${this.slots}</span>
          <div class="im-zone-cards">
            ${this.engine.map((id, i) => this.renderEngineSlot(id, i))}
            ${Array.from(
              { length: free },
              () => html`<div class="im-empty-slot" aria-hidden="true">empty</div>`,
            )}
          </div>
        </div>

        <div
          class="im-zone im-bin"
          @dragover=${(e: DragEvent) => e.preventDefault()}
          @drop=${() => this.onDropZone("discard")}
        >
          <span class="im-zone-label">Discard bin · removed when the timer ends</span>
          <div class="im-zone-cards">
            ${this.discard.map((id) => this.renderDiscardSlot(id))}
            ${this.discard.length === 0
              ? html`<p class="im-empty">Empty — drag a card here or press ✕ to discard it.</p>`
              : nothing}
          </div>
        </div>

        ${locked
          ? html`<button class="ac-btn im-lock" disabled>
              LOCKED IN — waiting (${lockedCount}/${humans.length})
            </button>`
          : html`<button class="ac-btn im-lock" @click=${() => this.lockIn()}>LOCK IN</button>`}
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
