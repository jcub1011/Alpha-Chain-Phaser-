/*
 * Final standings. Ranks players by cumulative score, celebrates the winner,
 * and offers a return to the lobby. Responsive + centered.
 */

import Phaser from "phaser";
import type { MatchController } from "../game/match";
import type { GameController } from "../net/controller";
import { Anim, COLORS, CSS, FONTS, playerAccent, prefersReducedMotion } from "../theme";
import { REGISTRY } from "../ui/layout";
import { neonText, panel, pillButton } from "../ui/widgets";

export class GameOverScene extends Phaser.Scene {
  private unit = 24;

  constructor() {
    super("GameOver");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLORS.bg0);
    this.build();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.build, this);
    this.events.once("shutdown", () => this.scale.off(Phaser.Scale.Events.RESIZE, this.build, this));
  }

  private f(m: number): number {
    return Math.max(11, Math.round(this.unit * m));
  }

  private build(): void {
    this.children.removeAll(true);
    const { width: w, height: h } = this.scale.gameSize;
    this.unit = Phaser.Math.Clamp(Math.min((w - 40) / 26, (h - 24) / 33), 13, 30);
    const cx = w / 2;

    const controller = this.registry.get(REGISTRY.controller) as GameController;
    const match: MatchController = controller.match;
    const standings = match.standings();
    const winner = standings[0];
    const youWon = winner?.id === controller.humanId;

    const rowH = this.f(2.8);
    const panelH = this.f(3) + standings.length * rowH;
    const blockH = this.f(3.2) + this.f(2.2) + panelH + this.f(2) + this.f(5);
    let y = Math.max(this.f(1.5), (h - blockH) / 2);

    neonText(this, cx, y, youWon ? "VICTORY" : "GAME OVER", { size: Math.min(this.f(3), w / 8), color: youWon ? CSS.mint : CSS.cyan, glow: youWon ? CSS.mint : CSS.cyan, align: "center" })
      .setOrigin(0.5, 0)
      .setLetterSpacing(Math.min(this.f(0.35), w / 90));
    y += this.f(3.2);
    neonText(this, cx, y, `${winner.name} wins with ${winner.score}`, { size: this.f(1.1), color: CSS.inkSoft, align: "center" }).setOrigin(0.5, 0);
    y += this.f(2.2);

    const pw = Math.min(w - this.f(2), this.f(24));
    const px = cx - pw / 2;
    panel(this, px, y, pw, panelH, { border: COLORS.cyan, borderAlpha: 0.4 });
    const top = y + this.f(2);
    standings.forEach((p, i) => {
      const ry = top + i * rowH + rowH / 2;
      const accent = playerAccent(p.accentIndex);
      const accentCss = Phaser.Display.Color.IntegerToColor(accent).rgba;
      const rank = this.add.text(px + this.f(1.4), ry, `${i + 1}`, { fontFamily: FONTS.mono, fontSize: `${this.f(1.5)}px`, color: accentCss, fontStyle: "bold" }).setOrigin(0, 0.5);
      this.add.circle(px + this.f(3.4), ry, this.f(0.45), accent, 1);
      const name = this.add.text(px + this.f(4.4), ry, p.name + (p.id === controller.humanId ? " (you)" : ""), {
        fontFamily: FONTS.display,
        fontSize: `${this.f(1.2)}px`,
        color: i === 0 ? CSS.ink : CSS.inkSoft,
        fontStyle: i === 0 ? "bold" : "normal",
      }).setOrigin(0, 0.5);
      const score = this.add.text(px + pw - this.f(1.4), ry, `${p.score}`, { fontFamily: FONTS.mono, fontSize: `${this.f(1.3)}px`, color: accentCss, fontStyle: "bold" }).setOrigin(1, 0.5);
      if (!prefersReducedMotion()) [rank, name, score].forEach((o) => Anim.rise(this, o, 18, 260 + i * 60));
    });
    y += panelH + this.f(1.4);
    neonText(this, cx, y, `${match.state.history.length} words chained this match`, { size: this.f(0.8), color: CSS.inkFaint, align: "center" }).setOrigin(0.5, 0);
    y += this.f(3);

    pillButton(this, cx, y + this.f(1.8), Math.min(pw, this.f(16)), this.f(3.4), "RETURN TO LOBBY", () => this.scene.start("Lobby"), COLORS.cyan);

    if (youWon && !prefersReducedMotion()) this.confetti(w, h);
  }

  private confetti(w: number, h: number): void {
    const colors = [COLORS.cyan, COLORS.magenta, COLORS.mint, COLORS.amber];
    for (let i = 0; i < 60; i++) {
      const r = this.add.rectangle(Phaser.Math.Between(0, w), -20, 10, 16, colors[i % colors.length], 1).setAngle(Phaser.Math.Between(0, 360));
      this.tweens.add({
        targets: r,
        y: h + 40,
        angle: r.angle + Phaser.Math.Between(180, 720),
        duration: Phaser.Math.Between(2200, 4200),
        delay: Phaser.Math.Between(0, 1200),
        repeat: -1,
        ease: "Quad.easeIn",
      });
    }
  }
}
