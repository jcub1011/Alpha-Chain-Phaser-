/*
 * The shot-clock ring: an arc that drains as time runs out, recoloring
 * cyan → amber (≤6s) → red (≤3s) and pulsing with a heartbeat in the danger
 * zone. The big seconds readout sits in the center.
 */

import Phaser from "phaser";
import { CLOCK_DANGER, CLOCK_GO, CLOCK_WARN, COLORS, prefersReducedMotion } from "../theme";

export class ShotClockRing extends Phaser.GameObjects.Container {
  private readonly ring: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private readonly radius: number;
  private remaining = 0;
  private total = 1;
  private lastWhole = -1;

  constructor(scene: Phaser.Scene, x: number, y: number, radius = 64) {
    super(scene, x, y);
    this.radius = radius;
    this.ring = scene.add.graphics();
    this.label = scene.add
      .text(0, 0, "0", {
        fontFamily: '"Courier New", monospace',
        fontSize: `${Math.round(radius * 0.78)}px`,
        color: "#eaf2ff",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    this.add([this.ring, this.label]);
    scene.add.existing(this);
    this.redraw();
  }

  set(remaining: number, total: number): void {
    this.remaining = Math.max(0, remaining);
    this.total = Math.max(0.001, total);
    this.redraw();
    const whole = Math.ceil(this.remaining);
    if (whole !== this.lastWhole) {
      this.lastWhole = whole;
      // Heartbeat pop in the danger zone.
      if (whole <= 3 && whole > 0 && !prefersReducedMotion()) {
        this.scene.tweens.add({ targets: this, scale: 1.12, duration: 130, yoyo: true });
      }
    }
  }

  private color(): number {
    if (this.remaining <= 3) return CLOCK_DANGER;
    if (this.remaining <= 6) return CLOCK_WARN;
    return CLOCK_GO;
  }

  private redraw(): void {
    const g = this.ring;
    const r = this.radius;
    const col = this.color();
    const frac = Phaser.Math.Clamp(this.remaining / this.total, 0, 1);
    g.clear();
    // Track
    g.lineStyle(10, COLORS.bg2, 1);
    g.strokeCircle(0, 0, r);
    // Remaining arc, drains clockwise from the top.
    g.lineStyle(10, col, 1);
    const start = -Math.PI / 2;
    const end = start + frac * Math.PI * 2;
    g.beginPath();
    g.arc(0, 0, r, start, end, false);
    g.strokePath();
    this.label.setText(String(Math.ceil(this.remaining)));
    this.label.setColor(Phaser.Display.Color.IntegerToColor(col).rgba);
  }
}
