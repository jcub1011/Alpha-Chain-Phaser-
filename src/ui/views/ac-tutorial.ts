/*
 * <ac-tutorial> — the scripted tutorial overlay (Shiritori / Engine / Tax). Shown
 * during the top-level "Tutorial" phase (Shiritori, before the first round) and
 * over the intermission during the "tutorial" sub-phase (Engine before optimize,
 * Tax before the sniper ban). The dwell is host-authoritative; this view reads the
 * synced sub-timer for its progress ring and only the host/solo player may SKIP.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
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
      "No word may be repeated, and it must be a real word.",
      "Beat the shot clock — let it hit zero and your turn is lost.",
    ],
  },
  engine: {
    eyebrow: "how to play · your engine",
    title: "Your engine scores left → right",
    lines: [
      "Cards fold into the running total in order, one slot at a time.",
      "Additives add; multipliers multiply everything banked to their left.",
      "Order your bay so multipliers land after the points they should compound.",
    ],
  },
  tax: {
    eyebrow: "how to play · the tax",
    title: "Mind the banned letter",
    lines: [
      "Each era, the last-place player bans one letter as a zero-point tax.",
      "Any word containing the banned letter scores nothing that era…",
      "…except the player in last place, who is exempt from the tax.",
    ],
  },
};

@customElement("ac-tutorial")
export class AcTutorial extends AcElement {
  @property({ attribute: false }) controller!: GameController;
  /** Re-render tick for the progress ring (the FSM owns the real dwell). */
  @state() private refreshN = 0;

  private timer = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => (this.refreshN = (this.refreshN + 1) % 1000), 100);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** Only the host (or a solo player) may skip the shared dwell. */
  private get canSkip(): boolean {
    const c = this.controller as GameController & { isHost?: boolean };
    return "isHost" in c ? !!c.isHost : true;
  }

  private skip(): void {
    this.controller.match.skipTutorial();
  }

  override render(): TemplateResult {
    const s = this.controller.match.state;
    const kind = s.currentTutorial;
    if (!kind) return html`${nothing}`;
    const script = SCRIPTS[kind];
    const total = s.subTimerTotal || 1;
    const frac = Math.max(0, Math.min(1, s.subTimerRemaining / total));
    const secs = Math.ceil(s.subTimerRemaining);
    return html`
      <div class="overlay tutorial">
        <div class="tut-card ac-panel">
          <span class="ac-eyebrow">${script.eyebrow}</span>
          <h2 class="tut-title">${script.title}</h2>
          <ul class="tut-lines">
            ${script.lines.map((l) => html`<li>${l}</li>`)}
          </ul>
          <div class="tut-foot">
            <div class="tut-bar" role="progressbar" aria-valuenow=${secs}>
              <div class="tut-bar-fill" style="transform:scaleX(${frac})"></div>
            </div>
            <span class="tut-secs">${secs}s</span>
            ${this.canSkip
              ? html`<button class="ac-btn tut-skip" @click=${() => this.skip()}>SKIP</button>`
              : html`<span class="tut-wait">waiting for host…</span>`}
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
