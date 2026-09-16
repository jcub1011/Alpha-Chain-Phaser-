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
import { activeBannedLetters } from "../../game/settings";
import { GameMode } from "../../game/types";
import type { PlayerState } from "../../game/types";
import { getCard } from "../../game/cards/library";
import { buildMagnifier } from "../../game/cards/magnifier";
import { describeCardLive } from "../../game/cards/liveText";
import type { RoomServices } from "../../game/cards/roomServices";
import { scoreWord } from "../../game/scoring";
import type { FanCard } from "../components/ac-card-fan";
import { playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

import "../components/ac-shot-clock";
import "../components/ac-word-entry";
import "../components/ac-word-builder";
import "../components/ac-leaderboard";
import "../components/ac-recent-words";
import "../components/ac-score-replay";
import "../components/ac-engine-bay";

@customElement("ac-hud")
export class AcHud extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  @state() private requiredLetter = "";
  @state() private bannedLetters: string[] = [];
  @state() private era = 1;
  @state() private roundInEra = 0;
  @state() private currentName = "";
  @state() private isHumanTurn = false;
  /** Survival: the human has been eliminated and is watching the rest play out. */
  @state() private humanEliminated = false;
  @state() private humanExempt = false;
  @state() private personalBans: { letter: string; cardName: string }[] = [];
  @state() private humanBay: FanCard[] = [];
  /** Word Builder: the word currently staged on the rack, if any. Drives the projection below. */
  @state() private previewWord: string | null = null;
  @state() private humanSlots = 3;
  @state() private opponents: PlayerState[] = [];
  /** Resting live faces per opponent id (see refresh — never match state). */
  @state() private foeBays: Map<string, FanCard[]> = new Map();

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const refresh = (): void => this.refresh();
      // A resolved turn leaves nothing staged: drop the projection, then re-derive
      // the bays once, so last turn's highlights never linger into the next turn
      // (or the game-over screen) — and each event refreshes exactly once.
      const onSettled = (): void => {
        if (this.previewWord !== null) this.previewWord = null;
        this.refresh();
      };
      this.listen(e, "submission", onSettled);
      this.listen(e, "timeout", onSettled);
      this.listen(e, "phaseChanged", onSettled);
      this.listen(e, "turnArmed", refresh);
      this.listen(e, "intermission", refresh);
      this.refresh();
    }
  }

  private refresh(): void {
    const m = this.controller.match;
    const s = m.state;
    const human = this.controller.humanId;
    this.requiredLetter = s.requiredLetter;
    // Under Accumulate every past ban stays in force — the rail shows the whole set.
    this.bannedLetters = activeBannedLetters(
      s.settings.banRepeatRule,
      s.bannedLetter,
      s.bannedLetterHistory,
    );
    this.era = s.era;
    this.roundInEra = s.roundInEra;
    const cur = m.current;
    this.currentName = cur?.name ?? "";
    this.isHumanTurn = s.phase === "Round" && cur?.id === human;
    const me = s.players.find((p) => p.id === human);
    // Survival's only real consequence, and until now the only sign of it was a small OUT tag
    // on the leaderboard — from the stage it just looked like your turn never came round again.
    this.humanEliminated = !!me?.eliminated;
    this.humanBay = me ? this.projectBayLive(me, true) : [];
    this.humanSlots = me?.slots ?? 3;
    // Sort opponents by their (stable) accent index for display, not by array
    // order: the host reshuffles `players` every era for turn order, which would
    // otherwise make the opponent tiles jump seats between eras.
    this.opponents = s.players
      .filter((p) => p.id !== human)
      .sort((a, b) => a.accentIndex - b.accentIndex);
    // Opponent bays render resting live faces (their streak/guards ride the
    // snapshot, so even mini cards show accurate magnitudes). Kept in a side
    // map — never written back onto the match state (mirrors may be frozen).
    this.foeBays = new Map(this.opponents.map((p) => [p.id, this.projectBayLive(p, false)]));
    // The last-place player is exempt from the banned-letter tax (they picked
    // it). Surface it so keeping points on a banned word never reads as a bug.
    // Under Accumulate the exemption covers every accumulated ban.
    this.humanExempt = !!me && this.bannedLetters.length > 0 && m.isExempt(me);
    this.personalBans = me ? m.personalBansFor(me.id) : [];
  }

  /**
   * A player's bay with live faces (`describeCardLive` per slot: glass
   * magnification, bay-size magnitudes, streak, guard badges, rolled bans).
   *
   * When `withPreview` and a word is staged/typed, each card ALSO projects the
   * exact step outcome (`scoreWord` with a read-only Crescendo stub — a preview
   * that ran on every keystroke must never touch room state), which both lights
   * the card and replaces its chip with the accurate fired magnitude.
   *
   * THE NUMBER IS DISCARDED ON PURPOSE. Only `steps[].triggered/valueText` are
   * read — showing the projected total would turn evaluation into a lookup.
   *
   * Called WITHOUT `effects` / `clock`, and with a `services` stub that only
   * implements `crescendoStreak.get()` — card hooks that mutate (rescueClock,
   * guard consumes, ban rolls, siphons) can never fire from it.
   */
  private projectBayLive(me: PlayerState, withPreview: boolean): FanCard[] {
    const m = this.controller.match;
    const mode = m.effectiveMode;
    const bay = me.bay;
    const s = m.state;
    const resolved = bay.map((slot) => getCard(slot.id, mode));
    const reg = buildMagnifier(resolved);
    const live = m.liveStateFor(me.id);
    const banByCard = new Map(m.personalBansFor(me.id).map((b) => [b.cardName, b.letter] as const));
    const bayIds = bay.map((slot) => slot.id);
    const word = withPreview ? this.previewWord : null;
    // Index-aligned to the bay: both flow from the same player state, the same contract
    // <ac-score-replay> relies on.
    // The preview is service-free EXCEPT a read-only Crescendo stub: Crescendo's fold
    // reads services.crescendoStreak, so without it a streaking word never lights.
    // The stub only implements get() (no guards/effects/clock), so it can never
    // consume charges or mutate room state on a keystroke.
    const previewServices = word
      ? ({ crescendoStreak: { get: () => live.streak } } as unknown as RoomServices)
      : undefined;
    const previewPlayer = word ? ({ id: me.id } as PlayerState) : undefined;
    const fired = word
      ? scoreWord(word, bay, {
          mode,
          prevWordLength: m.lastWordLength,
          clockRemaining: s.clockRemaining,
          clockTotal: s.clockTotal,
          taxed: false,
          era: s.era,
          slots: me.slots,
          history: s.history,
          services: previewServices,
          player: previewPlayer,
        }).steps
      : undefined;
    return bay.map((c, i) => ({
      ...c,
      triggered: fired?.[i]?.triggered === true,
      live: describeCardLive(c.id, mode, {
        mode,
        bayIds,
        index: i,
        magnification: reg.getMagnification(i),
        slots: me.slots,
        streak: live.streak,
        wildcardAvailable: live.wildcardAvailable,
        prismAvailable: live.prismAvailable,
        winnowerAvailable: live.winnowerAvailable,
        personalBan: banByCard.get(getCard(c.id, mode)?.name ?? ""),
        previewValueText: fired?.[i]?.valueText,
        previewTriggered: fired?.[i]?.triggered,
      }),
    }));
  }

  /** <ac-word-builder> publishes the staged word; re-derive the bay projection from it. */
  private onOfferPreview = (e: CustomEvent<{ word: string | null }>): void => {
    this.previewWord = e.detail.word || null;
    this.refresh();
  };

  /** Group personal bans by their source card so duplicate ban-rolling cards
   *  (e.g. two Toll Booths) share one card pill rather than cluttering the rail
   *  with a pill per glyph. Preserves first-appearance order; dedupes identical
   *  letters within a group. */
  private groupedBans(): { cardName: string; letters: string[] }[] {
    const groups: { cardName: string; letters: string[] }[] = [];
    const byName = new Map<string, string[]>();
    for (const b of this.personalBans) {
      let letters = byName.get(b.cardName);
      if (!letters) {
        letters = [];
        byName.set(b.cardName, letters);
        groups.push({ cardName: b.cardName, letters });
      }
      if (!letters.includes(b.letter)) letters.push(b.letter);
    }
    return groups;
  }

  override render(): TemplateResult {
    const c = this.controller;
    const eraInterval = c.match.state.settings.eraInterval;
    const eraCount = c.match.state.settings.eraCount;
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
              ${this.bannedLetters.length
                ? html`<div class="cmd-personal-letters">
                    ${this.bannedLetters.map(
                      (l) =>
                        html`<span class="cmd-banned ${this.humanExempt ? "is-exempt" : ""}"
                          >${l.toUpperCase()}</span
                        >`,
                    )}
                  </div>`
                : html`<span class="cmd-banned is-none">—</span>`}
              ${this.humanExempt
                ? html`<span
                    class="cmd-exempt"
                    title="You're in last place — the banned letter won't tax you."
                    >EXEMPT</span
                  >`
                : nothing}
              ${this.personalBans.length
                ? html`<span class="ac-eyebrow"
                      >${this.personalBans.length > 1 ? "your bans" : "your ban"}</span
                    >
                    <div class="cmd-personal-row">
                      ${this.groupedBans().map(
                        (g) =>
                          html`<div
                            class="cmd-personal-item"
                            title="Personal banned letter${g.letters.length > 1
                              ? "s"
                              : ""} from ${g.cardName} — using ${g.letters.length > 1
                              ? "any of them"
                              : "it"} taxes your word to zero."
                          >
                            <div class="cmd-personal-letters">
                              ${g.letters.map(
                                (l) =>
                                  html`<span class="cmd-banned is-personal"
                                    >${l.toUpperCase()}</span
                                  >`,
                              )}
                            </div>
                            <span class="cmd-personal-card">${g.cardName}</span>
                          </div>`,
                      )}
                    </div>`
                : nothing}
            </div>
          </section>

          <section class="spotlight">
            ${this.humanEliminated
              ? html`<span class="spot-turn is-out">YOU'RE OUT</span>
                  <span class="spot-sub">${this.currentName} is playing…</span>`
              : html`<span class="spot-turn ${this.isHumanTurn ? "is-you" : ""}">
                  ${this.isHumanTurn ? "YOUR TURN" : html`${this.currentName} is playing…`}
                </span>`}
          </section>

          <ac-engine-bay
            class="mine"
            label="YOUR ENGINE"
            .cards=${this.humanBay}
            .slots=${this.humanSlots}
          ></ac-engine-bay>

          <!-- Mobile: the recent-words feed sits above the input (the desktop copy
               lives in the rail under the standings). One shows at a time via CSS. -->
          <section class="feed feed--mobile">
            <span class="ac-eyebrow">recent words</span>
            <ac-recent-words .controller=${c}></ac-recent-words>
          </section>

          <!-- The single input-surface mount. Word Builder is the ONLY Picker surface: mounted
               unconditionally rather than keyed on rack.length, so Setup/Countdown shows the empty
               builder instead of swapping a placeholder out from under the player at round start. -->
          ${c.match.state.settings.gameMode === GameMode.Picker
            ? html`<ac-word-builder
                .controller=${c}
                @ac-offer-preview=${this.onOfferPreview}
              ></ac-word-builder>`
            : html`<ac-word-entry
                .controller=${c}
                @ac-offer-preview=${this.onOfferPreview}
              ></ac-word-entry>`}

          <ac-score-replay .controller=${c}></ac-score-replay>

          ${this.opponents.length
            ? html`<section class="foes">
                ${this.opponents.map(
                  (p) => html`
                    <div class="foe" style="--accent:${playerAccentVar(p.accentIndex)};">
                      <ac-engine-bay
                        mini
                        label=${p.name}
                        .cards=${this.foeBays.get(p.id) ?? p.bay}
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
            <span class="lb-era"
              >ERA ${this.era}/${eraCount} · ROUND ${this.roundInEra}/${eraInterval}</span
            >
            <span class="ac-eyebrow">standings</span>
            <ac-leaderboard .controller=${c}></ac-leaderboard>
          </div>
          <!-- Desktop: recent words as a vertical list under the standings. -->
          <section class="feed feed--rail ac-panel">
            <span class="ac-eyebrow">recent words</span>
            <ac-recent-words vertical .controller=${c}></ac-recent-words>
          </section>
        </aside>

        <div class="lb-strip">
          <span class="lb-era"
            >ERA ${this.era}/${eraCount} · ROUND ${this.roundInEra}/${eraInterval}</span
          >
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
