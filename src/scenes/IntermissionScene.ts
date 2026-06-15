/*
 * The era boundary. Deal + Expansion already happened in the match; this scene
 * runs the player-facing steps: Optimization (drag-reorder the engine bay; cards
 * kept = those left of the capacity divider) and the Sniper Ban (the last-place
 * player picks next era's banned letter — auto-picked for bots / on timeout).
 *
 * Responsive: rebuilds the active sub-phase on resize (preserving the in-progress
 * card order), with a fully opaque backdrop covering the game scene beneath.
 */

import Phaser from "phaser";
import type { MatchController } from "../game/match";
import { legalBanLetters } from "../game/settings";
import type { BayCard } from "../game/types";
import type { GameController } from "../net/controller";
import { Anim, COLORS, CSS, FONTS, prefersReducedMotion } from "../theme";
import { Card, CARD_W, CARD_H } from "../ui/Card";
import { neonText, pillButton } from "../ui/widgets";

export class IntermissionScene extends Phaser.Scene {
  private controller!: GameController;
  private get match(): MatchController {
    return this.controller.match;
  }
  private subPhase: "optimize" | "ban" = "optimize";
  private order: BayCard[] = []; // live engine-bay order during optimization
  private cards: Card[] = [];
  private cardScale = 0.7;
  private rowY = 0;
  private unit = 24;
  private cx = 0;
  private w = 0;
  private h = 0;
  private slots = 3;
  private banTimer?: Phaser.Time.TimerEvent;
  private resolved = false;

  constructor() {
    super("Intermission");
  }

  init(data: { controller: GameController }): void {
    this.controller = data.controller;
  }

  private f(m: number): number {
    return Math.max(11, Math.round(this.unit * m));
  }

  create(): void {
    this.order = [...this.match.bayCards(this.controller.humanId)];
    this.slots = this.match.state.players.find((p) => p.id === this.controller.humanId)!.slots;
    this.render();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once("shutdown", () => this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this));
  }

  private onResize(): void {
    if (this.resolved) return;
    this.banTimer?.remove();
    this.input.removeAllListeners("drag");
    this.input.removeAllListeners("dragend");
    this.cards = [];
    this.render();
  }

  /** (Re)build the whole overlay for the current sub-phase + window size. */
  private render(): void {
    this.children.removeAll(true);
    const sz = this.scale.gameSize;
    this.w = sz.width;
    this.h = sz.height;
    this.unit = Phaser.Math.Clamp(Math.min(this.w / 26, this.h / 26), 16, 30);
    this.cx = this.w / 2;
    this.rowY = this.h * 0.44;

    // Opaque backdrop so the game scene underneath is fully hidden.
    this.add.rectangle(this.w / 2, this.h / 2, this.w, this.h, COLORS.bg0, 1).setInteractive();
    this.add.rectangle(this.w / 2, this.h / 2, this.w, this.h, COLORS.bg1, 0.5);

    neonText(this, this.cx, this.h * 0.07, `ERA ${this.match.state.era} COMPLETE`, { size: this.f(1.9), color: CSS.cyan, align: "center", glow: CSS.cyan }).setOrigin(0.5).setLetterSpacing(4);
    neonText(this, this.cx, this.h * 0.12, "INTERMISSION", { size: this.f(1.1), color: CSS.magenta, align: "center", glow: CSS.magenta }).setOrigin(0.5).setLetterSpacing(6);

    if (this.subPhase === "optimize") this.showOptimize();
    else this.showBan();
  }

  // ── Step 1: Optimization ─────────────────────────────────────────────────────
  private showOptimize(): void {
    neonText(this, this.cx, this.h * 0.2, "OPTIMISE YOUR ENGINE", { size: this.f(1.3), color: CSS.ink, align: "center" }).setOrigin(0.5).setLetterSpacing(2);
    const overflow = this.order.length > this.slots;
    neonText(this, this.cx, this.h * 0.255, overflow ? `drag to reorder — only the leftmost ${this.slots} are kept` : "drag to reorder — scoring runs left → right", { size: this.f(0.95), color: CSS.inkSoft, align: "center" }).setOrigin(0.5);

    this.cardScale = Phaser.Math.Clamp((this.w - this.f(2)) / (this.order.length * (CARD_W + 16)), 0.4, 0.72);
    const hitW = CARD_W * this.cardScale;
    const hitH = CARD_H * this.cardScale;

    this.order.forEach((slot, i) => {
      const card = new Card(this, this.slotX(i, this.order.length), this.rowY, slot.id, this.cardScale);
      card.setNew(slot.isNew === true);
      card.setSize(hitW, hitH);
      card.setInteractive(new Phaser.Geom.Rectangle(-hitW / 2, -hitH / 2, hitW, hitH), Phaser.Geom.Rectangle.Contains);
      this.input.setDraggable(card);
      card.setDimmed(i >= this.slots);
      this.cards.push(card);
      Anim.rise(this, card, 30 + i * 6, 320);
    });

    this.wireDrag();
    if (overflow) this.drawCapacityDivider();

    pillButton(this, this.cx, this.h * 0.74, Math.min(this.w - this.f(2), this.f(13)), this.f(3.2), "CONFIRM", () => this.commitOptimize(), COLORS.cyan);
  }

  private slotX(index: number, count: number): number {
    const step = (CARD_W + 16) * this.cardScale;
    return this.cx - ((count - 1) * step) / 2 + index * step;
  }

  private drawCapacityDivider(): void {
    const g = this.add.graphics();
    const x = (this.slotX(this.slots - 1, this.order.length) + this.slotX(this.slots, this.order.length)) / 2;
    const half = (CARD_H * this.cardScale) / 2 + this.f(0.6);
    g.lineStyle(3, COLORS.danger, 0.8);
    g.lineBetween(x, this.rowY - half, x, this.rowY + half);
    neonText(this, x, this.rowY + half + this.f(0.8), "drop ▸", { size: this.f(0.8), color: CSS.danger }).setOrigin(0.5);
  }

  private wireDrag(): void {
    this.input.on("drag", (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, dragX: number) => {
      const card = obj as Card;
      card.x = dragX;
      card.setDepth(10);
      const from = this.cards.indexOf(card);
      const step = (CARD_W + 16) * this.cardScale;
      const target = Phaser.Math.Clamp(Math.round((dragX - this.slotX(0, this.cards.length)) / step), 0, this.cards.length - 1);
      if (target !== from) {
        this.cards.splice(from, 1);
        this.cards.splice(target, 0, card);
        this.order.splice(target, 0, this.order.splice(from, 1)[0]); // keep model in sync
        this.relayout(card);
        this.refreshDimming();
      }
    });
    this.input.on("dragend", (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      (obj as Card).setDepth(0);
      this.relayout(null);
      this.refreshDimming();
    });
  }

  private relayout(except: Card | null): void {
    this.cards.forEach((c, i) => {
      if (c === except) return;
      this.tweens.add({ targets: c, x: this.slotX(i, this.cards.length), y: this.rowY, duration: 160, ease: "Quad.easeOut" });
    });
  }

  private refreshDimming(): void {
    this.cards.forEach((c, i) => c.setDimmed(i >= this.slots));
  }

  private commitOptimize(): void {
    this.match.setPlayerBay(this.controller.humanId, this.order.map((c) => c.id).slice(0, this.slots));
    this.input.removeAllListeners("drag");
    this.input.removeAllListeners("dragend");
    this.subPhase = "ban";
    this.render();
  }

  // ── Step 2: Sniper Ban ───────────────────────────────────────────────────────
  private showBan(): void {
    this.add.rectangle(this.w / 2, this.h / 2, this.w, this.h, COLORS.bg0, 0.7);
    const lastId = this.match.computeLastPlaceId();
    const last = this.match.state.players.find((p) => p.id === lastId)!;
    const human = lastId === this.controller.humanId;

    neonText(this, this.cx, this.h * 0.32, "SNIPER BAN", { size: this.f(1.9), color: CSS.danger, align: "center", glow: CSS.danger }).setOrigin(0.5).setLetterSpacing(4);
    neonText(this, this.cx, this.h * 0.4, human ? "you're last — pick a letter to ban" : `${last.name} (last place) is choosing…`, { size: this.f(1.1), color: CSS.inkSoft, align: "center" }).setOrigin(0.5);

    const legal = legalBanLetters(this.match.state.settings.banMode);
    if (human) {
      this.buildLetterGrid(legal);
      this.startBanCountdown(legal);
    } else {
      this.time.delayedCall(1600, () => {
        const pool = legal.filter((c) => !"aeiou".includes(c));
        this.finish((pool.length ? pool : legal)[Math.floor(Math.random() * (pool.length || legal.length))]);
      });
    }
  }

  private buildLetterGrid(legal: string[]): void {
    const cols = this.w > this.h ? 9 : 7;
    const size = Math.min(this.f(3.2), (this.w - this.f(2)) / cols - this.f(0.4));
    const gap = this.f(0.4);
    const gridW = cols * size + (cols - 1) * gap;
    const startX = this.cx - gridW / 2 + size / 2;
    const startY = this.h * 0.5;
    legal.forEach((letter, i) => {
      const x = startX + (i % cols) * (size + gap);
      const y = startY + Math.floor(i / cols) * (size + gap);
      const c = this.add.container(x, y);
      const g = this.add.graphics();
      g.fillStyle(COLORS.bg2, 1);
      g.lineStyle(2, COLORS.danger, 0.5);
      g.fillRoundedRect(-size / 2, -size / 2, size, size, 12);
      g.strokeRoundedRect(-size / 2, -size / 2, size, size, 12);
      const t = this.add.text(0, 0, letter.toUpperCase(), { fontFamily: FONTS.display, fontSize: `${size * 0.45}px`, color: CSS.ink, fontStyle: "bold" }).setOrigin(0.5);
      c.add([g, t]);
      c.setSize(size, size).setInteractive(new Phaser.Geom.Rectangle(-size / 2, -size / 2, size, size), Phaser.Geom.Rectangle.Contains);
      c.on("pointerover", () => { t.setColor(CSS.danger); if (!prefersReducedMotion()) this.tweens.add({ targets: c, scale: 1.1, duration: 100 }); });
      c.on("pointerout", () => { t.setColor(CSS.ink); this.tweens.add({ targets: c, scale: 1, duration: 100 }); });
      c.on("pointerup", () => this.finish(letter));
    });
  }

  private startBanCountdown(legal: string[]): void {
    let remaining = this.match.state.settings.sniperBanSeconds;
    const label = neonText(this, this.cx, this.h * 0.9, `${remaining}s`, { size: this.f(1.4), color: CSS.danger, align: "center" }).setOrigin(0.5);
    this.banTimer = this.time.addEvent({
      delay: 1000,
      repeat: remaining - 1,
      callback: () => {
        remaining -= 1;
        label.setText(`${remaining}s`);
        if (remaining <= 0) this.finish(legal[Math.floor(Math.random() * legal.length)]);
      },
    });
  }

  private finish(letter: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.banTimer?.remove();
    const stamp = neonText(this, this.cx, this.h * 0.32, `BANNED:  ${letter.toUpperCase()}`, { size: this.f(2), color: CSS.danger, align: "center", glow: CSS.danger }).setOrigin(0.5).setDepth(50);
    Anim.pop(this, stamp, 240);
    this.time.delayedCall(900, () => {
      this.match.applySniperBanAndAdvance(letter);
      this.scene.stop();
    });
  }
}
