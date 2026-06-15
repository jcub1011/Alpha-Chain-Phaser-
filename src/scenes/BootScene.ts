/*
 * Loads the bundled dictionary + card sprite, bakes the card-icon textures, and
 * seeds the registry with the Dictionary and default settings, then hands off
 * to the Lobby. Shows a neon progress bar while the (large) word list loads.
 * Resize-aware so the loading screen stays centered when the READY event flips
 * gameSize to device pixels.
 */

import Phaser from "phaser";
import { Dictionary } from "../game/dictionary";
import { DEFAULT_SETTINGS } from "../game/settings";
import { COLORS, CSS } from "../theme";
import { bakeCardIcons } from "../ui/icons";
import { REGISTRY } from "../ui/layout";
import { neonText } from "../ui/widgets";

export class BootScene extends Phaser.Scene {
  private progress = 0;
  private title?: Phaser.GameObjects.Text;
  private sub?: Phaser.GameObjects.Text;
  private bar?: Phaser.GameObjects.Graphics;

  constructor() {
    super("Boot");
  }

  preload(): void {
    this.layoutScreen();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layoutScreen, this);
    this.load.on("progress", (v: number) => {
      this.progress = v;
      this.drawBar();
    });
    this.load.once("complete", () => this.sub?.setText("preparing cards…"));
    this.load.text("words", "assets/words.txt");
    this.load.text("cardsSvg", "assets/cards.svg");
  }

  private layoutScreen(): void {
    const S = 1;
    const cx = this.scale.gameSize.width / 2;
    const cy = this.scale.gameSize.height / 2;
    this.title?.destroy();
    this.sub?.destroy();
    this.title = neonText(this, cx, cy - 120 * S, "ALPHA CHAIN", { size: 56 * S, color: CSS.cyan, glow: CSS.cyan, align: "center" })
      .setOrigin(0.5)
      .setLetterSpacing(8);
    this.sub = neonText(this, cx, cy - 64 * S, this.progress >= 1 ? "preparing cards…" : "loading lexicon…", { size: 20 * S, color: CSS.inkSoft })
      .setOrigin(0.5);
    this.drawBar();
  }

  private drawBar(): void {
    const S = 1;
    const cx = this.scale.gameSize.width / 2;
    const cy = this.scale.gameSize.height / 2;
    const barW = 420 * S;
    const barX = cx - barW / 2;
    if (!this.bar) this.bar = this.add.graphics();
    this.bar.clear();
    this.bar.lineStyle(2 * S, COLORS.cyan, 0.4);
    this.bar.strokeRoundedRect(barX, cy, barW, 22 * S, 11 * S);
    this.bar.fillStyle(COLORS.cyan, 1);
    this.bar.fillRoundedRect(barX + 3 * S, cy + 3 * S, Math.max(0, (barW - 6 * S) * this.progress), 16 * S, 8 * S);
  }

  create(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    const text = this.cache.text.get("words") as string;
    const dict = new Dictionary(
      text
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0),
    );
    this.registry.set(REGISTRY.dict, dict);
    this.registry.set(REGISTRY.settings, { ...DEFAULT_SETTINGS });

    const svg = this.cache.text.get("cardsSvg") as string;
    await bakeCardIcons(this, svg);

    this.scale.off(Phaser.Scale.Events.RESIZE, this.layoutScreen, this);
    this.scene.start("Lobby");
  }
}
