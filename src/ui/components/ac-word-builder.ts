/*
 * <ac-word-builder> — Word Builder's input surface, replacing the whole-word Offer grid.
 *
 * Renders a Tile Rack containing single letters and morpheme chunks, alongside an
 * interactive staging/assembly area where players construct words tile-by-tile.
 *
 * Interaction model:
 * 1. Tap tile on rack -> stages it into the word assembly area in order.
 * 2. Tap tile in assembly area -> returns it to rack.
 * 3. Physical keyboard typing -> matches and stages available tiles automatically.
 * 4. Backspace -> deselects the last staged tile.
 * 5. Enter or SUBMIT button -> commits the constructed word.
 * 6. Live preview -> dispatches `ac-offer-preview` so the Engine Bay projects live multipliers.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Tile } from "../../game/types";
import { isVowel } from "../../game/settings";
import { RARE_START } from "../../game/cards/card";
import type { GameController } from "../../net/controller";
import { AcElement } from "../app/AcElement";
import { REJECT_REASON } from "./reject-reasons";

@customElement("ac-word-builder")
export class AcWordBuilder extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private rack: Tile[] = [];
  @state() private displayTileIds: string[] = [];
  @state() private stagedTileIds: string[] = [];
  @state() private live = false;
  @state() private onDeck = false;
  /** Survival: eliminated. The rack still renders, but nothing on it is ours any more. */
  @state() private isOut = false;
  @state() private requiredLetter = "";
  @state() private bannedLetter = "";
  @state() private feedback = "";
  @state() private highlightBans = false;
  @state() private canRedraw = false;

  private selectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelectAt = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.selectTimer) {
      clearTimeout(this.selectTimer);
      this.selectTimer = null;
    }
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const human = this.controller.humanId;

      this.listen(e, "turnArmed", ({ requiredLetter }) => {
        this.requiredLetter = requiredLetter;
        this.syncFromState();
        this.feedback = "";
        this.clearStaging();
      });
      this.listen(e, "submission", ({ submission }) => {
        if (submission.playerId === human) this.clearStaging();
        this.live = false;
        this.syncFromState();
      });
      this.listen(e, "timeout", () => {
        this.live = false;
        this.clearStaging();
        this.syncFromState();
      });
      this.listen(e, "rejected", ({ playerId, reason }) => {
        if (playerId !== human) return;
        this.feedback = REJECT_REASON[reason];
        this.shake();
      });
      this.listen(e, "clockTick", () => {
        this.syncFromState();
      });

      this.syncFromState();
    }
  }

  private syncFromState(): void {
    const s = this.controller.match.state;
    const human = this.controller.humanId;
    const isHumanTurn = s.phase === "Round" && s.players[s.currentPlayerIndex]?.id === human;
    this.live = isHumanTurn;
    this.isOut = !!s.players.find((p) => p.id === human)?.eliminated;

    const nextIdx = (s.currentPlayerIndex + 1) % Math.max(1, s.players.length);
    // An eliminated seat is never on deck — advanceIndex skips it, so promising a turn would lie.
    this.onDeck =
      !this.isOut && s.phase === "Round" && !isHumanTurn && s.players[nextIdx]?.id === human;

    this.highlightBans = s.settings.highlightBannedLetters;
    this.bannedLetter = s.bannedLetter;
    this.requiredLetter = s.requiredLetter;
    this.canRedraw = isHumanTurn && (s.rackRedrawAvailable || s.offerRedrawAvailable);

    // Sync rack content
    if (s.rack && s.rack.length > 0) {
      if (!this.areRacksEqual(this.rack, s.rack)) {
        this.rack = [...s.rack];
        this.displayTileIds = this.rack.map((t) => t.id);
        // If rack regenerated, validate existing staged IDs
        const rackIds = new Set(this.rack.map((t) => t.id));
        const validStaged = this.stagedTileIds.filter((id) => rackIds.has(id));
        if (validStaged.length !== this.stagedTileIds.length) {
          this.stagedTileIds = validStaged;
          this.publishPreview();
        }
      }
    } else {
      this.rack = [];
      this.displayTileIds = [];
      if (this.stagedTileIds.length > 0) {
        this.stagedTileIds = [];
        this.publishPreview();
      }
    }
  }

  private areRacksEqual(a: readonly Tile[], b: readonly Tile[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].text !== b[i].text || a[i].isChunk !== b[i].isChunk) {
        return false;
      }
    }
    return true;
  }

  private shuffleRack(): void {
    if (!this.live || this.displayTileIds.length <= 1) return;
    const shuffled = [...this.displayTileIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = temp;
    }
    this.displayTileIds = shuffled;
  }

  private get stagedWord(): string {
    const tileMap = new Map(this.rack.map((t) => [t.id, t.text]));
    return this.stagedTileIds.map((id) => tileMap.get(id) ?? "").join("");
  }

  private stageTile(tileId: string): void {
    if (!this.live || this.stagedTileIds.includes(tileId)) return;
    this.stagedTileIds = [...this.stagedTileIds, tileId];
    this.feedback = "";
    this.publishPreview();
    this.streamStaging();
  }

  private unstageTile(tileId: string): void {
    if (!this.live) return;
    this.stagedTileIds = this.stagedTileIds.filter((id) => id !== tileId);
    this.feedback = "";
    this.publishPreview();
    this.streamStaging();
  }

  private clearStaging(): void {
    if (this.stagedTileIds.length === 0) return;
    this.stagedTileIds = [];
    this.feedback = "";
    this.publishPreview();
    this.streamStaging();
  }

  private commit(): void {
    if (!this.live) return;
    const word = this.stagedWord.trim().toLowerCase();
    if (!word) return;
    this.controller.commitSelection(word);
  }

  private redraw(): void {
    if (!this.live || !this.canRedraw) return;
    this.clearStaging();
    this.controller.redrawRack();
  }

  private publishPreview(): void {
    const word = this.stagedWord.trim().toLowerCase();
    this.dispatchEvent(
      new CustomEvent("ac-offer-preview", {
        detail: { word },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private streamStaging(): void {
    const word = this.stagedWord.trim().toLowerCase();
    const now = Date.now();
    const elapsed = now - this.lastSelectAt;
    const THROTTLE_MS = 80;

    if (this.selectTimer) {
      clearTimeout(this.selectTimer);
      this.selectTimer = null;
    }

    if (elapsed >= THROTTLE_MS) {
      this.lastSelectAt = now;
      this.controller.stageTiles(this.stagedTileIds, word);
      this.controller.reportSelection(word);
    } else {
      this.selectTimer = setTimeout(() => {
        this.lastSelectAt = Date.now();
        this.selectTimer = null;
        this.controller.stageTiles(this.stagedTileIds, word);
        this.controller.reportSelection(word);
      }, THROTTLE_MS - elapsed);
    }
  }

  private shake(): void {
    const el = this.querySelector(".ac-word-builder");
    if (!el) return;
    el.classList.remove("is-reject");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("is-reject");
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ignore keydown when interacting with input/textarea/select
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (!this.live) return;

    if (e.key === "Enter") {
      e.preventDefault();
      this.commit();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (this.stagedTileIds.length > 0) {
        const lastId = this.stagedTileIds[this.stagedTileIds.length - 1];
        this.unstageTile(lastId);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.clearStaging();
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      const char = e.key.toLowerCase();
      // Try to find available single tile matching char, or chunk starting with char
      const available = this.rack.filter((t) => !this.stagedTileIds.includes(t.id));
      const exactMatch = available.find((t) => !t.isChunk && t.text === char);
      if (exactMatch) {
        this.stageTile(exactMatch.id);
        return;
      }
      const chunkMatch = available.find((t) => t.isChunk && t.text.startsWith(char));
      if (chunkMatch) {
        this.stageTile(chunkMatch.id);
      }
    }
  };

  override render(): TemplateResult {
    const staged = this.stagedWord;
    const tileMap = new Map(this.rack.map((t) => [t.id, t]));
    const stagedTiles = this.stagedTileIds
      .map((id) => tileMap.get(id))
      .filter((t): t is Tile => !!t);

    let vowelCount = 0;
    let rareCount = 0;
    for (const ch of staged) {
      if (isVowel(ch)) vowelCount++;
      if (RARE_START.has(ch)) rareCount++;
    }

    return html`
      <div
        class="ac-word-builder ${this.live ? "is-live" : "is-idle"} ${this.onDeck
          ? "is-ondeck"
          : ""} ${this.isOut ? "is-out" : ""}"
        role="region"
        aria-label="Word Builder"
      >
        <!-- Banner / Turn Alert -->
        <header class="ac-builder-header">
          <div class="ac-builder-meta">
            ${this.requiredLetter
              ? html`<span class="ac-chip ac-chip--req" title="Required starting letter">
                  Starts with <strong>${this.requiredLetter.toUpperCase()}</strong>
                </span>`
              : html`<span class="ac-chip ac-chip--req">Free Choice</span>`}
            ${this.bannedLetter && this.highlightBans
              ? html`<span class="ac-chip ac-chip--ban" title="Banned Letter">
                  Avoid <strong>${this.bannedLetter.toUpperCase()}</strong>
                </span>`
              : nothing}
            ${this.feedback
              ? html`<span class="ac-builder-feedback shake" role="alert" aria-live="assertive">
                  ${this.feedback}
                </span>`
              : html`<span
                  class="ac-builder-stat ${staged.length > 0 ? "is-visible" : "is-hidden"}"
                  aria-live="polite"
                >
                  ${staged.length > 0
                    ? `${staged.length}L · ${vowelCount}V${rareCount > 0 ? ` · ${rareCount} rare` : ""}`
                    : html`&nbsp;`}
                </span>`}
          </div>

          <div class="ac-builder-actions">
            <button
              type="button"
              class="ac-btn ac-btn--subtle ac-btn--shuffle"
              @click=${this.shuffleRack}
              ?disabled=${!this.live || this.rack.length <= 1}
              title="Shuffle rack tiles"
            >
              ⇄ Shuffle
            </button>
            ${this.canRedraw
              ? html`<button
                  type="button"
                  class="ac-btn ac-btn--subtle ac-btn--redraw"
                  @click=${this.redraw}
                  title="Winnower: Redraw entire Tile Rack"
                >
                  ↻ Redraw Rack
                </button>`
              : nothing}
          </div>
        </header>

        <!-- Staging / Assembly Area -->
        <div class="ac-builder-input">
          <!-- Standby cover. Only while you are next: it blanks the controls you
               cannot use yet without hiding the letter you need to plan around.
               Always mounted and toggled by class rather than rendered
               conditionally, because a conditional render is removed from the
               DOM the instant you go live and there is nothing left to animate
               out. -->
          <div
            class="ac-standby ${this.isOut || (!this.live && this.onDeck) ? "is-shown" : ""}"
            aria-hidden="true"
          >
            <span class="ac-standby-plate ${this.isOut ? "is-out" : ""}"
              >${this.isOut ? "Eliminated" : "You're Next"}</span
            >
          </div>
          <section class="ac-staging-area" aria-label="Assembled Word">
            <div class="ac-staging-track ${stagedTiles.length === 0 ? "is-empty" : ""}">
              ${stagedTiles.length === 0
                ? html`<span class="ac-staging-placeholder">
                    ${this.isOut
                      ? "You timed out — spectating."
                      : this.live
                        ? "Tap tiles or type to build a word…"
                        : this.onDeck
                          ? "You are on deck…"
                          : "Waiting for turn…"}
                  </span>`
                : stagedTiles.map((tile) => {
                    const isStarter =
                      this.requiredLetter !== "" &&
                      tile.text.toLowerCase().startsWith(this.requiredLetter.toLowerCase());
                    return html`
                      <button
                        type="button"
                        class="ac-tile ac-tile--staged ${tile.isChunk
                          ? "ac-tile--chunk"
                          : ""} ${isStarter ? "is-starter" : ""}"
                        @click=${() => this.unstageTile(tile.id)}
                        title="Tap to return ${tile.text.toUpperCase()} to rack"
                        aria-label="Remove ${tile.text.toUpperCase()}"
                      >
                        <span class="ac-tile-letter">${tile.text.toUpperCase()}</span>
                      </button>
                    `;
                  })}
            </div>

            <div class="ac-staging-actions">
              <button
                type="button"
                class="ac-btn ac-btn--ghost ac-btn--clear"
                @click=${this.clearStaging}
                ?disabled=${!this.live || stagedTiles.length === 0}
                title="Clear assembled word (Esc)"
              >
                ✕
              </button>
              <button
                type="button"
                class="ac-btn ac-btn--primary ac-btn--submit"
                @click=${this.commit}
                ?disabled=${!this.live || stagedTiles.length === 0}
                title="Submit word (Enter)"
              >
                SUBMIT
              </button>
            </div>
          </section>

          <!-- Tile Rack -->
          <section class="ac-tile-rack" aria-label="Available Tiles">
            <div class="ac-rack-grid">
              ${(this.displayTileIds.length > 0
                ? this.displayTileIds.map((id) => tileMap.get(id)).filter((t): t is Tile => !!t)
                : this.rack
              ).map((tile) => {
                const isStaged = this.stagedTileIds.includes(tile.id);
                const hasBanned =
                  this.highlightBans &&
                  this.bannedLetter !== "" &&
                  tile.text.toLowerCase().includes(this.bannedLetter.toLowerCase());
                const isStarter =
                  this.requiredLetter !== "" &&
                  tile.text.toLowerCase().startsWith(this.requiredLetter.toLowerCase());

                return html`
                  <button
                    type="button"
                    class="ac-tile ${tile.isChunk ? "ac-tile--chunk" : ""} ${isStaged
                      ? "is-staged"
                      : ""} ${hasBanned ? "is-banned" : ""} ${isStarter ? "is-starter" : ""}"
                    ?disabled=${!this.live || isStaged}
                    @click=${() => this.stageTile(tile.id)}
                    title=${isStaged
                      ? "In assembled word"
                      : `Use tile ${tile.text.toUpperCase()}${isStarter ? ` (Starts with ${this.requiredLetter.toUpperCase()})` : ""}`}
                    aria-label="Tile ${tile.text.toUpperCase()}"
                  >
                    <span class="ac-tile-letter">${tile.text.toUpperCase()}</span>
                    ${hasBanned
                      ? html`<span class="ac-tile-ban-dot" title="Contains banned letter">!</span>`
                      : nothing}
                  </button>
                `;
              })}
            </div>
          </section>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-word-builder": AcWordBuilder;
  }
}
