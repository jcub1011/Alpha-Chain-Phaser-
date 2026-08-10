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
import { availableBanLetters, legalBanLetters } from "../../game/settings";
import { getCard } from "../../game/cards/library";
import { bubblePreferences, isInertPreference } from "../../game/picker/preference";
import { createLogger } from "../../log";
import { AcElement } from "../app/AcElement";
import "../components/ac-card";

const log = createLogger("input");

@customElement("ac-intermission")
export class AcIntermission extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  // The two zone lists hold per-card uids (not card ids), so duplicate cards stay
  // distinct while dragging/reordering. `cardIdByUid` resolves a uid back to its
  // card id for the <ac-card> face.
  @state() private engine: string[] = [];
  @state() private discard: string[] = [];
  @state() private slots = 3;
  private cardIdByUid = new Map<string, string>();

  // Drag is pointer-based (works for mouse + touch alike — HTML5 DnD never fires on
  // touch). `dragId`/`dragFrom` identify the card in flight; the rest track the active
  // pointer, the floating ghost, and the highlighted drop target.
  private dragId: string | null = null;
  private dragFrom: "engine" | "discard" | null = null;
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragGrabX = 0;
  private dragGrabY = 0;
  private dragging = false;
  private dragGhost: HTMLElement | null = null;
  private dropTarget: HTMLElement | null = null;
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.handlePointerUp(e);

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      const me = this.controller.match.state.players.find((p) => p.id === this.controller.humanId);
      // Split the bay into the two zones. Before any edit a card has no explicit
      // flag, so newly-dealt cards (isNew) default into the discard bin; once the
      // player commits, the stored `discarded` flag drives the split.
      const engine: string[] = [];
      const discard: string[] = [];
      const byUid = new Map<string, string>();
      for (const b of me?.bay ?? []) {
        const uid = b.uid ?? b.id;
        byUid.set(uid, b.id);
        ((b.discarded ?? !!b.isNew) ? discard : engine).push(uid);
      }
      this.cardIdByUid = byUid;
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

  /** Whether this player has locked in their engine — frozen until they unlock. */
  private get locked(): boolean {
    return !!this.controller.match.state.players.find((p) => p.id === this.controller.humanId)
      ?.lockedIn;
  }

  // ── Reorder / discard (committed to the host on every change) ────────────────
  private commit(): void {
    /* Mirror the authority's bubbling rule BEFORE sending, and write it back into `this.engine` so
     * the player sees the order that will actually be stored. Every reorder path funnels through
     * here — the ◄ ► nudges, the ✕/＋ buttons and all three drag drops — and several of them would
     * otherwise produce an order the server immediately rewrites (＋ keep appends rightmost, and a
     * nudge can swap a scoring card left past a Preference Card). Normalizing at the one choke
     * point beats patching six call sites. */
    this.engine = bubblePreferences(this.engine, (uid) =>
      isInertPreference(getCard(this.cardIdByUid.get(uid) ?? "")),
    );
    this.controller.match.setPlayerBay(this.controller.humanId, this.engine, this.discard);
  }

  /** Nudge-swap a card with its neighbour, within the engine only. */
  private move(id: string, dir: -1 | 1): void {
    if (this.locked) return;
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
    if (this.locked || !this.engine.includes(id)) return;
    this.engine = this.engine.filter((x) => x !== id);
    this.discard = [...this.discard, id];
    this.commit();
  }

  /** ＋ — pull a card back into the engine when there's a free slot. */
  private restoreCard(id: string): void {
    if (this.locked || this.engine.length >= this.slots || !this.discard.includes(id)) return;
    this.discard = this.discard.filter((x) => x !== id);
    this.engine = [...this.engine, id];
    this.commit();
  }

  // ── Pointer-based drag (mouse + touch) ──────────────────────────────────────
  /** Begin a drag from a slot. Ignored on the action buttons (so ◄ ► ✕ ＋ still
   *  click), for non-primary buttons, and while the engine is locked. */
  private onPointerDown(e: PointerEvent, id: string, from: "engine" | "discard"): void {
    if (this.locked) return;
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.dragId = id;
    this.dragFrom = from;
    this.dragPointerId = e.pointerId;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.dragGrabX = e.clientX - rect.left;
    this.dragGrabY = e.clientY - rect.top;
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId || !this.dragId) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    if (!this.dragging) {
      if (Math.hypot(dx, dy) < 6) return; // a tap/click, not a drag
      this.beginGhost();
    }
    e.preventDefault(); // suppress scroll/selection once dragging
    if (this.dragGhost) {
      this.dragGhost.style.left = `${e.clientX - this.dragGrabX}px`;
      this.dragGhost.style.top = `${e.clientY - this.dragGrabY}px`;
    }
    this.highlightDropTarget(e.clientX, e.clientY);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId) return;
    if (this.dragging && this.dragId && this.dragFrom) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const slot = el?.closest<HTMLElement>(".im-slot");
      const targetUid = slot?.dataset.uid;
      const slotZone = slot?.dataset.zone as "engine" | "discard" | undefined;
      if (targetUid && slotZone && targetUid !== this.dragId) {
        this.applyDropOnCard(targetUid, slotZone);
      } else if (!slot) {
        const zone = el?.closest<HTMLElement>(".im-zone")?.dataset.zone as
          | "engine"
          | "discard"
          | undefined;
        if (zone) this.applyDropOnZone(zone);
      }
    }
    this.endDrag();
  }

  /** Spawn a floating clone of the source slot that trails the pointer. ac-card renders
   *  into light DOM, so a deep clone carries the visible card face. */
  private beginGhost(): void {
    this.dragging = true;
    const src = this.querySelector<HTMLElement>(`.im-slot[data-uid="${this.dragId}"]`);
    if (!src) return;
    src.classList.add("is-dragging");
    const rect = src.getBoundingClientRect();
    const ghost = src.cloneNode(true) as HTMLElement;
    ghost.classList.add("im-drag-ghost");
    ghost.classList.remove("is-dragging");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    // <ac-card> sizes itself off --gc-w/--gc-h, which are set on the .im-zone-cards
    // container. Reparenting the clone to <body> drops them, collapsing the card to a
    // dot — so carry the resolved values onto the ghost.
    const cs = getComputedStyle(src);
    ghost.style.setProperty("--gc-w", cs.getPropertyValue("--gc-w"));
    ghost.style.setProperty("--gc-h", cs.getPropertyValue("--gc-h"));
    document.body.appendChild(ghost);
    this.dragGhost = ghost;
  }

  private highlightDropTarget(x: number, y: number): void {
    const el = document.elementFromPoint(x, y);
    const target =
      el?.closest<HTMLElement>(`.im-slot:not([data-uid="${this.dragId}"])`) ??
      el?.closest<HTMLElement>(".im-zone") ??
      null;
    if (target === this.dropTarget) return;
    this.dropTarget?.classList.remove("is-drop-target");
    target?.classList.add("is-drop-target");
    this.dropTarget = target;
  }

  private endDrag(): void {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.dragGhost?.remove();
    this.dragGhost = null;
    this.dropTarget?.classList.remove("is-drop-target");
    this.dropTarget = null;
    this.querySelector(".im-slot.is-dragging")?.classList.remove("is-dragging");
    this.dragId = null;
    this.dragFrom = null;
    this.dragPointerId = null;
    this.dragging = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.endDrag(); // tear down any in-flight drag listeners/ghost
  }

  /** Drop onto a card: reorder within the same zone, or slide across zones. */
  private applyDropOnCard(targetId: string, targetZone: "engine" | "discard"): void {
    const id = this.dragId;
    const from = this.dragFrom;
    if (!id || !from || id === targetId) return;

    if (from === targetZone) {
      // Same zone: insert the dragged card at the target's position (others shift,
      // but only within this zone — nothing spills across the boundary).
      const list = [...(from === "engine" ? this.engine : this.discard)];
      const fromIdx = list.indexOf(id);
      const toIdx = list.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) return;
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
    this.commit();
  }

  /** Drop onto a zone's empty area: move the card into that zone (no swap). */
  private applyDropOnZone(zone: "engine" | "discard"): void {
    const id = this.dragId;
    const from = this.dragFrom;
    if (!id || !from || from === zone) return;
    if (zone === "engine") {
      if (this.engine.length >= this.slots) return; // no free slot
      this.discard = this.discard.filter((x) => x !== id);
      this.engine = [...this.engine, id];
    } else {
      this.engine = this.engine.filter((x) => x !== id);
      this.discard = [...this.discard, id];
    }
    this.commit();
  }

  /** LOCK IN: commit the order, then fast-forward the optimize dwell. Solo advances
   *  the match directly; networked play routes a lockInOptimize intent to the host. */
  private lockIn(): void {
    log.debug(`locked in engine (${this.engine.length} cards, ${this.discard.length} discarded)`);
    this.commit();
    this.controller.match.skipOptimize();
  }

  /** UNLOCK: re-open the engine for editing while waiting on the other players. */
  private unlock(): void {
    log.debug("unlocked engine");
    this.controller.match.unlockOptimize();
  }

  private pickBan(letter: string): void {
    log.info(`sniper ban: "${letter}"`);
    this.controller.match.applySniperBanAndAdvance(letter);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  private renderEngineSlot(id: string, i: number, locked: boolean): TemplateResult {
    return html`
      <div
        class="im-slot"
        data-uid=${id}
        data-zone="engine"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e, id, "engine")}
      >
        <span class="im-slot-no">${i + 1}</span>
        <ac-card .cardId=${this.cardIdByUid.get(id) ?? id}></ac-card>
        <div class="im-actions">
          <button ?disabled=${locked} @click=${() => this.move(id, -1)} aria-label="move left">
            ◄
          </button>
          <button ?disabled=${locked} @click=${() => this.move(id, 1)} aria-label="move right">
            ►
          </button>
          <button
            class="im-x"
            ?disabled=${locked}
            @click=${() => this.discardCard(id)}
            aria-label="discard"
          >
            ✕
          </button>
        </div>
      </div>
    `;
  }

  private renderDiscardSlot(id: string, locked: boolean): TemplateResult {
    const full = this.engine.length >= this.slots;
    return html`
      <div
        class="im-slot is-discard"
        data-uid=${id}
        data-zone="discard"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e, id, "discard")}
      >
        <ac-card .cardId=${this.cardIdByUid.get(id) ?? id}></ac-card>
        <div class="im-actions">
          <button
            class="im-restore"
            ?disabled=${locked || full}
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
    const locked = this.locked;
    return html`
      <div class="im-card ac-panel ${locked ? "is-locked" : ""}">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · optimize</span>
          <h2 class="im-title">Tune your engine</h2>
          <p class="im-sub">
            Cards score left → right. Drag within the engine to reorder, or use ◄ ►. New cards start
            in the discard bin — drag one into the engine to slot it in (the rest slide over), or
            press ＋. Anything left in the bin is discarded when the timer ends.
          </p>
          <span class="im-timer">${this.seconds}s</span>
        </header>

        ${locked
          ? html`<p class="im-locked-note">🔒 Engine locked — tap UNLOCK to edit.</p>`
          : nothing}

        <div class="im-zone im-engine" data-zone="engine">
          <span class="im-zone-label">Engine · ${this.engine.length}/${this.slots}</span>
          <div class="im-zone-cards">
            ${this.engine.map((id, i) => this.renderEngineSlot(id, i, locked))}
            ${Array.from(
              { length: free },
              () => html`<div class="im-empty-slot" aria-hidden="true">empty</div>`,
            )}
          </div>
        </div>

        <div class="im-zone im-bin" data-zone="discard">
          <span class="im-zone-label">Discard bin · removed when the timer ends</span>
          <div class="im-zone-cards">
            ${this.discard.map((id) => this.renderDiscardSlot(id, locked))}
            ${this.discard.length === 0
              ? html`<p class="im-empty">Empty — drag a card here or press ✕ to discard it.</p>`
              : nothing}
          </div>
        </div>

        ${locked
          ? html`<div class="im-lock-row">
              <button class="ac-btn im-lock is-unlock" @click=${() => this.unlock()}>UNLOCK</button>
              <span class="im-lock-status"
                >Locked in — waiting (${lockedCount}/${humans.length})</span
              >
            </div>`
          : html`<button class="ac-btn im-lock" @click=${() => this.lockIn()}>LOCK IN</button>`}
      </div>
    `;
  }

  private renderBan(): TemplateResult {
    const s = this.controller.match.state;
    const { banMode, banRepeatRule } = s.settings;
    const letters = legalBanLetters(banMode);
    const available = new Set(availableBanLetters(banMode, banRepeatRule, s.bannedLetterHistory));
    const prev = s.bannedLetter;
    // Words played this era (era only advances after the ban) so the picker can ban an
    // informed letter — what's been scoring, and how much.
    const played = s.history.filter((h) => h.era === s.era);
    return html`
      <div class="im-card ac-panel">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · sniper ban</span>
          <h2 class="im-title">You're last — strike back</h2>
          <p class="im-sub">Choose a letter. Words containing it score zero next era.</p>
          <span class="im-timer">${this.seconds}s</span>
        </header>
        <div class="ban-grid">
          ${letters.map((l) => {
            const disabled = !available.has(l);
            const isPrev = l === prev;
            // The previous letter reads amber (selectable) when repeats are allowed,
            // and forbidden-red otherwise (where it's also disabled).
            const isPrevAllowed = isPrev && banRepeatRule === "AllowRepeat";
            return html`<button
              class="ban-key ${isPrev ? "is-prev" : ""} ${isPrevAllowed ? "is-prev-allowed" : ""}"
              ?disabled=${disabled}
              title=${isPrevAllowed
                ? "Banned last era — allowed again"
                : isPrev
                  ? "Banned last era"
                  : disabled
                    ? "Not allowed by the ban-repeat rule"
                    : ""}
              @click=${() => this.pickBan(l)}
            >
              ${l.toUpperCase()}
            </button>`;
          })}
        </div>
        ${played.length
          ? html`<div class="ban-words">
              <span class="ac-eyebrow">words played this era</span>
              <ul class="ban-words-list">
                ${played.map(
                  (h) =>
                    html`<li class="ban-word-row ${h.timedOut ? "is-timeout" : ""}">
                      <span class="ban-word">${h.timedOut ? "⏱ timed out" : h.word}</span>
                      <span class="ban-word-score">${h.score}</span>
                    </li>`,
                )}
              </ul>
            </div>`
          : nothing}
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
