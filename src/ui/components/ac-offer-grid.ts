/*
 * <ac-offer-grid> — Picker's input surface, replacing <ac-word-entry> when the mode is Picker.
 *
 * THREE RULES DRIVE THIS COMPONENT, and each is a requirement rather than a preference:
 *
 * 1. Everything visible at once. The grid wraps and its cells shrink with the count; Offer Cards
 *    are never scrolled off-screen. An option you have to go looking for is hidden information
 *    under a shot clock, which is exactly the friction Picker exists to remove.
 *
 * 2. Selection is a distinct state from submission. First tap selects, second tap (or GO) commits.
 *    Touch devices have no hover, so selection has to be explicit — and selection is where the
 *    reading aids live.
 *
 * 3. The projected score is NEVER shown. Selecting highlights the bay cards that would fire, which
 *    teaches the machine without solving it; a displayed number would turn the decision into a
 *    lookup and the player would stop evaluating and click the biggest figure. The uncertainty is
 *    the game.
 *
 * There is deliberately NO clockTick auto-commit here, unlike <ac-word-entry>. That seam exists in
 * Classic only because LocalController.reportDraft is a solo no-op; selections are discrete and
 * rare, so they are streamed to the engine in both solo and networked play and the ENGINE owns the
 * expiry commit. One code path, one definition of a no-show.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { RARE_START } from "../../game/cards/card";
import { analyzeWord } from "../../game/scoring";
import type { GameController } from "../../net/controller";
import { AcElement } from "../app/AcElement";
import { REJECT_REASON } from "./reject-reasons";

/** Beyond this many cards the grid may scroll horizontally as a last resort; at or below it,
 *  everything fits. Matches the Offer-count ceiling the lobby allows. */
const NO_SCROLL_LIMIT = 8;

/** Whether a word CONTAINS a rare letter. `RARE_START` itself is about a word's STARTING letter
 *  (The Numismatist and friends), so the set is reused but the question is different — a Q buried
 *  mid-word is exactly the kind of thing a reader wants flagged without decoding. */
function rareLetters(word: string): string[] {
  const found: string[] = [];
  for (const ch of word) if (RARE_START.has(ch) && !found.includes(ch)) found.push(ch);
  return found;
}

@customElement("ac-offer-grid")
export class AcOfferGrid extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private offer: string[] = [];
  @state() private live = false;
  /** The turn is one seat away — used for the same "get ready" affordance Classic shows. */
  @state() private onDeck = false;
  @state() private selected: string | null = null;
  @state() private requiredLetter = "";
  @state() private bannedLetter = "";
  @state() private feedback = "";
  @state() private highlightBans = false;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const human = this.controller.humanId;

      this.listen(e, "turnArmed", ({ requiredLetter }) => {
        this.requiredLetter = requiredLetter;
        this.syncFromState();
        this.feedback = "";
        // A fresh Offer invalidates any previous pick, and the projection with it.
        this.select(null);
      });
      this.listen(e, "submission", ({ submission }) => {
        if (submission.playerId === human) this.select(null);
        this.live = false;
        this.syncFromState();
      });
      this.listen(e, "timeout", () => {
        this.live = false;
        this.select(null);
        this.syncFromState();
      });
      this.listen(e, "rejected", ({ playerId, reason }) => {
        if (playerId !== human) return;
        this.feedback = REJECT_REASON[reason];
        this.shake();
      });
      this.syncFromState();
    }
  }

  /** Pull the Offer and turn ownership off the authoritative state. The Offer is state, not an
   *  event payload, so there is exactly one copy and the mirror cannot drift from it. */
  private syncFromState(): void {
    const s = this.controller.match.state;
    const human = this.controller.humanId;
    this.offer = s.offer;
    this.bannedLetter = s.bannedLetter;
    this.highlightBans = s.settings.highlightBannedLetters;
    this.requiredLetter = s.requiredLetter;
    this.live = s.phase === "Round" && this.controller.match.current?.id === human;
    this.onDeck = !this.live && this.isOnDeck(human);
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

  /** Set the selection, stream it to the engine (so a clock expiry commits it rather than counting
   *  as a no-show), and publish it for the bay projection. */
  private select(word: string | null): void {
    this.selected = word;
    if (word !== null) this.controller.reportSelection(word);
    this.dispatchEvent(
      new CustomEvent<{ word: string | null }>("ac-offer-preview", {
        detail: { word },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Tap: select, or commit if this card was already selected (rule 2). */
  private onTap(word: string): void {
    if (!this.live) return;
    if (this.selected === word) this.commit();
    else this.select(word);
  }

  private commit(): void {
    if (!this.live || this.selected === null) return;
    this.controller.commitSelection(this.selected);
  }

  /** Restart the reject animation, matching <ac-word-entry>'s idiom (remove, reflow, re-add so
   *  consecutive rejections each shake rather than the class being a no-op). */
  private shake(): void {
    const el = this.querySelector(".og-wrap");
    if (!el) return;
    el.classList.remove("is-reject");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("is-reject");
  }

  /** Split a word so an active Banned Letter can be marked inside it.
   *
   *  Off by default: scanning several words for one letter under a clock is close to the hardest
   *  single operation you can ask of a dyslexic reader, and it sits on the mechanic that zeroes
   *  their score. It leaks nothing — the HUD already publishes the Banned Letter — so competitive
   *  tables simply leave it off and keep the surprise. */
  private renderWord(word: string): TemplateResult | string {
    const ban = this.bannedLetter;
    if (!this.highlightBans || ban === "" || !word.includes(ban)) return word;
    return html`${word
      .split("")
      .map((ch) => (ch === ban ? html`<mark class="og-ban">${ch}</mark>` : ch))}`;
  }

  /** The §2.3 annotation strip: the features the engine actually scores on, so a card can be
   *  evaluated WITHOUT fully decoding the word. An accessibility requirement, not decoration. */
  private renderAnnotations(word: string): TemplateResult {
    // Clock values are irrelevant to the shape facts read here, so zeros are fine.
    const a = analyzeWord(word, 0, 0, 0);
    const rare = rareLetters(word);
    return html`
      <span class="og-tags" aria-label="${a.length} letters, ${a.vowelCount} vowels">
        <span class="og-tag">${a.length}L</span>
        <span class="og-tag">${a.vowelCount}v</span>
        ${a.endsInVowel
          ? html`<span class="og-tag og-tag--vowel" title="ends in a vowel">→v</span>`
          : nothing}
        ${rare.length
          ? html`<span class="og-tag og-tag--rare" title="rare letters"
              >${rare.join("").toUpperCase()}</span
            >`
          : nothing}
      </span>
    `;
  }

  override render(): TemplateResult {
    const waiting = !this.live;
    return html`
      <div class="og-wrap ${this.live ? "is-live" : ""}">
        <div class="og-head">
          <span class="ac-eyebrow">
            ${this.live
              ? this.requiredLetter
                ? html`pick a word starting with
                    <b class="og-letter">${this.requiredLetter.toUpperCase()}</b>`
                : html`pick any word`
              : this.onDeck
                ? "you're next"
                : "waiting…"}
          </span>
          ${this.feedback ? html`<span class="og-feedback">${this.feedback}</span>` : nothing}
        </div>

        ${this.offer.length === 0
          ? html`<p class="og-empty">${waiting ? "" : "No words available."}</p>`
          : html`
              <div
                class="og-grid ${this.offer.length > NO_SCROLL_LIMIT ? "is-overflow" : ""}"
                role="listbox"
                aria-label="word offer"
              >
                ${this.offer.map(
                  (w) => html`
                    <button
                      class="og-card ${this.selected === w ? "is-selected" : ""}"
                      role="option"
                      aria-selected=${this.selected === w}
                      ?disabled=${waiting}
                      @click=${() => this.onTap(w)}
                    >
                      <span class="og-word">${this.renderWord(w)}</span>
                      ${this.renderAnnotations(w)}
                    </button>
                  `,
                )}
              </div>
            `}

        <button
          class="ac-btn og-go"
          ?disabled=${waiting || this.selected === null}
          @click=${this.commit}
        >
          ${this.selected ? "GO" : "PICK A WORD"}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-offer-grid": AcOfferGrid;
  }
  interface HTMLElementEventMap {
    /** Which Offer word is currently selected (null when cleared) — <ac-hud> listens so it can
     *  light the bay cards that would fire. */
    "ac-offer-preview": CustomEvent<{ word: string | null }>;
  }
}
