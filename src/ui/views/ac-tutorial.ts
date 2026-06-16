/*
 * <ac-tutorial> — the scripted tutorial overlay (Shiritori / Engine / Tax). Shown
 * during the top-level "Tutorial" phase (Shiritori, before the first round) and
 * over the intermission during the "tutorial" sub-phase (Engine before optimize,
 * Tax before the sniper ban). The dwell is host-authoritative; this view reads the
 * synced sub-timer for its progress ring and only the host/solo player may SKIP.
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
      "If the shot clock runs out, your turn is skipped.",
    ],
  },
  engine: {
    eyebrow: "how to play · your engine",
    title: "Your engine scores left → right",
    lines: [
      "Engine cards are evaluated from left to right.",
      "Try to keep adds to the left and multipliers to the right.",
    ],
  },
  tax: {
    eyebrow: "how to play · the ban",
    title: "Mind the banned letter",
    lines: [
      "Each era, the last-place player bans one letter.",
      "Any word containing the banned letter scores nothing that era…",
      "…except the player in last place, who is exempt from the ban.",
    ],
  },
};

@customElement("ac-tutorial")
export class AcTutorial extends AcElement {
  @property({ attribute: false }) controller!: GameController;

  override willUpdate(changed: PropertyValues): void {
    // The FSM owns the authoritative dwell; re-render the progress ring whenever
    // the synced sub-timer ticks (per frame, never broadcast over the network).
    if (changed.has("controller") && this.controller) {
      this.clearSubs();
      this.listen(this.controller.match.events, "subTimerTick", () => this.requestUpdate());
    }
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
