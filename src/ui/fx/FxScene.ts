/*
 * The one Phaser scene left in the game. It renders nothing structural — only
 * canvas-worthy juice: particle bursts keyed to the score engine, a celebratory
 * eruption for big scores, and confetti on game-over. It runs on a full-window
 * transparent canvas layered above the DOM (pointer-events:none), so its coords
 * are viewport CSS px (Scale.RESIZE, displayScale 1) — a DOM rect's center maps
 * straight onto the canvas with no conversion.
 */

import Phaser from "phaser";
import { COLORS, CONFETTI_TINTS } from "../../theme";

type Emitter = Phaser.GameObjects.Particles.ParticleEmitter;

export class FxScene extends Phaser.Scene {
  private burst!: Emitter;
  private spark!: Emitter;
  private confettiEmitter!: Emitter;
  private confettiPop!: Emitter;

  constructor() {
    super("Fx");
  }

  create(): void {
    this.makeTextures();

    // Soft round glow particles — the workhorse for score-step bursts/eruptions.
    this.burst = this.add.particles(0, 0, "fx-dot", {
      speed: { min: 80, max: 260 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 380, max: 720 },
      blendMode: "ADD",
      emitting: false,
    });
    this.burst.setDepth(10);

    // Tiny crisp sparks for accent flecks.
    this.spark = this.add.particles(0, 0, "fx-spark", {
      speed: { min: 120, max: 420 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.7, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 300, max: 560 },
      blendMode: "ADD",
      emitting: false,
    });
    this.spark.setDepth(11);

    // Confetti rectangles raining from the top, tumbling under gravity.
    this.confettiEmitter = this.add.particles(0, 0, "fx-rect", {
      x: () => Phaser.Math.Between(0, this.scale.width),
      y: -20,
      speedX: { min: -60, max: 60 },
      speedY: { min: 120, max: 320 },
      gravityY: 420,
      scale: { min: 0.6, max: 1.2 },
      rotate: { start: 0, end: 360 },
      lifespan: 2600,
      tint: [...CONFETTI_TINTS],
      emitting: false,
    });
    this.confettiEmitter.setDepth(9);

    // Confetti chips exploding radially from a point, then tumbling down — the
    // localized scoring-engine celebration (no full-window spread).
    this.confettiPop = this.add.particles(0, 0, "fx-rect", {
      speed: { min: 120, max: 380 },
      angle: { min: 0, max: 360 },
      gravityY: 520,
      scale: { min: 0.6, max: 1.2 },
      rotate: { start: 0, end: 360 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 900, max: 1600 },
      tint: [...CONFETTI_TINTS],
      emitting: false,
    });
    this.confettiPop.setDepth(9);
  }

  /** Build the small particle textures procedurally (no asset loading). */
  private makeTextures(): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    // Soft dot: bright core, faded rim.
    g.fillStyle(0xffffff, 1);
    g.fillCircle(16, 16, 7);
    g.fillStyle(0xffffff, 0.35);
    g.fillCircle(16, 16, 14);
    g.generateTexture("fx-dot", 32, 32);
    g.clear();
    // Spark: a small solid square.
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 6, 6);
    g.generateTexture("fx-spark", 6, 6);
    g.clear();
    // Confetti chip.
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 9, 13);
    g.generateTexture("fx-rect", 9, 13);
    g.destroy();
  }

  // ── Public effects (driven via the fx API) ─────────────────────────────────
  burstAt(x: number, y: number, intensity: number, color: number): void {
    const i = Phaser.Math.Clamp(intensity, 0, 1);
    const dots = Math.round(8 + i * 26);
    this.burst.setParticleTint(color);
    this.burst.explode(dots, x, y);
    this.spark.setParticleTint(color);
    this.spark.explode(Math.round(4 + i * 14), x, y);
  }

  eruption(x: number, y: number, intensity: number): void {
    const i = Phaser.Math.Clamp(intensity, 0, 1);
    // Three stages of a strike: the flash of contact, the spray of sparks, then
    // the metal left glowing. Hot to cooling, never a colour sequence.
    this.burst.setParticleTint(COLORS.emberHot);
    this.burst.explode(Math.round(40 + i * 80), x, y);
    this.spark.setParticleTint(COLORS.brassLit);
    this.spark.explode(Math.round(30 + i * 70), x, y);
    this.burst.setParticleTint(COLORS.ember);
    this.burst.explode(Math.round(20 + i * 50), x, y);
  }

  confetti(durationMs = 1100): void {
    this.confettiEmitter.start();
    this.time.delayedCall(durationMs, () => this.confettiEmitter.stop());
  }

  /** A burst of confetti chips exploding radially from a point (the scoring
   *  engine), then tumbling down under gravity — localized, not a full-screen
   *  rain. Uses the same chip texture/tints as the rain emitter. */
  confettiBurst(x: number, y: number, intensity: number): void {
    const i = Phaser.Math.Clamp(intensity, 0, 1);
    this.confettiPop.explode(Math.round(18 + i * 42), x, y);
  }
}
