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
import { nextLiveIndex } from "../../game/turnOrder";
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

  /** Whether a turn has produced its outcome with no new turn armed since — i.e. the engine's round
   *  settle window, tracked from events rather than read from state.
   *
   *  `live` is re-derived on every clockTick and state does not say "this turn is over":
   *  `roundSettleRemaining` is engine-private, and `state.rack` is not cleared until armCurrentTurn.
   *  So the derivation flipped `live` back on over a rack belonging to the previous turn, leaving
   *  SUBMIT enabled — and commitSelection refuses during the settle window, returning
   *  `{ accepted: false }` with no `rejected` event, so the button was silently dead.
   *
   *  The case that reaches it is the human's own ERA-ENDING word. submitWord emits `submission`
   *  before endTurn runs, so the last derivation still sees the human as the current seat; endTurn
   *  then arms the settle window and returns WITHOUT arming a turn, and nothing fires afterwards —
   *  `tick` returns early while settling, so not even a clockTick. `live` was left true over the rack
   *  of a turn that had already resolved.
   *
   *  Set on ANY player's submission or timeout rather than only the human's: it costs nothing, since
   *  a normal mid-round outcome arms the next turn synchronously and `turnArmed` clears the flag in
   *  the same tick, and it does not depend on the emit-before-advance ordering staying as it is.
   *
   *  A Prism rescue emits `rejected` rather than submission/timeout, so it correctly leaves the turn
   *  live. */
  private settled = false;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    this.cancelPendingStage();
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const human = this.controller.humanId;

      this.listen(e, "turnArmed", ({ requiredLetter }) => {
        this.requiredLetter = requiredLetter;
        this.settled = false;
        this.syncFromState();
        this.feedback = "";
        this.clearStaging();
      });
      this.listen(e, "submission", ({ submission }) => {
        if (submission.playerId === human) this.clearStaging();
        this.settled = true;
        this.live = false;
        this.syncFromState();
      });
      this.listen(e, "timeout", () => {
        this.settled = true;
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
        // Land any stage the throttle is still holding. This fires synchronously inside the engine's
        // emit, ahead of match.tick's timeout check — the same ordering <ac-word-entry> relies on for
        // its auto-submit — so at the buzzer the engine reads the player's finished word rather than
        // whatever fragment the throttle was sitting on.
        this.flushStaging();
        this.syncFromState();
      });

      this.syncFromState();
    }
  }

  private syncFromState(): void {
    const s = this.controller.match.state;
    const human = this.controller.humanId;
    const isHumanTurn = s.phase === "Round" && s.players[s.currentPlayerIndex]?.id === human;
    this.live = isHumanTurn && !this.settled;
    this.isOut = !!s.players.find((p) => p.id === human)?.eliminated;

    // Walked with the engine's own nextLiveIndex rather than a bare +1, because a bare +1 lands on
    // an ELIMINATED seat and then denies the standby cover to the player who is genuinely next — the
    // exact opposite of what the old comment here claimed it was doing.
    const nextSeat = s.players[nextLiveIndex(s.players, s.currentPlayerIndex).index];
    this.onDeck =
      !this.isOut &&
      s.phase === "Round" &&
      !isHumanTurn &&
      !!nextSeat &&
      !nextSeat.eliminated &&
      nextSeat.id === human;

    this.highlightBans = s.settings.highlightBannedLetters;
    this.bannedLetter = s.bannedLetter;
    this.requiredLetter = s.requiredLetter;
    // Follows `live`, not `isHumanTurn`, so the Winnower button does not outlive the turn the same
    // way SUBMIT did.
    this.canRedraw = this.live && s.rackRedrawAvailable;

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
    // The commit carries the word itself, so a pending stage has nothing left to contribute and
    // would only fire against a turn that has already resolved.
    this.cancelPendingStage();
    this.controller.commitSelection(word);
  }

  private cancelPendingStage(): void {
    if (!this.selectTimer) return;
    clearTimeout(this.selectTimer);
    this.selectTimer = null;
  }

  /** Send a stage the throttle is still holding, immediately. A no-op when nothing is pending.
   *
   *  The throttle defers a send by up to THROTTLE_MS, and the engine's expiry commits whatever the
   *  last stage left in `currentSelection`. So a player who taps their final two tiles quickly and
   *  meets the buzzer inside that window had their FRAGMENT submitted, rejected as not-a-word, and —
   *  since showing up now means producing a word the engine ACCEPTS — counted as a no-show, which in
   *  Survival is an elimination on a turn they actually finished. The server's 1 s submit grace
   *  absorbs this in networked play; LocalController.stageTiles is a synchronous setSelection with no
   *  grace at all, so solo Survival had nothing standing between the throttle and the elimination. */
  private flushStaging(): void {
    if (!this.selectTimer) return;
    this.cancelPendingStage();
    if (!this.live) return;
    this.lastSelectAt = Date.now();
    this.controller.stageTiles(this.stagedTileIds, this.stagedWord.trim().toLowerCase());
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
    } else {
      this.selectTimer = setTimeout(() => {
        this.selectTimer = null;
        // Re-checked on the trailing edge, matching <ac-word-entry>'s draft throttle: the turn can
        // have passed while the send sat deferred.
        if (!this.live) return;
        this.lastSelectAt = Date.now();
        // Read fresh rather than reusing the word captured when the timer was scheduled. The tile
        // ids below were always read fresh, so a captured word could disagree with them.
        this.controller.stageTiles(this.stagedTileIds, this.stagedWord.trim().toLowerCase());
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
    // Ignore keydown when interacting with a text control
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    // Chords belong to the browser and the OS. This handler is on the window and `e.key` for Ctrl+R
    // is still a bare "r", so without this every Ctrl/Cmd/Alt combo was preventDefault-ed AND staged
    // a tile for its letter: Ctrl+R staged an `r` instead of reloading, and Ctrl+A/C/V/F and the Cmd
    // equivalents were simply swallowed for the length of your turn.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
