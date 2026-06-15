/*
 * The live HUD — responsive. Layout regions come from computeGameLayout(): a
 * single vertical column on narrow/mobile screens, and a left-rail (standings) ·
 * center play column · right-rail (recent words) + bottom bay strip on desktop.
 * Everything is rebuilt from the layout on resize; all dynamic content is
 * re-derived from the authoritative match state, so a rebuild never loses data.
 *
 * Game-feel: a draining shot-clock ring, a score-replay walk across the engine
 * bay, floating score popups, a tax stamp, turn spotlights, and screen shake.
 */

import Phaser from "phaser";
import type { MatchController } from "../game/match";
import type { Submission } from "../game/types";
import type { GameController } from "../net/controller";
import { Anim, COLORS, CSS, FONTS, playerAccent, prefersReducedMotion } from "../theme";
import { Card } from "../ui/Card";
import { computeGameLayout, REGISTRY, type GameLayout } from "../ui/layout";
import { ShotClockRing } from "../ui/ShotClockRing";
import { WordInput } from "../ui/WordInput";
import { neonText, panel } from "../ui/widgets";

export class GameScene extends Phaser.Scene {
  private controller!: GameController;
  private get match(): MatchController {
    return this.controller.match;
  }

  private L!: GameLayout;
  private clock!: ShotClockRing;
  private clockX = 0;
  private clockY = 0;
  private wordInput!: WordInput;
  private reqLetter!: Phaser.GameObjects.Text;
  private reqLabel!: Phaser.GameObjects.Text;
  private turnLabel!: Phaser.GameObjects.Text;
  private headerEra!: Phaser.GameObjects.Text;
  private bannedChip!: Phaser.GameObjects.Container;
  private bannedText!: Phaser.GameObjects.Text;
  private leaderboard!: Phaser.GameObjects.Container;
  private feed!: Phaser.GameObjects.Container;
  private bayLayer!: Phaser.GameObjects.Container;
  private bayCards: Card[] = [];
  private overlay!: Phaser.GameObjects.Container;
  private unsubs: Array<() => void> = [];
  private resizeJob?: Phaser.Time.TimerEvent;

  constructor() {
    super("Game");
  }

  create(): void {
    this.controller = this.registry.get(REGISTRY.controller) as GameController;
    this.cameras.main.setBackgroundColor(COLORS.bg0);
    if (import.meta.env.DEV) (window as unknown as { __ac?: unknown }).__ac = this.controller;

    this.build();
    this.wireEvents();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once("shutdown", () => this.teardown());
    this.controller.start();
  }

  private onResize(): void {
    // Debounce: window drags fire many resize events.
    this.resizeJob?.remove();
    this.resizeJob = this.time.delayedCall(120, () => this.rebuild());
  }

  private rebuild(): void {
    this.wordInput?.destroy();
    this.children.removeAll(true);
    this.build();
    this.syncFromState();
  }

  private f(mult: number): number {
    return Math.max(10, Math.round(this.L.unit * mult));
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  private build(): void {
    const { width, height } = this.scale.gameSize;
    this.L = computeGameLayout(width, height);
    this.addBackdrop();
    this.buildHeader();
    this.buildCenter();
    this.buildLeftRail();
    this.buildRightRail();
    this.buildBay();
    this.buildOverlay();
    this.syncFromState();
  }

  private addBackdrop(): void {
    // Ambient corner glows so wide screens don't read as empty.
    const { w, h } = this.L;
    const glows: Array<[number, number, number]> = [
      [w * 0.04, h * 0.9, COLORS.cyan],
      [w * 0.96, h * 0.12, COLORS.magenta],
    ];
    for (const [x, y, c] of glows) {
      this.add.circle(x, y, Math.min(w, h) * 0.4, c, 0.05);
    }
  }

  private buildHeader(): void {
    const H = this.L.header;
    panel(this, 0, 0, H.w, H.h, { radius: 0, shadow: false, borderWidth: 0, fill: COLORS.bg1 });
    this.headerEra = neonText(this, this.f(1.5), H.cy, "", { size: this.f(1.5), color: CSS.ink }).setOrigin(0, 0.5);

    const chipW = this.f(8);
    const chipH = Math.min(H.h * 0.7, this.f(3.2));
    this.bannedChip = this.add.container(H.cx, H.cy);
    const g = this.add.graphics();
    g.fillStyle(COLORS.danger, 0.18);
    g.lineStyle(2, COLORS.danger, 0.8);
    g.fillRoundedRect(-chipW / 2, -chipH / 2, chipW, chipH, 12);
    g.strokeRoundedRect(-chipW / 2, -chipH / 2, chipW, chipH, 12);
    const cap = this.add.text(0, -chipH * 0.22, "BANNED", { fontFamily: FONTS.display, fontSize: `${this.f(0.7)}px`, color: CSS.danger }).setOrigin(0.5).setLetterSpacing(2);
    this.bannedText = this.add.text(0, chipH * 0.2, "—", { fontFamily: FONTS.mono, fontSize: `${this.f(1.4)}px`, color: CSS.danger, fontStyle: "bold" }).setOrigin(0.5);
    this.bannedChip.add([g, cap, this.bannedText]);

    neonText(this, H.w - this.f(1.5), H.cy, "YOU", { size: this.f(1.3), color: CSS.cyan, glow: CSS.cyan }).setOrigin(1, 0.5);
  }

  private buildCenter(): void {
    const C = this.L.center;
    // Anchor bottom-up so elements never collide on short screens: word input at
    // the bottom, turn label above it, and the clock sized to fill the remaining
    // top space with the required letter beside it.
    const iw = Math.min(C.w * 0.92, this.f(28));
    const ih = this.f(3);
    const inputY = C.y + C.h - ih / 2 - this.f(0.4);
    const turnY = inputY - ih / 2 - this.f(1.7);

    const spaceTop = C.y + this.f(0.5);
    const spaceBottom = turnY - this.f(1.4);
    const radius = Phaser.Math.Clamp(Math.round(Math.min(C.w * 0.22, (spaceBottom - spaceTop) / 2)), 34, 96);
    this.clockX = C.cx;
    this.clockY = (spaceTop + spaceBottom) / 2;

    const letterX = Math.max(C.x + this.f(2.5), this.clockX - radius - this.f(2));
    this.reqLabel = neonText(this, letterX, this.clockY - radius * 0.55, "START", { size: this.f(0.85), color: CSS.inkSoft, align: "center" })
      .setOrigin(0.5)
      .setLetterSpacing(1);
    this.reqLetter = this.add
      .text(letterX, this.clockY + this.f(0.4), "—", { fontFamily: FONTS.display, fontSize: `${Math.min(this.f(3), radius * 0.95)}px`, color: CSS.cyan, fontStyle: "bold" })
      .setOrigin(0.5)
      .setShadow(0, 0, CSS.cyan, 18, true, true);

    this.clock = new ShotClockRing(this, this.clockX, this.clockY, radius);

    this.turnLabel = neonText(this, C.cx, turnY, "", { size: this.f(1.5), color: CSS.ink, align: "center" })
      .setOrigin(0.5)
      .setLetterSpacing(2);

    this.wordInput = new WordInput(this, C.cx, inputY, iw, ih, (v) => this.onSubmit(v));
    this.wordInput.setVisible(false);
  }

  private buildLeftRail(): void {
    const R = this.L.leftRail;
    panel(this, R.x, R.y, R.w, R.h, { border: COLORS.cyan, borderAlpha: 0.3, fill: COLORS.bg1, fillAlpha: 0.6 });
    neonText(this, R.cx, R.y + this.f(1.1), "STANDINGS", { size: this.f(0.85), color: CSS.inkFaint, align: "center" }).setOrigin(0.5).setLetterSpacing(3);
    this.leaderboard = this.add.container(0, 0);
  }

  private buildRightRail(): void {
    const R = this.L.rightRail;
    panel(this, R.x, R.y, R.w, R.h, { border: COLORS.violet, borderAlpha: 0.3, fill: COLORS.bg1, fillAlpha: 0.6 });
    neonText(this, R.cx, R.y + this.f(1.1), "RECENT WORDS", { size: this.f(0.85), color: CSS.inkFaint, align: "center" }).setOrigin(0.5).setLetterSpacing(3);
    this.feed = this.add.container(0, 0);
  }

  private buildBay(): void {
    const B = this.L.bay;
    neonText(this, B.cx, B.y + this.f(0.7), "YOUR ENGINE BAY", { size: this.f(0.85), color: CSS.inkFaint, align: "center" }).setOrigin(0.5).setLetterSpacing(3);
    this.bayLayer = this.add.container(0, 0);
  }

  private buildOverlay(): void {
    this.overlay = this.add.container(0, 0).setDepth(100).setVisible(false);
  }

  // ── Sync display objects to current state (after build/rebuild) ─────────────
  private syncFromState(): void {
    const s = this.match.state;
    this.headerEra.setText(`ERA ${s.era}/${s.settings.eraCount}   R${s.roundInEra}`);
    this.bannedText.setText(s.bannedLetter ? s.bannedLetter.toUpperCase() : "—");
    this.bannedChip.setVisible(s.bannedLetter.length > 0);

    this.reqLetter.setText(s.requiredLetter ? s.requiredLetter.toUpperCase() : "★");
    this.reqLabel.setText(s.requiredLetter ? "STARTS WITH" : s.phase === "Round" ? "FREE PICK" : "START");
    this.clock.set(s.clockRemaining || s.clockTotal, s.clockTotal || s.settings.shotClockSeconds);

    const human = s.phase === "Round" && this.match.current?.id === this.controller.humanId;
    if (s.phase === "Round") {
      const p = this.match.current;
      if (p?.id === this.controller.humanId) this.turnLabel.setText("YOUR TURN").setColor(CSS.cyan);
      else if (p) this.turnLabel.setText(`${p.name.toUpperCase()} IS PLAYING`).setColor(Phaser.Display.Color.IntegerToColor(playerAccent(p.accentIndex)).rgba);
    } else {
      this.turnLabel.setText("");
    }
    this.wordInput.setVisible(human);
    if (human) this.wordInput.setBorderColor(CSS.cyan);

    this.rebuildLeaderboard();
    this.rebuildFeed();
    this.renderBay();

    if (s.phase === "Countdown") this.showCountdown(Math.ceil(s.clockTotal) || s.settings.preRoundCountdownSeconds);
    else this.hideOverlay();
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  private wireEvents(): void {
    const e = this.controller.events;
    this.unsubs.push(
      e.on("phaseChanged", (p) => this.onPhase(p)),
      e.on("countdownTick", (n) => this.showCountdown(n)),
      e.on("turnArmed", (t) => this.onTurnArmed(t)),
      e.on("clockTick", (r) => this.clock.set(r, this.match.state.clockTotal)),
      e.on("submission", ({ submission }) => this.onSubmission(submission)),
      e.on("rejected", ({ reason }) => this.onRejected(reason)),
      e.on("timeout", () => this.onTimeout()),
      e.on("intermission", () => this.onIntermission()),
      e.on("gameOver", () => this.scene.start("GameOver")),
    );
  }

  private onPhase(phase: string): void {
    const s = this.match.state;
    this.headerEra.setText(`ERA ${s.era}/${s.settings.eraCount}   R${s.roundInEra}`);
    this.bannedText.setText(s.bannedLetter ? s.bannedLetter.toUpperCase() : "—");
    this.bannedChip.setVisible(s.bannedLetter.length > 0);
    if (phase === "Round") this.hideOverlay();
  }

  private onTurnArmed(t: { playerIndex: number; requiredLetter: string; clockTotal: number }): void {
    this.hideOverlay();
    this.onPhase("Round");
    const player = this.match.state.players[t.playerIndex];
    const isHuman = player.id === this.controller.humanId;
    const accentCss = Phaser.Display.Color.IntegerToColor(playerAccent(player.accentIndex)).rgba;

    this.reqLetter.setText(t.requiredLetter ? t.requiredLetter.toUpperCase() : "★");
    this.reqLabel.setText(t.requiredLetter ? "STARTS WITH" : "FREE PICK");
    this.clock.set(t.clockTotal, t.clockTotal);
    this.renderBay();

    if (isHuman) {
      this.turnLabel.setText("YOUR TURN").setColor(CSS.cyan);
      this.wordInput.setVisible(true);
      this.wordInput.clear();
      this.wordInput.setBorderColor(CSS.cyan);
      this.wordInput.focus();
    } else {
      this.turnLabel.setText(`${player.name.toUpperCase()} IS PLAYING`).setColor(accentCss);
      this.wordInput.setVisible(false);
    }
    if (!prefersReducedMotion()) {
      this.tweens.add({ targets: this.turnLabel, scale: { from: 0.7, to: 1 }, duration: 260, ease: "Back.easeOut" });
    }
  }

  private onSubmit(value: string): void {
    const v = value.trim();
    if (v.length === 0) return;
    this.controller.submitWord(v);
  }

  private onSubmission(sub: Submission): void {
    if (sub.playerId === this.controller.humanId) this.wordInput.clear();
    this.rebuildLeaderboard();
    this.rebuildFeed();

    if (sub.playerId === this.controller.humanId && this.bayCards.length > 0) this.replayScore(sub);
    else this.floatScore(sub);

    if (sub.taxed) this.taxStamp();
    else if (sub.score >= 40) this.cameras.main.shake(220, 0.012);
  }

  private replayScore(sub: Submission): void {
    const stepMs = (this.match.state.settings.engineAnimationSeconds * 1000) / Math.max(1, sub.breakdown.steps.length);
    sub.breakdown.steps.forEach((step, i) => {
      this.time.delayedCall(i * stepMs, () => {
        const card = this.bayCards[i];
        if (!card) return;
        if (step.triggered) card.setTriggered(true);
        else card.setDimmed(true);
      });
    });
    this.time.delayedCall(sub.breakdown.steps.length * stepMs + 120, () => {
      this.bayCards.forEach((c) => {
        c.setTriggered(false);
        c.setDimmed(false);
      });
      this.floatScore(sub);
    });
  }

  private floatScore(sub: Submission): void {
    const txt = sub.taxed ? "TAXED · 0" : `+${sub.score}`;
    const color = sub.taxed ? CSS.danger : sub.score >= 40 ? CSS.mint : CSS.cyan;
    const big = sub.score >= 40;
    const t = this.add
      .text(this.clockX, this.clockY, txt, { fontFamily: FONTS.mono, fontSize: `${this.f(big ? 3.2 : 2.4)}px`, color, fontStyle: "bold" })
      .setOrigin(0.5)
      .setShadow(0, 0, color, 16, true, true)
      .setDepth(60);
    Anim.pop(this, t);
    Anim.floatUp(this, t, this.f(4), 1100);
  }

  private taxStamp(): void {
    const stamp = this.add
      .text(this.clockX, this.clockY, "TAXED", { fontFamily: FONTS.display, fontSize: `${this.f(4.5)}px`, color: CSS.danger, fontStyle: "bold" })
      .setOrigin(0.5)
      .setAngle(-12)
      .setAlpha(0)
      .setDepth(70)
      .setShadow(0, 0, CSS.danger, 22, true, true);
    this.tweens.add({ targets: stamp, scale: { from: 2.2, to: 1 }, alpha: { from: 0, to: 1 }, duration: 220, ease: "Back.easeOut" });
    this.tweens.add({ targets: stamp, alpha: 0, delay: 700, duration: 300, onComplete: () => stamp.destroy() });
    this.cameras.main.shake(180, 0.01);
  }

  private onRejected(reason: string): void {
    this.wordInput.shake();
    this.wordInput.setBorderColor(CSS.danger);
    const msg: Record<string, string> = {
      "not-a-word": "not in the dictionary",
      "already-used": "already played",
      "wrong-start-letter": `must start with “${this.match.state.requiredLetter.toUpperCase()}”`,
      "too-short": "too short",
    };
    const C = this.L.center;
    const t = neonText(this, C.cx, C.y + C.h * 0.74, msg[reason] ?? "invalid", { size: this.f(1.2), color: CSS.danger, align: "center", glow: CSS.danger }).setOrigin(0.5).setDepth(60);
    this.time.delayedCall(1400, () => t.destroy());
    this.time.delayedCall(700, () => this.wordInput.setBorderColor(CSS.cyan));
  }

  private onTimeout(): void {
    const t = neonText(this, this.clockX, this.clockY, "TIME!", { size: this.f(4), color: CSS.danger, align: "center", glow: CSS.danger }).setOrigin(0.5).setDepth(60);
    Anim.pop(this, t);
    this.time.delayedCall(900, () => t.destroy());
    this.cameras.main.shake(160, 0.008);
  }

  private onIntermission(): void {
    this.wordInput.setVisible(false);
    this.scene.launch("Intermission", { controller: this.controller });
  }

  // ── Renderers ─────────────────────────────────────────────────────────────
  private rebuildLeaderboard(): void {
    this.leaderboard.removeAll(true);
    const R = this.L.leftRail;
    const standings = this.match.standings();
    const top = R.y + this.f(2.4);
    const rowH = Math.min(this.f(2.4), (R.h - this.f(2.8)) / Math.max(1, standings.length));
    const pad = this.f(1.4);
    standings.forEach((p, i) => {
      const y = top + i * rowH + rowH / 2;
      const accent = playerAccent(p.accentIndex);
      const isCurrent = this.match.current?.id === p.id && this.match.state.phase === "Round";
      const dot = this.add.circle(R.x + pad, y, this.f(0.4), accent, 1);
      const name = this.add.text(R.x + pad + this.f(1.1), y, p.name + (p.id === this.controller.humanId ? " (you)" : ""), {
        fontFamily: FONTS.display,
        fontSize: `${this.f(1.05)}px`,
        color: isCurrent ? CSS.ink : CSS.inkSoft,
        fontStyle: isCurrent ? "bold" : "normal",
      }).setOrigin(0, 0.5);
      const score = this.add.text(R.x + R.w - pad, y, `${p.score}`, {
        fontFamily: FONTS.mono,
        fontSize: `${this.f(1.2)}px`,
        color: Phaser.Display.Color.IntegerToColor(accent).rgba,
        fontStyle: "bold",
      }).setOrigin(1, 0.5);
      this.leaderboard.add([dot, name, score]);
    });
  }

  private rebuildFeed(): void {
    this.feed.removeAll(true);
    const R = this.L.rightRail;
    const top = R.y + this.f(2.4);
    const rowH = this.f(1.9);
    const maxRows = Math.max(1, Math.floor((R.h - this.f(2.6)) / rowH));
    const pad = this.f(1.4);
    const recent = this.match.state.history.slice(-maxRows).reverse();
    recent.forEach((s, i) => {
      const y = top + i * rowH + rowH / 2;
      const accent = playerAccent(s.accentIndex);
      const dot = this.add.circle(R.x + pad, y, this.f(0.32), accent, 1);
      const word = this.add.text(R.x + pad + this.f(0.9), y, s.word, {
        fontFamily: FONTS.mono,
        fontSize: `${this.f(1.05)}px`,
        color: CSS.ink,
        fontStyle: "bold",
      }).setOrigin(0, 0.5);
      const score = this.add.text(R.x + R.w - pad, y, s.taxed ? "TAX" : `+${s.score}`, {
        fontFamily: FONTS.mono,
        fontSize: `${this.f(1)}px`,
        color: s.taxed ? CSS.danger : CSS.mint,
        fontStyle: "bold",
      }).setOrigin(1, 0.5);
      this.feed.add([dot, word, score]);
      if (i === 0) Anim.rise(this, word, 12, 240);
    });
  }

  private renderBay(): void {
    this.bayLayer.removeAll(true);
    this.bayCards = [];
    const B = this.L.bay;
    const bay = this.match.bayCards(this.controller.humanId);
    const rowY = B.y + B.h * 0.56;
    if (bay.length === 0) {
      this.bayLayer.add(
        neonText(this, B.cx, rowY, "empty until the first intermission", { size: this.f(1), color: CSS.inkFaint, align: "center" }).setOrigin(0.5),
      );
      return;
    }
    const baseW = 132;
    const gap = 14;
    const maxW = B.w - 20;
    let scale = Math.min((B.h * 0.7) / 168, maxW / (bay.length * (baseW + gap)));
    scale = Phaser.Math.Clamp(scale, 0.38, 0.9);
    const cw = baseW * scale + gap;
    const startX = B.cx - ((bay.length - 1) * cw) / 2;
    bay.forEach((slot, i) => {
      const card = new Card(this, startX + i * cw, rowY, slot.id, scale);
      card.setNew(slot.isNew === true);
      this.bayLayer.add(card);
      this.bayCards.push(card);
    });
  }

  // ── Overlay (countdown) ──────────────────────────────────────────────────────
  private showCountdown(n: number): void {
    if (this.match.state.phase !== "Countdown") return;
    const { w, h } = this.L;
    this.overlay.setVisible(true);
    this.overlay.removeAll(true);
    const dim = this.add.rectangle(w / 2, h / 2, w, h, COLORS.bg0, 0.88);
    const ready = neonText(this, w / 2, h * 0.38, "GET READY", { size: this.f(2.6), color: CSS.cyan, align: "center", glow: CSS.cyan }).setOrigin(0.5).setLetterSpacing(6);
    const num = this.add.text(w / 2, h * 0.5, `${n}`, { fontFamily: FONTS.mono, fontSize: `${this.f(8)}px`, color: CSS.ink, fontStyle: "bold" }).setOrigin(0.5).setShadow(0, 0, CSS.cyan, 24, true, true);
    this.overlay.add([dim, ready, num]);
    const banned = this.match.state.bannedLetter;
    if (banned) {
      this.overlay.add(
        neonText(this, w / 2, h * 0.6, `BANNED LETTER:  ${banned.toUpperCase()}`, { size: this.f(1.5), color: CSS.danger, align: "center", glow: CSS.danger }).setOrigin(0.5),
      );
    }
    Anim.pop(this, num, 300);
  }

  private hideOverlay(): void {
    this.overlay.setVisible(false);
  }

  private teardown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.wordInput?.destroy();
  }

  override update(_time: number, deltaMs: number): void {
    const phase = this.match.state.phase;
    if (phase === "Round" || phase === "Countdown") {
      this.controller.tick(deltaMs / 1000);
    }
  }
}
