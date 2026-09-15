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
 * A spectating host (hostPlays=false, no player entry) sees a ready-list
 * (X/Y active humans + per-player lock-in) instead of the configurator.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import { activeBannedLetters, availableBanLetters, legalBanLetters } from "../../game/settings";
import { cardIdentity } from "../../game/cards/library";
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
  //
  // Mobile uses long-press-to-arm: a touch/pen press only becomes a drag after
  // LONG_PRESS_MS with the finger held inside TOUCH_SLOP (otherwise the gesture is
  // a scroll/tap and the browser keeps it). Mouse arms immediately with a 6px slop.
  // pointercancel always aborts without committing; only pointerup commits.
  private dragId: string | null = null;
  private dragFrom: "engine" | "discard" | null = null;
  private dragPointerId: number | null = null;
  private dragPointerType: string | null = null;
  private pressArmed = false;
  private pressTimer: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragGrabX = 0;
  private dragGrabY = 0;
  private dragging = false;
  private dragGhost: HTMLElement | null = null;
  private dropTarget: HTMLElement | null = null;
  // Live insertion point computed during the drag (post-removal coordinates).
  private insertRef: { zone: "engine" | "discard"; index: number } | null = null;
  private insertLine: HTMLElement | null = null;
  private lastAnchorX = 0;
  private lastAnchorY = 0;
  private autoScrollRaf: number | null = null;
  private autoScrollSpeed = 0;
  private suppressClickUntil = 0;
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.handlePointerUp(e);
  private readonly onPointerCancel = (e: PointerEvent): void => this.handlePointerCancel(e);
  private readonly onClickCapture = (e: Event): void => {
    if (performance.now() < this.suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    } else {
      window.removeEventListener("click", this.onClickCapture, true);
    }
  };
  private readonly onContextMenu = (e: Event): void => {
    if (this.dragging) e.preventDefault();
  };
  /**
   * Cancelling `pointermove` does NOT stop scrolling (per spec) and flipping
   * `touch-action` mid-gesture has no effect on the in-flight touch — the browser
   * locks that in at touch-start. So while a drag is armed, a non-passive
   * `touchmove` preventDefault is what actually keeps the page from scrolling
   * away (and keeps the browser from firing `pointercancel` and killing the ghost).
   * Before arming, touches fall through untouched so taps and scrolls work.
   */
  private readonly onTouchMove = (e: TouchEvent): void => {
    if (this.dragging) e.preventDefault();
  };

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      // Re-render the countdown whenever the synced sub-timer ticks; the FSM owns
      // the authoritative dwell (per-frame event, never broadcast over the network).
      // Spectators have no bay to split — subscribe and return early.
      this.clearSubs();
      this.listen(this.controller.match.events, "subTimerTick", () => this.requestUpdate());
      const me = this.controller.match.state.players.find((p) => p.id === this.controller.humanId);
      if (!me) {
        this.cardIdByUid = new Map();
        this.engine = [];
        this.discard = [];
        this.slots = 3;
        return;
      }
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

  /** Whether the local client is spectating (e.g. a host with hostPlays=false):
   *  their id has no entry in `match.state.players`, so there is no engine to
   *  configure. Spectators get a ready-list instead of the configurator. */
  private get isSpectator(): boolean {
    return !this.controller.match.state.players.some((p) => p.id === this.controller.humanId);
  }

  /** Active humans only: bots never optimize and eliminated players can't lock in. */
  private get activeHumans(): { id: string; name: string; lockedIn?: boolean }[] {
    return this.controller.match.state.players.filter((p) => !p.isBot && !p.eliminated);
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
      isInertPreference(cardIdentity(this.cardIdByUid.get(uid) ?? "")),
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
   *  click), for non-primary buttons, while the engine is locked, and while another
   *  press is already tracked (second finger never hijacks the in-flight drag). */
  private onPointerDown(e: PointerEvent, id: string, from: "engine" | "discard"): void {
    if (this.locked) return;
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.dragPointerId !== null) return;
    this.dragId = id;
    this.dragFrom = from;
    this.dragPointerId = e.pointerId;
    this.dragPointerType = e.pointerType;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.dragGrabX = e.clientX - rect.left;
    this.dragGrabY = e.clientY - rect.top;
    if (e.pointerType === "mouse") {
      this.pressArmed = true;
    } else {
      // Touch/pen: wait for a long-press so scrolling and taps keep working.
      // Moving past TOUCH_SLOP first means "scroll" — abort before any ghost.
      this.pressArmed = false;
      this.clearPressTimer();
      this.pressTimer = window.setTimeout(() => {
        this.pressTimer = null;
        if (this.dragId === null || this.dragPointerId === null) return;
        this.pressArmed = true;
        this.beginGhost();
        // Show the insertion line immediately so the lift point reads even before
        // the finger moves (anchor sits above the fingertip — see anchorFor).
        const ax = this.dragStartX;
        const ay = this.dragStartY - 28;
        this.lastAnchorX = ax;
        this.lastAnchorY = ay;
        this.updateInsertionIndicator(ax, ay);
        try {
          navigator.vibrate?.(10);
        } catch {
          /* haptics are best-effort */
        }
      }, 350);
    }
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("touchmove", this.onTouchMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("contextmenu", this.onContextMenu);
  }

  private clearPressTimer(): void {
    if (this.pressTimer !== null) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  /** Anchor the hit test above the fingertip for touch/pen — the finger itself
   *  occludes the card it covers, so testing the raw touch point always reports
   *  the card *behind* the finger instead of the intended gap. */
  private anchorFor(e: PointerEvent): { x: number; y: number } {
    if (e.pointerType === "mouse") return { x: e.clientX, y: e.clientY };
    return { x: e.clientX, y: e.clientY - 28 };
  }

  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId || !this.dragId) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    if (!this.dragging) {
      if (!this.pressArmed) {
        // Touch/pen still in the long-press window: any real travel is a scroll.
        if (Math.hypot(dx, dy) > 12) {
          this.clearPressTimer();
          this.endDrag();
        }
        return;
      }
      if (Math.hypot(dx, dy) < 6) return; // a tap/click, not a drag
      this.beginGhost();
    }
    e.preventDefault(); // suppress selection once dragging (scroll is held off by onTouchMove)
    if (this.dragGhost) {
      this.dragGhost.style.left = `${e.clientX - this.dragGrabX}px`;
      this.dragGhost.style.top = `${e.clientY - this.dragGrabY}px`;
    }
    const anchor = this.anchorFor(e);
    this.lastAnchorX = anchor.x;
    this.lastAnchorY = anchor.y;
    this.updateInsertionIndicator(anchor.x, anchor.y);
    this.maybeAutoScroll(anchor.y);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId) return;
    const wasDrag = this.dragging;
    if (wasDrag && this.dragId && this.dragFrom) {
      const anchor = this.anchorFor(e);
      this.updateInsertionIndicator(anchor.x, anchor.y);
      this.commitInsertRef();
    }
    this.endDrag();
    // Swallow the click that follows a real drag so the card doesn't flip
    // (ac-card toggles on click); plain taps never set this.
    if (wasDrag) {
      this.suppressClickUntil = performance.now() + 400;
      window.addEventListener("click", this.onClickCapture, true);
      window.setTimeout(() => {
        if (performance.now() >= this.suppressClickUntil) {
          window.removeEventListener("click", this.onClickCapture, true);
        }
      }, 450);
    }
  }

  /** A cancelled gesture (browser scroll takeover, iOS interruption, alert, …)
   *  must never commit a drop — just drop the ghost and keep the order. */
  private handlePointerCancel(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId) return;
    this.endDrag();
  }

  /** Spawn a floating clone of the source slot that trails the pointer. ac-card renders
   *  into light DOM, so a deep clone carries the visible card face. */
  private beginGhost(): void {
    this.dragging = true;
    const src = this.querySelector<HTMLElement>(`.im-slot[data-uid="${this.dragId}"]`);
    if (!src) return;
    src.classList.add("is-dragging");
    this.querySelector(".im-card")?.classList.add("is-touch-dragging");
    const rect = src.getBoundingClientRect();
    const ghost = src.cloneNode(true) as HTMLElement;
    ghost.classList.add("im-drag-ghost");
    ghost.classList.remove("is-dragging");
    if (this.dragPointerType !== "mouse") ghost.classList.add("is-touch");
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
    // The ghost hides .im-slot-no/.im-actions (see CSS), which shifts the card face
    // up inside the clone. Re-anchor the grab offset onto the card face so the card
    // stays glued under the pointer, and park the ghost so its card face already
    // coincides with the source card — otherwise it renders high until the first
    // move snaps it down.
    const srcCard = src.querySelector("ac-card")?.getBoundingClientRect();
    const ghostCard = ghost.querySelector("ac-card")?.getBoundingClientRect();
    if (srcCard) {
      const srcDelta = srcCard.top - rect.top;
      const ghostDelta = ghostCard ? ghostCard.top - ghost.getBoundingClientRect().top : 0;
      this.dragGrabY += ghostDelta - srcDelta;
      ghost.style.top = `${rect.top + srcDelta - ghostDelta}px`;
    }
  }

  /**
   * Live insertion indicator: pick the target zone (element at the anchor, else
   * nearest zone), then the gap within that zone nearest the anchor in the row's
   * dominant axis. `insertRef` is stored in post-removal coordinates (dragged card
   * excluded) so commit needs no index fixups. A fixed-position line marks the gap
   * and the zone gets the familiar highlight; empty zones highlight with append.
   */
  private updateInsertionIndicator(x: number, y: number): void {
    if (!this.dragId || !this.dragFrom) return;
    const zones = [...this.querySelectorAll<HTMLElement>(".im-zone")];
    if (zones.length === 0) return;
    const atPoint = document.elementFromPoint(x, y);
    let zoneEl = atPoint?.closest<HTMLElement>(".im-zone") ?? null;
    let zoneName = zoneEl?.dataset.zone as "engine" | "discard" | undefined;
    if (!zoneEl || !zoneName) {
      // Finger is between zones / over the ghost gap: fall back to nearest zone.
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const z of zones) {
        const r = z.getBoundingClientRect();
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = z;
        }
      }
      zoneEl = best;
      zoneName = zoneEl?.dataset.zone as "engine" | "discard" | undefined;
    }
    if (!zoneEl || !zoneName) return;

    // Zone highlight (swap if changed).
    if (this.dropTarget !== zoneEl) {
      this.dropTarget?.classList.remove("is-drop-target");
      zoneEl.classList.add("is-drop-target");
      this.dropTarget = zoneEl;
    }

    const cardsEl = zoneEl.querySelector(".im-zone-cards");
    const slots = [...(cardsEl ?? zoneEl).querySelectorAll<HTMLElement>(".im-slot")].filter(
      (s) => s.dataset.uid !== this.dragId,
    );
    // Find the first slot the anchor sits "before": earlier row, or same row and
    // left of center. Everything else is "after" → append.
    let index = slots.length;
    let lineX: number | null = null;
    let lineY: number | null = null;
    let lineH = 0;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      const beforeRow = y < r.top - 4;
      const inRow = y <= r.bottom + 4;
      const beforeInRow = inRow && x < r.left + r.width / 2;
      if (beforeRow || beforeInRow) {
        index = i;
        lineX = r.left - 5;
        const sized = this.dropLineForSlot(slots[i]);
        lineY = sized.top;
        lineH = sized.height;
        break;
      }
    }
    if (lineX === null) {
      const lastSlot = slots[slots.length - 1];
      if (lastSlot) {
        const last = lastSlot.getBoundingClientRect();
        lineX = last.right + 1;
        const sized = this.dropLineForSlot(lastSlot);
        lineY = sized.top;
        lineH = sized.height;
      } else {
        // Empty zone: match the card size so the marker reads at a glance.
        const cr = (cardsEl ?? zoneEl).getBoundingClientRect();
        const gcH =
          parseFloat(getComputedStyle(cardsEl ?? zoneEl).getPropertyValue("--gc-h")) || 150;
        lineX = cr.left + 8;
        lineY = cr.top + 8;
        lineH = gcH + 12;
      }
    }
    this.insertRef = { zone: zoneName, index };
    let line = this.insertLine;
    if (!line) {
      line = document.createElement("div");
      line.className = "im-drop-line";
      document.body.appendChild(line);
      this.insertLine = line;
    }
    line.style.left = `${lineX}px`;
    line.style.top = `${lineY ?? 0}px`;
    line.style.height = `${lineH}px`;
  }

  /**
   * Size the insertion line to the card face (plus a little breathing room) rather
   * than the whole slot — the slot-number label and action buttons would otherwise
   * stretch it well past the cards it sits between.
   */
  private dropLineForSlot(slot: HTMLElement): { top: number; height: number } {
    const card = slot.querySelector("ac-card")?.getBoundingClientRect();
    if (!card || card.height === 0) {
      const r = slot.getBoundingClientRect();
      return { top: r.top, height: r.height };
    }
    const pad = 6;
    return { top: card.top - pad, height: card.height + pad * 2 };
  }
  /** Commit the tracked insertion point. Same-zone drops splice in post-removal
   *  coordinates; cross-zone drops reuse the existing slide/overflow rules. */
  private commitInsertRef(): void {
    const id = this.dragId;
    const from = this.dragFrom;
    const ref = this.insertRef;
    if (!id || !from || !ref) return;
    if (from === ref.zone) {
      const source = from === "engine" ? this.engine : this.discard;
      const without = source.filter((x) => x !== id);
      const idx = Math.max(0, Math.min(ref.index, without.length));
      without.splice(idx, 0, id);
      if (without.every((v, i) => v === source[i]) && without.length === source.length) return;
      if (from === "engine") this.engine = without;
      else this.discard = without;
      this.commit();
      return;
    }
    if (ref.zone === "engine") {
      // Discard → engine at the indicated gap; overflow slides out to the bin.
      const engine = this.engine.filter((x) => x !== id);
      const idx = Math.max(0, Math.min(ref.index, engine.length));
      engine.splice(idx, 0, id);
      let discard = this.discard.filter((x) => x !== id);
      while (engine.length > this.slots) discard = [engine.pop()!, ...discard];
      this.engine = engine;
      this.discard = discard;
      this.commit();
      return;
    }
    // Engine → discard at the indicated gap; the engine just shrinks.
    const discard = this.discard.filter((x) => x !== id);
    const idx = Math.max(0, Math.min(ref.index, discard.length));
    discard.splice(idx, 0, id);
    this.discard = discard;
    this.engine = this.engine.filter((x) => x !== id);
    this.commit();
  }

  /** Edge auto-scroll while dragging near the top/bottom of the panel. */
  private maybeAutoScroll(y: number): void {
    const panel = this.querySelector(".im-card");
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const edge = 56;
    let speed = 0;
    if (y < r.top + edge) speed = -Math.ceil((r.top + edge - y) / 8) - 2;
    else if (y > r.bottom - edge) speed = Math.ceil((y - (r.bottom - edge)) / 8) + 2;
    this.autoScrollSpeed = speed;
    if (speed !== 0 && this.autoScrollRaf === null) {
      const step = (): void => {
        if (this.autoScrollSpeed === 0 || !this.dragging) {
          this.autoScrollRaf = null;
          return;
        }
        panel.scrollTop += this.autoScrollSpeed;
        this.updateInsertionIndicator(this.lastAnchorX, this.lastAnchorY);
        this.autoScrollRaf = requestAnimationFrame(step);
      };
      this.autoScrollRaf = requestAnimationFrame(step);
    }
  }

  private stopAutoScroll(): void {
    this.autoScrollSpeed = 0;
    if (this.autoScrollRaf !== null) {
      cancelAnimationFrame(this.autoScrollRaf);
      this.autoScrollRaf = null;
    }
  }

  private endDrag(): void {
    this.clearPressTimer();
    this.stopAutoScroll();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("touchmove", this.onTouchMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("contextmenu", this.onContextMenu);
    this.dragGhost?.remove();
    this.dragGhost = null;
    this.insertLine?.remove();
    this.insertLine = null;
    this.insertRef = null;
    this.dropTarget?.classList.remove("is-drop-target");
    this.dropTarget = null;
    this.querySelector(".im-slot.is-dragging")?.classList.remove("is-dragging");
    this.querySelector(".im-card.is-touch-dragging")?.classList.remove("is-touch-dragging");
    this.dragId = null;
    this.dragFrom = null;
    this.dragPointerId = null;
    this.dragPointerType = null;
    this.pressArmed = false;
    this.dragging = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.endDrag(); // tear down any in-flight drag listeners/ghost
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
  /** Padlock glyph for lock-in states (inline SVG, currentColor). */
  private renderLockIcon(): TemplateResult {
    return html`<svg
      class="im-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>`;
  }

  /** Hourglass glyph for players still tuning (inline SVG, currentColor). */
  private renderTuningIcon(): TemplateResult {
    return html`<svg
      class="im-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12 7.586 16.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>`;
  }
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
    const humans = this.activeHumans;
    const lockedCount = humans.filter((p) => p.lockedIn).length;
    const locked = this.locked;
    return html`
      <div class="im-card ac-panel ${locked ? "is-locked" : ""}">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · optimize</span>
          <h2 class="im-title">Tune Your Engine</h2>
          <p class="im-sub">
            Cards score left → right. Drag within the engine to reorder (long-press first on touch),
            or use ◄ ►. Anything left in the bin is discarded when the timer ends.
          </p>
          <span class="im-timer">${this.seconds}s</span>
        </header>

        ${locked
          ? html`<p class="im-locked-note">${this.renderLockIcon()}<span>Engine locked. Press UNLOCK to edit.</span></p>`
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
          <span class="im-zone-label">Discard Bin</span>
          <div class="im-zone-cards">
            ${this.discard.map((id) => this.renderDiscardSlot(id, locked))}
            ${this.discard.length === 0
              ? html`<p class="im-empty">Drag a card here or press X to discard it.</p>`
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

  /** Spectating host (hostPlays=false): no engine of their own, so show the
   *  active humans' lock-in progress instead of the configurator. */
  private renderSpectatorOptimize(): TemplateResult {
    const humans = this.activeHumans;
    const lockedCount = humans.filter((p) => p.lockedIn).length;
    return html`
      <div class="im-card ac-panel im-spectate">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · optimize</span>
          <h2 class="im-title">Players Are Tuning Their Engines</h2>
          <p class="im-ready-count" aria-live="polite">${lockedCount}/${humans.length} players ready</p>
          <span class="im-timer">${this.seconds}s</span>
        </header>
        <ul class="im-ready-list">
          ${humans.map(
            (p) => html`<li class="im-ready-row ${p.lockedIn ? "is-locked" : ""}">
              <span class="im-ready-name">${p.name}</span>
              <span class="im-ready-status"
                >${p.lockedIn ? this.renderLockIcon() : this.renderTuningIcon()}<span
                  >${p.lockedIn ? "Locked in" : "Tuning…"}</span
                ></span
              >
            </li>`,
          )}
        </ul>
      </div>
    `;
  }

  private renderBan(): TemplateResult {
    const s = this.controller.match.state;
    const { banMode, banRepeatRule } = s.settings;
    const letters = legalBanLetters(banMode);
    const available = new Set(availableBanLetters(banMode, banRepeatRule, s.bannedLetterHistory));
    const prev = s.bannedLetter;
    // Accumulate: every past ban stays in force — surface them so the picker sees
    // the full set their pick joins (already-banned keys are disabled below).
    const accumulating = banRepeatRule === "Accumulate";
    const bannedSoFar = accumulating
      ? activeBannedLetters(banRepeatRule, s.bannedLetter, s.bannedLetterHistory)
      : [];
    // Words played this era (era only advances after the ban) so the picker can ban an
    // informed letter — what's been scoring, and how much.
    const played = s.history.filter((h) => h.era === s.era);
    return html`
      <div class="im-card ac-panel">
        <header class="im-head">
          <span class="ac-eyebrow">intermission · sniper ban</span>
          <h2 class="im-title">Select A Letter To Ban</h2>
          <p class="im-sub">
            ${accumulating
              ? "Choose a letter. Stacks with previous letter bans. Words containing any of the banned letters score zero next era."
              : "Choose a letter. Words containing it score zero next era."}
          </p>
          ${bannedSoFar.length
            ? html`<p class="im-sub">
                Banned so far: ${bannedSoFar.map((l) => l.toUpperCase()).join(" · ")}
              </p>`
            : nothing}
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
                ? "Banned last era, allowed again"
                : isPrev
                  ? "Banned last era"
                  : disabled
                    ? accumulating
                      ? "Already banned, still in force"
                      : "Not allowed by the ban-repeat rule"
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
      body = this.isSpectator ? this.renderSpectatorOptimize() : this.renderOptimize();
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
