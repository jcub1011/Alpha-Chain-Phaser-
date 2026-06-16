/*
 * <ac-word-entry> — the prefix badge + text input + GO button. Owns submission
 * and rejection feedback for the human. The input is plain (read at submit time),
 * never value-bound, so fast typing never triggers re-renders. Enabled only on
 * the human's turn; auto-focuses when their turn arms.
 */

import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { SubmitResult } from "../../game/types";
import { AcElement } from "../app/AcElement";

const REASON: Record<NonNullable<SubmitResult["reason"]>, string> = {
  "not-a-word": "Not a word",
  "already-used": "Already played",
  "wrong-start-letter": "Wrong start letter",
  "too-short": "Too short",
};

@customElement("ac-word-entry")
export class AcWordEntry extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private live = false;
  /** The turn is one seat away — the player before us (in shuffled order) is up. */
  @state() private onDeck = false;
  @state() private requiredLetter = "";
  @state() private feedback = "";
  /** Blindfold: mask the player's own glyphs as they type. */
  @state() private hideInput = false;
  @query(".we-input") private input?: HTMLInputElement;

  private wantFocus = false;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const human = this.controller.humanId;
      this.listen(e, "turnArmed", ({ requiredLetter }) => {
        this.requiredLetter = requiredLetter;
        this.live = this.controller.match.current?.id === human;
        this.onDeck = !this.live && this.isOnDeck(human);
        this.feedback = "";
        this.hideInput = this.controller.match.hidesInput(human);
        if (this.live) this.wantFocus = true;
      });
      this.listen(e, "submission", ({ submission }) => {
        if (submission.playerId === human && this.input) this.input.value = "";
        this.live = false;
      });
      // When the shot clock hits zero on our live turn, auto-submit whatever is
      // in the box. This fires synchronously inside the engine's clockTick emit,
      // BEFORE its own timeout check (match.tick): a successful submit re-arms the
      // clock so the engine never skips, while an empty/invalid box falls through
      // to the normal timeout below.
      this.listen(e, "clockTick", (remaining) => {
        if (this.live && remaining <= 0) this.submit();
      });
      this.listen(e, "timeout", ({ playerId }) => {
        this.live = false;
        // Clear the box even when the auto-submit was rejected (garbage) or empty,
        // so no stale text survives into our next turn.
        if (playerId === human && this.input) this.input.value = "";
      });
      this.listen(e, "rejected", ({ playerId, reason }) => {
        if (playerId !== human) return;
        this.feedback = REASON[reason];
        this.shake();
      });
      // Seed initial turn state.
      const s = this.controller.match.state;
      this.requiredLetter = s.requiredLetter;
      this.live = s.phase === "Round" && this.controller.match.current?.id === human;
      this.onDeck = !this.live && this.isOnDeck(human);
      this.hideInput = this.controller.match.hidesInput(human);
      if (this.live) this.wantFocus = true;
    }
  }

  /** Whether the human is up immediately after the current player. Mirrors
   *  MatchController.advanceIndex by skipping eliminated seats. */
  private isOnDeck(human: string): boolean {
    const s = this.controller.match.state;
    if (s.phase !== "Round") return false;
    const players = s.players;
    const n = players.length;
    for (let i = 1; i <= n; i++) {
      const p = players[(s.currentPlayerIndex + i) % n];
      if (!p.eliminated) return p.id === human;
    }
    return false;
  }

  override updated(): void {
    if (this.wantFocus && this.input) {
      this.wantFocus = false;
      this.input.focus();
    }
  }

  private shake(): void {
    const el = this.querySelector(".we");
    if (!el) return;
    el.classList.remove("is-reject");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("is-reject");
  }

  private submit(): void {
    if (!this.live || !this.input) return;
    const value = this.input.value.trim();
    if (!value) return;
    this.controller.submitWord(value);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.submit();
    }
  }

  override render(): TemplateResult {
    const free = !this.requiredLetter;
    return html`
      <div class="we ${this.live ? "is-live" : ""} ${this.onDeck ? "is-ondeck" : ""}">
        <span class="we-prefix ${free ? "is-free" : ""}">
          ${free ? "∗" : this.requiredLetter.toUpperCase()}
        </span>
        <input
          class="we-input ${this.hideInput ? "is-masked" : ""}"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder=${this.live ? "type a word…" : this.onDeck ? "get ready — you're up next…" : "waiting…"}
          ?disabled=${!this.live}
          @keydown=${this.onKey}
        />
        <button class="we-go ac-btn" ?disabled=${!this.live} @click=${this.submit}>GO</button>
      </div>
      <div class="we-feedback ${this.feedback ? "is-shown" : ""}">${this.feedback || " "}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-word-entry": AcWordEntry;
  }
}
