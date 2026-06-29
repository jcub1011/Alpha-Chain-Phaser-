/*
 * <ac-sandbox> — the "Testing Bay" (ports the Blazor BenchView). It drives a
 * live, throwaway MatchController via BenchScenario so every card behaviour can
 * be exercised end-to-end: 2–8 players each with their own engine bay, a settable
 * banned letter, editable scores, turn order, word submission with a staged shot
 * clock (for time-reactive cards), skip-turn, the full per-card score breakdown
 * of the latest play, off-turn effects, submission history, and the complete card
 * palette. Reached from the lobby's "Testing Bay" button or with ?sandbox.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { BenchScenario } from "../../game/bench";
import { CARD_LIBRARY } from "../../game/cards/library";
import type { Dictionary } from "../../game/dictionary";
import type { ScoreStep } from "../../game/types";
import { familyAccentVar, fmtScore, playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";
import "../components/ac-engine-bay";
import "../components/ac-card";

const CARD_COUNT = Object.keys(CARD_LIBRARY).length;

@customElement("ac-sandbox")
export class AcSandbox extends AcElement {
  /** Supplied by <ac-app>; the live word validator the bench match runs on. */
  @property({ attribute: false }) dict?: Dictionary;

  @state() private bench?: BenchScenario;
  /** Palette target — the player a "+ Add" drops a card onto. */
  @state() private selected = 0;
  @state() private word = "";
  @state() private remaining = 15;
  @state() private paletteLarge = true;
  /** Last rejection reason (cleared on the next accepted word). */
  @state() private message = "";

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("dict") && this.dict && !this.bench) {
      this.bench = new BenchScenario(this.dict);
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  private setPlayers(n: number): void {
    this.bench?.reset(n);
    this.selected = 0;
    this.message = "";
    this.requestUpdate();
  }
  private onBan(e: Event): void {
    this.bench?.setBannedLetter((e.target as HTMLInputElement).value);
    this.requestUpdate();
  }
  private onScore(playerId: string, e: Event): void {
    this.bench?.setScore(playerId, Number((e.target as HTMLInputElement).value));
    this.requestUpdate();
  }
  private addCard(cardId: string): void {
    const target = this.bench?.players[this.selected];
    if (target) this.bench?.addCard(target.id, cardId);
    this.requestUpdate();
  }
  private removeAt(playerId: string, i: number): void {
    this.bench?.removeAt(playerId, i);
    this.requestUpdate();
  }
  private moveCard(playerId: string, i: number, delta: number): void {
    this.bench?.moveCard(playerId, i, delta);
    this.requestUpdate();
  }
  private submit(): void {
    if (!this.bench) return;
    const r = this.bench.submit(this.word.trim(), this.remaining);
    this.message = r.accepted ? "" : `Rejected: ${r.reason ?? "invalid"}`;
    if (r.accepted) this.word = "";
    this.requestUpdate();
  }
  private skip(): void {
    this.bench?.skip();
    this.message = "";
    this.requestUpdate();
  }
  private back(): void {
    location.href = location.pathname;
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  override render(): TemplateResult {
    const b = this.bench;
    if (!b) {
      return html`<div class="sandbox"><p class="sandbox-loading">Loading dictionary…</p></div>`;
    }
    const players = b.players;
    const currentId = b.currentPlayerId;
    const currentName = players[b.currentPlayerIndex]?.name ?? "—";
    const targetName = players[this.selected]?.name ?? "—";

    return html`
      <div class="sandbox">
        <header class="sandbox-head">
          <div>
            <h1>Testing Bay</h1>
            <p>
              ${CARD_COUNT} cards · live engine · stack bays, submit words, inspect every effect.
            </p>
          </div>
          <button class="chip" @click=${this.back}>← Back to lobby</button>
        </header>

        <section class="sandbox-controls">
          <label
            >Players
            <select
              @change=${(e: Event) =>
                this.setPlayers(Number((e.target as HTMLSelectElement).value))}
            >
              ${[2, 3, 4, 5, 6, 7, 8].map(
                (n) => html`<option value=${n} ?selected=${players.length === n}>${n}</option>`,
              )}
            </select>
          </label>
          <label
            >Banned letter
            <input
              type="text"
              maxlength="1"
              placeholder="—"
              .value=${b.bannedLetter}
              @input=${(e: Event) => this.onBan(e)}
            />
          </label>
          <div class="sandbox-turn">
            <span class="sandbox-turn-label">Current turn</span>
            <strong>${currentName}</strong>
            ${b.requiredLetter
              ? html`<span class="sandbox-req">needs “${b.requiredLetter.toUpperCase()}”</span>`
              : nothing}
          </div>
        </section>

        <section class="sandbox-players">
          ${players.map((p, pi) => this.renderPlayer(p, pi, currentId))}
        </section>

        <section class="sandbox-submit">
          <label class="sandbox-word"
            >Word for ${currentName}
            <input
              type="text"
              placeholder="type a word…"
              .value=${this.word}
              @input=${(e: Event) => (this.word = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.submit()}
            />
          </label>
          <label
            >Clock remaining (s)
            <input
              type="number"
              min="0"
              .value=${String(this.remaining)}
              @input=${(e: Event) =>
                (this.remaining = Number((e.target as HTMLInputElement).value))}
            />
          </label>
          <button class="ac-btn" @click=${this.submit}>Submit</button>
          <button class="chip" @click=${this.skip}>Skip turn ▶</button>
          ${this.message ? html`<span class="sandbox-msg">${this.message}</span>` : nothing}
        </section>

        ${this.renderBreakdown()} ${this.renderHistory()} ${this.renderPalette(targetName)}
      </div>
    `;
  }

  private renderPlayer(
    p: BenchScenario["players"][number],
    pi: number,
    currentId: string,
  ): TemplateResult {
    const isCurrent = p.id === currentId;
    const isTarget = pi === this.selected;
    const bay = p.bay;
    return html`
      <div
        class="sandbox-player ${isCurrent ? "is-current" : ""} ${isTarget ? "is-target" : ""}"
        style="--p-accent:${playerAccentVar(p.accentIndex)};"
      >
        <div class="sandbox-player-head">
          <button class="sandbox-player-name" @click=${() => (this.selected = pi)}>
            ${p.name}${isCurrent ? " • turn" : ""}
          </button>
          <label class="sandbox-player-score"
            >Score
            <input
              type="number"
              min="0"
              .value=${String(p.score)}
              @input=${(e: Event) => this.onScore(p.id, e)}
            />
          </label>
        </div>
        ${bay.length === 0
          ? html`<p class="sandbox-empty">
              No cards. Select this player, then “+ Add” from the palette.
            </p>`
          : html`
              <div class="sandbox-slots">
                ${bay.map(
                  (c, i) => html`
                    <div class="sandbox-slot">
                      <ac-card .cardId=${c.id} mini></ac-card>
                      <div class="sandbox-slot-ops">
                        <button
                          ?disabled=${i === 0}
                          title="move left"
                          @click=${() => this.moveCard(p.id, i, -1)}
                        >
                          ◀
                        </button>
                        <button title="remove" @click=${() => this.removeAt(p.id, i)}>✕</button>
                        <button
                          ?disabled=${i === bay.length - 1}
                          title="move right"
                          @click=${() => this.moveCard(p.id, i, 1)}
                        >
                          ▶
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderBreakdown(): TemplateResult | typeof nothing {
    const sub = this.bench?.latest;
    if (!sub) return nothing;
    const bd = sub.breakdown;
    return html`
      <section class="sandbox-result">
        <div class="sandbox-total">
          <span>${sub.displayName}: <b>${bd.word.toUpperCase() || "∅"}</b></span>
          <span>Seed: <b>${bd.seed}</b></span>
          <span>Pre-tax: <b>${bd.finalBeforeTax}</b></span>
          <span class="big ${bd.taxed ? "taxed" : ""}">
            ${bd.taxed ? "Taxed" : "Score"}: <b>${bd.finalScore}</b>
          </span>
        </div>
        <ol class="sandbox-steps">
          ${bd.steps.map((s) => this.renderStep(s))}
        </ol>
        ${sub.taxBounty > 0
          ? html`<p class="sandbox-steal">
              Siphoned by ${(sub.siphonedBy ?? []).join(", ")}: +${sub.taxBounty} total.
            </p>`
          : nothing}
        ${sub.effects?.length
          ? html`
              <div class="sandbox-effects">
                <span class="sandbox-turn-label">Off-turn effects</span>
                ${sub.effects.map(
                  (fx) => html`<div class="sandbox-effect">${fx.source} · ${fx.text}</div>`,
                )}
              </div>
            `
          : nothing}
      </section>
    `;
  }

  private renderStep(s: ScoreStep): TemplateResult {
    return html`
      <li class=${s.triggered ? "on" : "off"} style="--step-accent:${familyAccentVar(s.family)};">
        <span class="step-name">${s.name}</span>
        <span class="step-val">${s.valueText}</span>
        <span class="step-run">${fmtScore(s.runningScore)}</span>
      </li>
    `;
  }

  private renderHistory(): TemplateResult | typeof nothing {
    const hist = this.bench?.history ?? [];
    if (hist.length === 0) return nothing;
    return html`
      <section class="sandbox-history">
        <span class="sandbox-turn-label">Submission history · ${hist.length}</span>
        <ol class="sandbox-history-list">
          ${[...hist].reverse().map(
            (sub, idx) => html`
              <li class="sandbox-history-item">
                <span class="sandbox-history-num">#${hist.length - idx}</span>
                <span class="sandbox-history-who">${sub.displayName}</span>
                <span class="sandbox-history-word">${sub.word.toUpperCase()}</span>
                ${sub.taxed
                  ? html`<span class="sandbox-history-tax">taxed · 0</span>`
                  : html`<span class="sandbox-history-score">+${sub.score}</span>`}
                ${sub.taxBounty > 0
                  ? html`<span class="sandbox-history-bounty">bounty +${sub.taxBounty}</span>`
                  : nothing}
              </li>
            `,
          )}
        </ol>
      </section>
    `;
  }

  private renderPalette(targetName: string): TemplateResult {
    return html`
      <section class="sandbox-palette">
        <div class="sandbox-palette-head">
          <h2>Card palette → adding to ${targetName}</h2>
          <button class="chip" @click=${() => (this.paletteLarge = !this.paletteLarge)}>
            ${this.paletteLarge ? "Show small" : "Show large"}
          </button>
        </div>
        <div class="palette-grid ${this.paletteLarge ? "" : "is-small"}">
          ${Object.values(CARD_LIBRARY).map(
            (c) => html`
              <div class="palette-item">
                <ac-card .cardId=${c.id} ?mini=${!this.paletteLarge}></ac-card>
                <button class="palette-add" @click=${() => this.addCard(c.id)}>＋ Add</button>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-sandbox": AcSandbox;
  }
}
