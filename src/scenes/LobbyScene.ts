/*
 * Title + match setup. Centered, responsive content column that reflows on
 * resize, then builds a LocalController and launches the game.
 */

import Phaser from "phaser";
import type { Dictionary } from "../game/dictionary";
import type { AlphaChainSettings, BotDifficulty } from "../game/types";
import { LocalController } from "../net/localController";
import { COLORS, CSS, FONTS } from "../theme";
import { REGISTRY } from "../ui/layout";
import { neonText, panel, pillButton } from "../ui/widgets";

const SHOT_CLOCKS = [10, 15, 20, 30, 45, 60];
const DIFFICULTIES: BotDifficulty[] = ["easy", "medium", "hard"];

export class LobbyScene extends Phaser.Scene {
  private settings!: AlphaChainSettings;
  private unit = 24;

  constructor() {
    super("Lobby");
  }

  create(): void {
    this.settings = this.registry.get(REGISTRY.settings) as AlphaChainSettings;
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
    // Cap by height so the full content block (~34 units tall) always fits.
    this.unit = Phaser.Math.Clamp(Math.min((w - 40) / 26, (h - 24) / 34), 13, 30);
    const cx = w / 2;
    this.addBackdrop(w, h);

    // Center a content column of known height, clamped into the viewport.
    const panelW = Math.min(w - this.f(2), this.f(24));
    const rowGap = this.f(3);
    const panelH = this.f(4) + rowGap * 4 + this.f(2);
    const blockH = this.f(3.4) + this.f(1.6) + this.f(2) + panelH + this.f(4.5) + this.f(2.2);
    let y = Math.max(this.f(1.5), (h - blockH) / 2);

    const titleSize = Math.min(this.f(3), w / 9.2); // fit "ALPHA CHAIN" on narrow screens
    const title = neonText(this, cx, y, "ALPHA CHAIN", { size: titleSize, color: CSS.cyan, glow: CSS.cyan, align: "center" })
      .setOrigin(0.5, 0)
      .setLetterSpacing(Math.min(this.f(0.4), w / 90));
    this.tweens.add({ targets: title, y: y + 4, duration: 2200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    y += this.f(3.4) + this.f(0.6);

    neonText(this, cx, y, "word-chain × engine-builder", { size: this.f(1), color: CSS.magenta, glow: CSS.magenta, align: "center" })
      .setOrigin(0.5, 0)
      .setLetterSpacing(2);
    y += this.f(1.6) + this.f(2);

    const px = cx - panelW / 2;
    panel(this, px, y, panelW, panelH, { border: COLORS.cyan, borderAlpha: 0.4 });
    neonText(this, cx, y + this.f(1.2), "MATCH SETUP", { size: this.f(1.1), color: CSS.ink, align: "center" }).setOrigin(0.5).setLetterSpacing(4);

    let row = y + this.f(3.4);
    this.stepper(px, row, panelW, "Opponents", () => `${this.settings.botCount}`, (d) => {
      this.settings.botCount = Phaser.Math.Clamp(this.settings.botCount + d, 1, 5);
    });
    row += rowGap;
    this.stepper(px, row, panelW, "Difficulty", () => this.settings.botDifficulty.toUpperCase(), (d) => {
      const i = DIFFICULTIES.indexOf(this.settings.botDifficulty);
      this.settings.botDifficulty = DIFFICULTIES[(i + d + DIFFICULTIES.length) % DIFFICULTIES.length];
    });
    row += rowGap;
    this.stepper(px, row, panelW, "Shot clock", () => `${this.settings.shotClockSeconds}s`, (d) => {
      const i = SHOT_CLOCKS.indexOf(this.settings.shotClockSeconds);
      const ni = Phaser.Math.Clamp((i < 0 ? 2 : i) + d, 0, SHOT_CLOCKS.length - 1);
      this.settings.shotClockSeconds = SHOT_CLOCKS[ni];
    });
    row += rowGap;
    this.stepper(px, row, panelW, "Eras", () => `${this.settings.eraCount}`, (d) => {
      this.settings.eraCount = Phaser.Math.Clamp(this.settings.eraCount + d, 1, 6);
    });

    y += panelH + this.f(2.2);
    pillButton(this, cx, y + this.f(1.6), Math.min(panelW, this.f(15)), this.f(3.4), "START MATCH", () => this.startMatch(), COLORS.cyan);
    y += this.f(4.5);
    neonText(this, cx, y, "chain words • last letter → next word • build your engine", { size: this.f(0.8), color: CSS.inkFaint, align: "center" }).setOrigin(0.5, 0);
  }

  private addBackdrop(w: number, h: number): void {
    const colors = [COLORS.cyan, COLORS.magenta];
    const r = Math.min(w, h) * 0.4;
    [
      [w * 0.1, h * 0.85, colors[0]],
      [w * 0.9, h * 0.9, colors[1]],
    ].forEach(([x, yy, c], i) => {
      const g = this.add.circle(x, yy, r, c, 0.06);
      this.tweens.add({ targets: g, alpha: 0.12, duration: 3000 + i * 800, yoyo: true, repeat: -1 });
    });
  }

  private stepper(px: number, y: number, panelW: number, label: string, fmt: () => string, step: (dir: number) => void): void {
    const btn = this.f(2);
    neonText(this, px + this.f(1.4), y, label, { size: this.f(1.1), color: CSS.ink }).setOrigin(0, 0.5);
    const value = this.add
      .text(px + panelW - this.f(5.2), y, fmt(), { fontFamily: FONTS.mono, fontSize: `${this.f(1.2)}px`, color: CSS.cyan, fontStyle: "bold" })
      .setOrigin(0.5, 0.5);
    const mk = (x: number, sym: string, dir: number) =>
      pillButton(this, x, y, btn, btn, sym, () => {
        step(dir);
        value.setText(fmt());
      }, COLORS.bg2);
    mk(px + panelW - this.f(1.6), "+", 1);
    mk(px + panelW - this.f(8.8), "−", -1);
  }

  private startMatch(): void {
    const dict = this.registry.get(REGISTRY.dict) as Dictionary;
    const controller = new LocalController(this.settings, dict);
    this.registry.set(REGISTRY.controller, controller);
    this.scene.start("Game");
  }
}
