/*
 * <ac-tutorial> — the scripted tutorial overlay. Each page leads with a looping
 * demonstration animation (CSS-driven, frozen under prefers-reduced-motion); the
 * scripted lines are supplementary captions beneath it. Shown during the top-level
 * "Tutorial" phase (chain → timeout, before the first round) and over the
 * intermission "tutorial" sub-phase (engine → cards before optimize; tax → sniper
 * before the ban). The dwell is host-authoritative; this view reads the synced
 * sub-timer for its progress ring.
 *
 * Readiness: every player has an "I've Read This" button; the page auto-advances
 * once all are ready (the host also keeps SKIP, and the dwell timer is a fallback).
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { TutorialKind } from "../../game/types";
import { AcElement } from "../app/AcElement";

interface Script {
  eyebrow: string;
  title: string;
  lines: string[];
}

const SCRIPTS: Record<TutorialKind, Script> = {
  shiritori: {
    eyebrow: "how to play · the chain",
    title: "Chain the letters",
    lines: [
      "Each word must begin with the last letter of the word before it.",
      "Words can't be repeated.",
    ],
  },
  timeout: {
    eyebrow: "how to play · the shot clock",
    title: "Beat the clock",
    lines: [
      "Submit before the shot clock hits zero.",
      "Time out and you lose points — and in Survival mode, your spot.",
    ],
  },
  // ── Word Builder's pre-game pair. Classic's two above are left exactly as they were. ──
  offer: {
    eyebrow: "how to play · word builder",
    title: "Build your word",
    lines: [
      "Assemble words from your tile rack by tapping tiles or typing on your keyboard.",
      "Green tiles start with the required chain letter. Blue tiles are multi-letter chunks.",
      "Assembling a word shows which engine cards will fire — submit to lock in your score.",
    ],
  },
  pickerTimeout: {
    eyebrow: "how to play · the shot clock",
    title: "The clock plays your word",
    lines: [
      "When the shot clock expires, any valid word you've assembled is submitted automatically.",
      "If nothing valid is staged, a word is built for you without penalty — but in Survival mode, that costs you your spot.",
    ],
  },
  engine: {
    eyebrow: "how to play · your engine",
    title: "Your engine scores left → right",
    lines: [
      "Engine cards are evaluated from left to right.",
      "Keep adds to the left and multipliers to the right for bigger scores.",
    ],
  },
  cards: {
    eyebrow: "how to play · building your engine",
    title: "Draft & arrange cards",
    lines: [
      "Each intermission you're dealt new cards.",
      "Drag them into your engine and order them — slots are limited.",
    ],
  },
  tax: {
    eyebrow: "how to play · the ban",
    title: "Mind the banned letter",
    lines: [
      "Each era, the last-place player bans one letter.",
      "Any word containing it scores nothing that era — except last place, who's exempt.",
    ],
  },
  sniper: {
    eyebrow: "how to play · the sniper ban",
    title: "Last place strikes back",
    lines: [
      "If you're in last place, you choose the letter to ban next era.",
      "Pick what your rivals lean on — you'll see what scored well.",
    ],
  },
};

@customElement("ac-tutorial")
export class AcTutorial extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  override willUpdate(changed: PropertyValues): void {
    // The FSM owns the authoritative dwell; re-render the progress ring (and the
    // ready count) whenever the synced sub-timer ticks (per frame, never broadcast).
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      this.listen(this.controller.match.events, "subTimerTick", () => this.requestUpdate());
    }
  }

  /** Only the lobby owner (or a solo player) may skip the shared dwell for everyone.
   *  Mirrors the authority's own gate on the skipTutorial intent — showing SKIP to anyone
   *  else offers a button the server will refuse. */
  private get canSkip(): boolean {
    return this.controller.isOwner;
  }

  /** Whether this client has already marked the current page read. */
  private get amReady(): boolean {
    return this.controller.match.state.tutorialReady.includes(this.controller.humanId);
  }

  /** Ready tally across active humans (for the "X / N ready" hint). */
  private get readyCount(): { ready: number; total: number } {
    const s = this.controller.match.state;
    const humans = s.players.filter((p) => !p.isBot && !p.eliminated);
    return {
      ready: humans.filter((p) => s.tutorialReady.includes(p.id)).length,
      total: humans.length,
    };
  }

  private skip(): void {
    this.controller.match.skipTutorial();
  }

  private markRead(): void {
    this.controller.match.markTutorialReady(this.controller.humanId);
    this.requestUpdate();
  }

  /** The per-page demonstration animation (CSS-driven; frozen under reduced motion). */
  private renderStage(kind: TutorialKind): TemplateResult {
    switch (kind) {
      case "shiritori":
        return html`<div class="tut-stage tut-chain">
          ${["CAT", "TIN", "NET"].map(
            (w, wi) => html`
              ${wi > 0 ? html`<span class="tut-arrow" style="--i:${wi}">→</span>` : nothing}
              <span class="tut-word" style="--i:${wi}">
                ${[...w].map(
                  (ch, ci) =>
                    html`<span
                      class="tut-tile ${(wi > 0 && ci === 0) || ci === w.length - 1
                        ? "is-link"
                        : ""}"
                      >${ch}</span
                    >`,
                )}
              </span>
            `,
          )}
        </div>`;
      case "timeout":
        return html`<div class="tut-stage tut-timeout">
          <div class="tut-clock">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <circle class="tut-clock-track" cx="32" cy="32" r="28" />
              <circle class="tut-clock-fill" cx="32" cy="32" r="28" />
            </svg>
            <span class="tut-clock-ico">⏱</span>
          </div>
          <div class="tut-timeout-out">
            <span class="tut-stamp">TIMED OUT</span>
            <span class="tut-penalty">−10</span>
          </div>
        </div>`;
      case "offer":
        // Word Builder rack & assembly area demo:
        // Staged word [T] [R] [A] [I] [N] in staging track,
        // tile rack below with starter, single, and chunk tiles, plus active engine bay.
        return html`<div class="tut-stage tut-builder">
          <div class="tut-builder-track">
            <span class="tut-btile is-starter is-staged">T</span>
            <span class="tut-btile is-staged">R</span>
            <span class="tut-btile is-staged">A</span>
            <span class="tut-btile is-staged">I</span>
            <span class="tut-btile is-staged">N</span>
          </div>
          <div class="tut-builder-rack">
            <span class="tut-btile is-starter is-dim">T</span>
            <span class="tut-btile is-dim">R</span>
            <span class="tut-btile is-dim">A</span>
            <span class="tut-btile is-dim">I</span>
            <span class="tut-btile is-dim">N</span>
            <span class="tut-btile is-chunk">ING</span>
            <span class="tut-btile">E</span>
            <span class="tut-btile">D</span>
          </div>
          <div class="tut-offer-bay" aria-hidden="true">
            <span class="tut-ecard is-add" style="--i:0">+5</span>
            <span class="tut-ecard is-mul is-lit" style="--i:1">×2</span>
            <span class="tut-ecard is-add" style="--i:2">+8</span>
          </div>
        </div>`;
      case "pickerTimeout":
        // The same clock as Classic's page, with Word Builder outcome: your assembled word
        // resolves with no penalty rather than −10.
        return html`<div class="tut-stage tut-timeout">
          <div class="tut-clock">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <circle class="tut-clock-track" cx="32" cy="32" r="28" />
              <circle class="tut-clock-fill" cx="32" cy="32" r="28" />
            </svg>
            <span class="tut-clock-ico">⏱</span>
          </div>
          <div class="tut-timeout-out">
            <span class="tut-stamp is-safe">YOUR WORD PLAYS</span>
            <span class="tut-penalty is-safe">−0</span>
          </div>
        </div>`;
      case "engine":
        return html`<div class="tut-stage tut-engine">
          <div class="tut-engine-row">
            <span class="tut-ecard is-add" style="--i:0">+5</span>
            <span class="tut-ecard is-add" style="--i:1">+8</span>
            <span class="tut-ecard is-mul" style="--i:2">×2</span>
          </div>
          <span class="tut-engine-sweep" aria-hidden="true"></span>
          <div class="tut-engine-score">26</div>
        </div>`;
      case "cards":
        return html`<div class="tut-stage tut-deal">
          ${[0, 1, 2].map(
            (i) =>
              html`<span class="tut-dcard" style="--i:${i}">
                <span class="tut-dcard-ico">🃏</span>
                ${i === 2 ? html`<span class="tut-dcard-new">NEW</span>` : nothing}
              </span>`,
          )}
        </div>`;
      case "tax":
        return html`<div class="tut-stage tut-tax">
          <span class="tut-banned">S</span>
          <span class="tut-tax-word">
            <span class="tut-tax-text">STAR</span>
            <span class="tut-tax-zero">0</span>
          </span>
        </div>`;
      case "sniper":
        return html`<div class="tut-stage tut-sniper">
          <div class="tut-board">
            <span class="tut-board-row" style="--i:0"><b>1st</b> rival · 240</span>
            <span class="tut-board-row" style="--i:1"><b>2nd</b> rival · 180</span>
            <span class="tut-board-row is-last" style="--i:2"><b>last</b> you · 90</span>
          </div>
          <div class="tut-sniper-pick">
            <span class="tut-arrow">→</span>
            <span class="tut-ban-key">E</span>
          </div>
        </div>`;
    }
  }

  override render(): TemplateResult {
    const s = this.controller.match.state;
    const kind = s.currentTutorial;
    if (!kind) return html`${nothing}`;
    const script = SCRIPTS[kind];
    const total = s.subTimerTotal || 1;
    const frac = Math.max(0, Math.min(1, s.subTimerRemaining / total));
    const secs = Math.ceil(s.subTimerRemaining);
    const { ready, total: humans } = this.readyCount;
    return html`
      <div class="overlay tutorial">
        <div class="tut-card ac-panel">
          <span class="ac-eyebrow">${script.eyebrow}</span>
          <h2 class="tut-title">${script.title}</h2>
          ${this.renderStage(kind)}
          <ul class="tut-lines">
            ${script.lines.map((l) => html`<li>${l}</li>`)}
          </ul>
          <div class="tut-foot">
            <div class="tut-bar" role="progressbar" aria-valuenow=${secs}>
              <div class="tut-bar-fill" style="transform:scaleX(${frac})"></div>
            </div>
            <span class="tut-secs">${secs}s</span>
            ${humans > 1
              ? html`<span class="tut-ready-count">${ready}/${humans} ready</span>`
              : nothing}
            ${this.amReady
              ? html`<button class="ac-btn tut-read is-ready" disabled>✓ READY</button>`
              : html`<button class="ac-btn tut-read" @click=${() => this.markRead()}>
                  I'VE READ THIS
                </button>`}
            ${this.canSkip
              ? html`<button class="ac-btn tut-skip" @click=${() => this.skip()}>SKIP</button>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-tutorial": AcTutorial;
  }
}
