/*
 * A modifier-card visual: family-accent border, baked SVG icon (tinted to the
 * family color), name, and a magnitude chip ("+10", "×1.5", "FX"). Supports a
 * "NEW" flag (dealt this era), a triggered highlight (for score replay), and
 * grabbed/dragging states (for Intermission reorder).
 */

import Phaser from "phaser";
import { getCard } from "../game/cards/library";
import type { CardFamily } from "../game/types";
import { COLORS } from "../theme";
import { iconKey } from "./icons";
import { drawPanel } from "./widgets";

const FAMILY_ACCENT: Record<CardFamily, number> = {
  letter: COLORS.accentLetter,
  clock: COLORS.accentClock,
  economy: COLORS.accentEconomy,
  utility: COLORS.accentUtility,
  neutral: COLORS.accentNeutral,
};

export const CARD_W = 132;
export const CARD_H = 168;

export class Card extends Phaser.GameObjects.Container {
  readonly cardId: string;
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly accent: number;
  private newBadge?: Phaser.GameObjects.Container;
  private cardW: number;
  private cardH: number;

  constructor(scene: Phaser.Scene, x: number, y: number, cardId: string, scale = 1) {
    super(scene, x, y);
    this.cardId = cardId;
    this.cardW = CARD_W * scale;
    this.cardH = CARD_H * scale;
    const def = getCard(cardId);
    const family: CardFamily = def?.family ?? "neutral";
    this.accent = FAMILY_ACCENT[family];

    this.bg = scene.add.graphics();
    this.drawBg(false);
    this.add(this.bg);

    // Icon
    const ik = iconKey(cardId);
    if (scene.textures.exists(ik)) {
      const icon = scene.add
        .image(0, -this.cardH * 0.16, ik)
        .setDisplaySize(this.cardH * 0.42, this.cardH * 0.42)
        .setTint(this.accent);
      this.add(icon);
    }

    // Magnitude chip
    const chip = scene.add
      .text(0, this.cardH * 0.16, def?.magnitudeText ?? "?", {
        fontFamily: '"Courier New", monospace',
        fontSize: `${Math.round(this.cardH * 0.13)}px`,
        color: "#06080f",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    const chipBg = scene.add.graphics();
    const cw = chip.width + 18 * scale;
    const ch = chip.height + 8 * scale;
    chipBg.fillStyle(this.accent, 1);
    chipBg.fillRoundedRect(-cw / 2, this.cardH * 0.16 - ch / 2, cw, ch, ch / 2);
    this.add([chipBg, chip]);

    // Name
    const name = scene.add
      .text(0, this.cardH * 0.36, def?.name ?? cardId, {
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        fontSize: `${Math.round(this.cardH * 0.072)}px`,
        color: "#eaf2ff",
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: this.cardW - 16 },
      })
      .setOrigin(0.5, 0);
    this.add(name);

    this.setSize(this.cardW, this.cardH);
    scene.add.existing(this);
  }

  private drawBg(highlighted: boolean): void {
    drawPanel(this.bg, -this.cardW / 2, -this.cardH / 2, this.cardW, this.cardH, {
      fill: highlighted ? 0x1b2547 : COLORS.panelSolid,
      fillAlpha: 0.96,
      border: this.accent,
      borderAlpha: highlighted ? 1 : 0.7,
      borderWidth: highlighted ? 3 : 2,
      radius: 12,
      shadowOffset: 4,
    });
  }

  setNew(isNew: boolean): this {
    if (isNew && !this.newBadge) {
      const badge = this.scene.add.container(this.cardW / 2 - 18, -this.cardH / 2 + 14);
      const g = this.scene.add.graphics();
      g.fillStyle(COLORS.magenta, 1);
      g.fillRoundedRect(-22, -11, 44, 22, 11);
      const t = this.scene.add
        .text(0, 0, "NEW", { fontFamily: "sans-serif", fontSize: "12px", color: "#fff", fontStyle: "bold" })
        .setOrigin(0.5);
      badge.add([g, t]);
      this.add(badge);
      this.newBadge = badge;
    } else if (!isNew && this.newBadge) {
      this.newBadge.destroy();
      this.newBadge = undefined;
    }
    return this;
  }

  /** Light up (for the score-replay walk) with a pop. */
  setTriggered(on: boolean): this {
    this.drawBg(on);
    if (on) {
      this.scene.tweens.add({
        targets: this,
        scale: 1.12,
        duration: 140,
        yoyo: true,
        ease: "Quad.easeOut",
      });
    }
    return this;
  }

  /** Visually dim a skipped card during replay. */
  setDimmed(on: boolean): this {
    this.setAlpha(on ? 0.4 : 1);
    return this;
  }
}
