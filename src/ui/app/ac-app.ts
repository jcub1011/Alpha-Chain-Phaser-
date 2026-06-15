/*
 * <ac-app> — the root. Owns the GameController, routes screens by phase, and
 * runs the single game-loop rAF (phase-gated, dt-clamped). The lobby is shown
 * when no match is live; during a match the HUD is always mounted with the
 * countdown / intermission / game-over surfaces layered on top.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Dictionary } from "../../game/dictionary";
import type { AlphaChainSettings, GamePhase } from "../../game/types";
import { LocalController } from "../../net/localController";
import { KnockBoxController } from "../../net/knockBoxController";
import { detectLaunch } from "../../net/launch";
import type { GameController } from "../../net/controller";
import { fx } from "../fx/fx";
import { AcElement } from "./AcElement";

// Side-effect imports register the custom elements used in the template.
import "../views/ac-lobby";
import "../views/ac-net-lobby";
import "../views/ac-hud";
import "../views/ac-countdown";
import "../views/ac-intermission";
import "../views/ac-game-over";
import "../views/ac-sandbox";

/** Largest sane per-frame step — protects the shot clock after a tab was hidden. */
const MAX_DT = 0.05;

@customElement("ac-app")
export class AcApp extends AcElement {
  @property({ attribute: false }) dict?: Dictionary;
  @property({ attribute: false }) settings!: AlphaChainSettings;

  @state() private controller?: GameController;
  @state() private phase: GamePhase = "Setup";
  @state() private screen: "lobby" | "netlobby" | "match" = "lobby";

  /** The multiplayer controller, when launched for the KnockBox network. */
  private net?: KnockBoxController;

  private raf = 0;
  private last = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    this.stopLoop();
    this.controller?.destroy();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Once the dictionary lands, set up the multiplayer controller if we were
    // launched for the KnockBox network (platform ticket or ?kbLocal=tab).
    if ((changed.has("dict") || changed.has("settings")) && this.dict && !this.net) {
      if (detectLaunch() !== "solo") this.setupNet();
    }
  }

  /** Create the networked controller once the KnockBox plugin is attached. */
  private setupNet(retries = 20): void {
    const peer = fx.knockbox();
    if (!peer) {
      if (retries > 0) window.setTimeout(() => this.setupNet(retries - 1), 60);
      return;
    }
    const net = new KnockBoxController(peer, this.dict!);
    this.net = net;
    this.controller = net;
    this.screen = "netlobby";
    this.listen(net.events, "phaseChanged", (p) => {
      this.phase = p;
      if (p !== "Setup") this.screen = "match";
    });
    this.startLoop();
    this.requestUpdate();
  }

  private onNetStart = (e: CustomEvent<AlphaChainSettings>): void => {
    this.net?.startMatch(e.detail);
  };

  // Debug-only, undocumented: Esc freezes/unfreezes every timer so the UI can be
  // inspected mid-match. Solo-only — gated on LocalController so it can never
  // reach public/networked play.
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.screen !== "match" || !(this.controller instanceof LocalController)) return;
    e.preventDefault();
    this.controller.togglePause();
    this.requestUpdate();
  };

  private onStart = (e: CustomEvent<AlphaChainSettings>): void => {
    this.settings = e.detail;
    this.controller?.destroy();
    this.clearSubs();

    const controller = new LocalController(this.settings, this.dict!);
    this.controller = controller;
    this.phase = "Setup";
    this.screen = "match";
    this.listen(controller.events, "phaseChanged", (p) => (this.phase = p));
    controller.start();
    this.startLoop();
  };

  private onReturnToLobby = (): void => {
    // Networked play returns to the multiplayer lobby; solo tears the controller down.
    if (this.net) {
      this.screen = "netlobby";
      this.phase = "Setup";
      return;
    }
    this.stopLoop();
    this.controller?.destroy();
    this.clearSubs();
    this.controller = undefined;
    this.screen = "lobby";
    this.phase = "Setup";
  };

  // ── Game loop ──────────────────────────────────────────────────────────────
  private startLoop(): void {
    this.stopLoop();
    this.last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min((now - this.last) / 1000, MAX_DT);
      this.last = now;
      // tick() is internally gated to Countdown/Round; harmless otherwise.
      if (this.controller && this.phase !== "GameOver") this.controller.tick(dt);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Dev "Testing Bay" — reached with ?sandbox, bypassing the match shell. */
  private get sandbox(): boolean {
    return new URLSearchParams(location.search).has("sandbox");
  }

  // ── Render ───────────────────────────────────────────────────────────────
  override render(): TemplateResult {
    if (this.sandbox) return html`<ac-sandbox></ac-sandbox>`;
    if (this.screen === "netlobby" && this.net) {
      return html`<ac-net-lobby .controller=${this.net} @ac-net-start=${this.onNetStart}></ac-net-lobby>`;
    }
    if (this.screen === "lobby" || !this.controller) {
      return html`<ac-lobby .settings=${this.settings} @ac-start=${this.onStart}></ac-lobby>`;
    }
    const c = this.controller;
    const paused = c instanceof LocalController && c.paused;
    return html`
      <ac-hud .controller=${c}></ac-hud>
      ${this.phase === "Countdown"
        ? html`<ac-countdown .controller=${c}></ac-countdown>`
        : nothing}
      ${this.phase === "Intermission"
        ? html`<ac-intermission .controller=${c}></ac-intermission>`
        : nothing}
      ${this.phase === "GameOver"
        ? html`<ac-game-over .controller=${c} @ac-return=${this.onReturnToLobby}></ac-game-over>`
        : nothing}
      ${paused
        ? html`<div
            style="position:fixed;top:12px;right:12px;z-index:9999;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none;"
          >
            ⏸ PAUSED
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ac-app": AcApp;
  }
}
