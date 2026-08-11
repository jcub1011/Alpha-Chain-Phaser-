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
import { ServerController } from "../../net/serverController";
import type { LaunchMode } from "../../net/launch";
import type { GameController } from "../../net/controller";
import { createLogger } from "../../log";
import { fx } from "../fx/fx";
import { AcElement } from "./AcElement";

const log = createLogger("app");

// Side-effect imports register the custom elements used in the template.
import "../views/ac-lobby";
import "../views/ac-net-lobby";
import "../views/ac-hud";
import "../views/ac-countdown";
import "../views/ac-intermission";
import "../views/ac-tutorial";
import "../views/ac-game-over";
import "../views/ac-sandbox";
import { setCardDisplayMode } from "./cardMode";

/** Largest sane per-frame step — protects the shot clock after a tab was hidden. */
const MAX_DT = 0.05;

@customElement("ac-app")
export class AcApp extends AcElement {
  /** The full 386k lexicon. Word validation and Classic bot word-search both read this
   *  one, in either game mode — see `commonDict` for why they aren't tier-switched. */
  @property({ attribute: false }) dict?: Dictionary;
  /** The Reduced (~9k common-word) lexicon, Picker's default Offer pool. A separate
   *  property rather than a tier map on `dict` because the two are not interchangeable:
   *  Reduced is only ever an Offer *source*, while legality stays anchored to the full
   *  list in both modes (Reduced is not a subset of it). Both load at boot (main.ts). */
  @property({ attribute: false }) commonDict?: Dictionary;
  @property({ attribute: false }) settings!: AlphaChainSettings;
  /** How the game was launched — resolved once at boot (main.ts), never re-derived
   *  here, because the KnockBox plugin scrubs the ticket from location.hash on start. */
  @property({ attribute: false }) launchMode: LaunchMode = "solo";

  @state() private controller?: GameController;
  @state() private phase: GamePhase = "Setup";
  @state() private screen: "lobby" | "netlobby" | "match" = "lobby";
  /** Set when a networked session ends terminally (socket closed for good). */
  @state() private sessionEnded?: string;

  /** The multiplayer controller, when launched for the KnockBox network. */
  private net?: ServerController;

  private raf = 0;
  private last = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    log.debug(`<ac-app> connected (launch=${this.launchMode})`);
    window.addEventListener("keydown", this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    this.stopLoop();
    this.controller?.destroy();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // A networked launch must NEVER show the solo bot lobby. As soon as we know the
    // mode is networked, switch to the multiplayer surface (which shows a connecting
    // state until the peer attaches) and wire up the controller. Server-authoritative
    // play needs no client dictionary, so we do NOT wait on `dict` here (it's only
    // fetched for solo / the Testing Bay).
    if (changed.has("launchMode") && this.launchMode !== "solo") {
      if (this.screen === "lobby") this.screen = "netlobby";
      if (!this.net) this.setupNet();
    }
    // Keep every card face on the mode the match is actually playing. Done here rather than at the
    // two controller-construction sites because a networked match learns its mode from a server
    // push AFTER construction, and a guest's lobby mode can change before the match starts. The
    // setter no-ops when unchanged, so running it on every update costs nothing.
    if (this.controller) setCardDisplayMode(this.controller.match.effectiveMode);
  }

  /** Create the networked controller once the KnockBox plugin is attached. The peer
   *  appears a few frames into Phaser's boot, so we poll briefly. If it never shows
   *  we surface the session-ended error rather than falling back to the solo lobby. */
  private setupNet(retries = 50): void {
    if (this.net) return;
    const peer = fx.knockbox();
    if (!peer) {
      if (retries > 0) {
        window.setTimeout(() => this.setupNet(retries - 1), 60);
      } else {
        log.error("KnockBox peer never attached; giving up after retries");
        this.sessionEnded = "Couldn't connect to the lobby. Please reload to try again.";
      }
      return;
    }
    log.info("KnockBox peer attached; creating networked controller");
    // Server-authoritative: the rules run in the server authority module, so the client
    // controller needs no dictionary (the server validates words via kb.words).
    const net = new ServerController(peer);
    this.net = net;
    this.controller = net;
    this.screen = "netlobby";
    this.listen(net.events, "phaseChanged", (p) => {
      this.phase = p;
      if (p !== "Setup") this.screen = "match";
    });
    // Intermission sub-phase / tutorial flips don't change `phase`; re-render so
    // the right overlay (optimize vs. tutorial vs. sniper ban) mounts.
    this.listen(net.events, "subPhaseChanged", () => this.requestUpdate());
    net.onSessionEnded((reason) => {
      this.sessionEnded = reason;
      this.stopLoop();
    });
    this.startLoop();
    this.requestUpdate();
  }

  private onNetStart = (e: CustomEvent<AlphaChainSettings>): void => {
    log.info("owner requested match start");
    // Keep ac-app's settings in sync (mirrors solo onStart) so the multiplayer
    // lobby re-seeds with the owner's choices when they return after a match.
    this.settings = e.detail;
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
    log.info("starting solo match from lobby");
    this.settings = e.detail;
    this.controller?.destroy();
    this.clearSubs();

    const controller = new LocalController(this.settings, this.dict!, this.commonDict);
    this.controller = controller;
    this.phase = "Setup";
    this.screen = "match";
    this.listen(controller.events, "phaseChanged", (p) => (this.phase = p));
    this.listen(controller.events, "subPhaseChanged", () => this.requestUpdate());
    controller.start();
    this.startLoop();
  };

  private onReturnToLobby = (): void => {
    log.info(`returning to lobby (${this.net ? "networked" : "solo"})`);
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
      try {
        // tick() is internally gated to Countdown/Round; harmless otherwise.
        if (this.controller && this.phase !== "GameOver") this.controller.tick(dt);
      } catch (err) {
        // A thrown frame must never kill the loop — on the host that would freeze the
        // game permanently (the rAF re-arm below would be skipped). Log and keep ticking;
        // the error reaches the KnockBox server log so the root cause stays visible.
        log.error(`tick failed: ${String(err)}`, err);
      } finally {
        this.raf = requestAnimationFrame(step);
      }
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

  private onSessionEndedDismiss = (): void => {
    this.sessionEnded = undefined;
    this.screen = "netlobby";
    this.phase = "Setup";
  };

  // ── Render ───────────────────────────────────────────────────────────────
  override render(): TemplateResult {
    if (this.sandbox) return html`<ac-sandbox .dict=${this.dict}></ac-sandbox>`;
    if (this.sessionEnded) {
      return html`
        <div class="overlay session-ended">
          <div class="se-card ac-panel">
            <span class="ac-eyebrow">multiplayer</span>
            <h2 class="se-title">Session ended</h2>
            <p class="se-msg">${this.sessionEnded}</p>
            <button class="ac-btn" @click=${this.onSessionEndedDismiss}>BACK TO LOBBY</button>
          </div>
        </div>
      `;
    }
    // Networked launch (platform / local-tab): the multiplayer lobby, or a connecting
    // placeholder until the peer attaches. Never the solo bot lobby.
    if (this.launchMode !== "solo" && this.screen !== "match") {
      return this.net
        ? html`<ac-net-lobby
            .controller=${this.net}
            .settings=${this.settings}
            @ac-net-start=${this.onNetStart}
          ></ac-net-lobby>`
        : html`
            <div class="overlay session-ended">
              <div class="se-card ac-panel">
                <span class="ac-eyebrow">multiplayer</span>
                <h2 class="se-title">Connecting…</h2>
                <p class="se-msg">Joining the lobby.</p>
              </div>
            </div>
          `;
    }
    // Solo launch: the bot lobby until a match is running.
    if (this.screen === "lobby" || !this.controller) {
      return html`<ac-lobby .settings=${this.settings} @ac-start=${this.onStart}></ac-lobby>`;
    }
    const c = this.controller;
    const paused = c instanceof LocalController && c.paused;
    const tutorialUp =
      this.phase === "Tutorial" ||
      (this.phase === "Intermission" && c.match.state.intermissionPhase === "tutorial");
    return html`
      <ac-hud .controller=${c}></ac-hud>
      ${this.phase === "Countdown" ? html`<ac-countdown .controller=${c}></ac-countdown>` : nothing}
      ${this.phase === "Intermission"
        ? html`<ac-intermission .controller=${c}></ac-intermission>`
        : nothing}
      ${tutorialUp ? html`<ac-tutorial .controller=${c}></ac-tutorial>` : nothing}
      ${this.phase === "GameOver"
        ? html`<ac-game-over .controller=${c} @ac-return=${this.onReturnToLobby}></ac-game-over>`
        : nothing}
      ${paused
        ? html`<div
            style="position:fixed;top:12px;right:12px;z-index:9999;padding:4px 10px;border-radius:6px;background:rgb(4,6,14);color:#fff;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none;"
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
