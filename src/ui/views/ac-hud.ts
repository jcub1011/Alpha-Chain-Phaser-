/*
 * <ac-hud> — the live game surface. A responsive CSS grid (main stage + sticky
 * leaderboard rail on desktop; single column with a leaderboard strip on
 * mobile). It owns only structure + the low-frequency derived state for the
 * command rail and bays; the clock, entry, leaderboard, feed and score replay
 * are self-driving components. The human bay is tagged `.mine` so the score
 * replay can find the cards it animates.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { BayCard, PlayerState } from "../../game/types";
import { playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

import "../components/ac-shot-clock";
import "../components/ac-word-entry";
import "../components/ac-leaderboard";
import "../components/ac-recent-words";
import "../components/ac-score-replay";
import "../components/ac-engine-bay";

@customElement("ac-hud")
export class AcHud extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private requiredLetter = "";
  @state() private bannedLetter = "";
  @state() private era = 1;
  @state() private roundInEra = 0;
  @state() private currentName = "";
  @state() private isHumanTurn = false;
  @state() private humanExempt = false;
  @state() private personalBans: string[] = [];
  @state() private humanBay: BayCard[] = [];
  @state() private humanSlots = 3;
  @state() private opponents: PlayerState[] = [];

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const refresh = (): void => this.refresh();
      this.listen(e, "turnArmed", refresh);
      this.listen(e, "submission", refresh);
      this.listen(e, "timeout", refresh);
      this.listen(e, "phaseChanged", refresh);
      this.listen(e, "intermission", refresh);
      this.refresh();
    }
  }

  private refresh(): void {
    const m = this.controller.match;
    const s = m.state;
    const human = this.controller.humanId;
    this.requiredLetter = s.requiredLetter;
    this.bannedLetter = s.bannedLetter;
    this.era = s.era;
    this.roundInEra = s.roundInEra;
    const cur = m.current;
    this.currentName = cur?.name ?? "";
    this.isHumanTurn = s.phase === "Round" && cur?.id === human;
    const me = s.players.find((p) => p.id === human);
    this.humanBay = me ? [...me.bay] : [];
    this.humanSlots = me?.slots ?? 3;
    // Sort opponents by their (stable) accent index for display, not by array
    // order: the host reshuffles `players` every era for turn order, which would
    // otherwise make the opponent tiles jump seats between eras.
    this.opponents = s.players
      .filter((p) => p.id !== human)
      .sort((a, b) => a.accentIndex - b.accentIndex);
    // The last-place player is exempt from the banned-letter tax (they picked
    // it). Surface it so keeping points on a banned word never reads as a bug.
    this.humanExempt = !!me && !!s.bannedLetter && m.isExempt(me);
    this.personalBans = me ? m.personalBansFor(me.id) : [];
  }

  override render(): TemplateResult {
    const c = this.controller;
    const eraInterval = c.match.state.settings.eraInterval;
    const free = !this.requiredLetter;
    return html`
      <div class="hud">
        <main class="stage">
          <section class="command ac-panel">
            <div class="cmd-cell cmd-left">
              <span class="ac-eyebrow">start with</span>
              <span class="cmd-letter ${free ? "is-free" : ""}"
                >${free ? "∗" : this.requiredLetter.toUpperCase()}</span
              >
            </div>
            <div class="cmd-cell cmd-clock">
              <ac-shot-clock .controller=${c}></ac-shot-clock>
            </div>
            <div class="cmd-cell cmd-right">
              <span class="ac-eyebrow">banned</span>
              ${this.bannedLetter
                ? html`<span class="cmd-banned ${this.humanExempt ? "is-exempt" : ""}"
                    >${this.bannedLetter.toUpperCase()}</span
                  >`
                : html`<span class="cmd-banned is-none">—</span>`}
              ${this.humanExempt
                ? html`<span
                    class="cmd-exempt"
                    title="You're in last place — the banned letter won't tax you."
                    >EXEMPT</span
                  >`
                : nothing}
              ${this.personalBans.length
                ? html`<span
                    class="cmd-personal"
                    title="Your personal banned letter${this.personalBans.length > 1
                      ? "s"
                      : ""} — using ${this.personalBans.length > 1
                      ? "any of these"
                      : "this letter"} taxes your word to zero."
                    >YOURS: ${this.personalBans.map((l) => l.toUpperCase()).join(" ")}</span
                  >`
                : nothing}
            </div>
          </section>

          <section class="spotlight">
            <span class="spot-era">ERA ${this.era} · ROUND ${this.roundInEra}/${eraInterval}</span>
            <span class="spot-turn ${this.isHumanTurn ? "is-you" : ""}">
              ${this.isHumanTurn ? "YOUR TURN" : html`${this.currentName} is playing…`}
            </span>
          </section>

          <ac-score-replay .controller=${c}></ac-score-replay>

          <ac-word-entry .controller=${c}></ac-word-entry>

          <section class="feed">
            <span class="ac-eyebrow">recent words</span>
            <ac-recent-words .controller=${c}></ac-recent-words>
          </section>

          <ac-engine-bay
            class="mine"
            label="YOUR ENGINE"
            .cards=${this.humanBay}
            .slots=${this.humanSlots}
          ></ac-engine-bay>

          ${this.opponents.length
            ? html`<section class="foes">
                ${this.opponents.map(
                  (p) => html`
                    <div class="foe" style="--accent:${playerAccentVar(p.accentIndex)};">
                      <ac-engine-bay
                        mini
                        label=${p.name}
                        .cards=${p.bay}
                        .slots=${p.slots}
                      ></ac-engine-bay>
                    </div>
                  `,
                )}
              </section>`
            : nothing}
        </main>

        <aside class="rail">
          <div class="ac-panel rail-panel">
            <span class="ac-eyebrow">standings</span>
            <ac-leaderboard .controller=${c}></ac-leaderboard>
          </div>
        </aside>

        <div class="lb-strip">
          <ac-leaderboard strip .controller=${c}></ac-leaderboard>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-hud": AcHud;
  }
}
