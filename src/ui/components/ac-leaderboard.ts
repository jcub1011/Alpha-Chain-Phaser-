/*
 * <ac-leaderboard> — live standings. Re-renders only on low-frequency events
 * (turn changes, submissions, timeouts). The active player's row glows; the
 * human's row is bordered; a score change flashes the row, bumps its score, and
 * ghosts the signed delta over it (contained within the row so the list's scroll
 * never clips it) — on the submitter plus any off-turn siphons/drains it triggers.
 */

import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameController } from "../../net/controller";
import type { PlayerState, Submission } from "../../game/types";
import { fmtScore, playerAccentVar } from "../app/util";
import { AcElement } from "../app/AcElement";

/** A snapshot of the fields a row renders — captured at refresh time so the
 *  displayed score/order can't track live `PlayerState` mutations (a submission
 *  credits `player.score` immediately, before its engine replay finishes). */
type LbRow = Pick<PlayerState, "id" | "name" | "accentIndex" | "score" | "eliminated">;

@customElement("ac-leaderboard")
export class AcLeaderboard extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  @property({ type: Boolean, reflect: true }) strip = false;

  @state() private rows: LbRow[] = [];
  @state() private activeId = "";
  @state() private pops: { id: string; amount: number; key: number }[] = [];

  /** Window listener for the deferred score reveal (engine-replay completion). */
  private onRevealed?: (e: Event) => void;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      const e = this.controller.events;
      const setActive = (): void => {
        this.activeId = this.controller.match.current?.id ?? "";
      };
      const refresh = (): void => {
        // Snapshot (not live refs) so an in-between re-render — e.g. setActive on
        // turnArmed, which fires right after a submission credits the score — can't
        // surface the new score/order before the engine replay reveals it.
        this.rows = this.controller.match.standings().map((p) => ({
          id: p.id,
          name: p.name,
          accentIndex: p.accentIndex,
          score: p.score,
          eliminated: p.eliminated,
        }));
        setActive();
      };
      // Move only the active-row glow on turn/timeout changes; do NOT pull fresh
      // standings here — a score change must stay hidden until its engine replay
      // finishes (turnArmed for the next player fires right after a submission).
      this.listen(e, "turnArmed", setActive);
      this.listen(e, "timeout", setActive);
      this.listen(e, "phaseChanged", refresh); // safety net across phase boundaries

      // The score (and +pop) reveal is driven by <ac-score-replay> finishing its
      // walk, not by the raw `submission` event — so the leaderboard never spoils
      // the result before the animation lands.
      if (this.onRevealed) window.removeEventListener("ac-score-revealed", this.onRevealed);
      this.onRevealed = (ev: Event): void => {
        const sub = (ev as CustomEvent<{ submission: Submission }>).detail?.submission;
        refresh();
        if (!sub) return;
        // A single word can move several players: the submitter's own score plus
        // any off-turn siphons/drains it triggers (Chrono Syphon, Tax Collector,
        // drains, …). Fold every signed delta per player so each changed row pops.
        const delta = new Map<string, number>();
        if (sub.score) delta.set(sub.playerId, sub.score);
        for (const eff of sub.effects ?? [])
          if (eff.amount) delta.set(eff.targetId, (delta.get(eff.targetId) ?? 0) + eff.amount);
        const base = sub.breakdown.seed + Date.now();
        this.pops = [...delta]
          .filter(([, amount]) => amount !== 0)
          .map(([id, amount], i) => ({ id, amount, key: base + i }));
      };
      window.addEventListener("ac-score-revealed", this.onRevealed);

      refresh();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.onRevealed) window.removeEventListener("ac-score-revealed", this.onRevealed);
  }

  override render(): TemplateResult {
    const human = this.controller?.humanId;
    return html`
      <ol class="lb">
        ${this.rows.map((p, rank) => {
          const accent = playerAccentVar(p.accentIndex);
          const isMe = p.id === human;
          const isActive = p.id === this.activeId;
          // At most one pop per row per reveal (deltas are folded per player).
          const pop = this.pops.find((q) => q.id === p.id);
          return html`
            <li
              class="lb-row ${isActive ? "is-active" : ""} ${isMe ? "is-me" : ""} ${p.eliminated
                ? "is-out"
                : ""} ${pop ? "is-pop" : ""} ${pop && pop.amount < 0 ? "is-pop-neg" : ""}"
              style="--accent:${accent};"
            >
              <span class="lb-rank">${rank + 1}</span>
              <span class="lb-name">${p.name}${isMe ? html`<i> you</i>` : nothing}</span>
              ${p.eliminated ? html`<span class="lb-tag">OUT</span>` : nothing}
              <span class="lb-score">${fmtScore(p.score)}</span>
              ${this.pops
                .filter((q) => q.id === p.id)
                .map(
                  (q) =>
                    html`<span
                      class="lb-pop ${q.amount < 0 ? "is-neg" : ""}"
                      @animationend=${() => (this.pops = this.pops.filter((x) => x.key !== q.key))}
                      >${q.amount > 0 ? "+" : ""}${fmtScore(q.amount)}</span
                    >`,
                )}
            </li>
          `;
        })}
      </ol>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-leaderboard": AcLeaderboard;
  }
}
