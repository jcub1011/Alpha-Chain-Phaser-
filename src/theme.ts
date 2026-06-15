/*
 * Alpha Chain — Neon-Noir Esports theme, ported from the Blazor original's
 * `alpha-chain-theme.css`. Colors are kept as `0xRRGGBB` numbers (for Phaser
 * tint / Graphics fill) plus `#rrggbb` string mirrors (for DOM elements and
 * gradients). Palette: deep navy/black scoreboard, cyan-vs-magenta accents.
 */

import Phaser from "phaser";

/** Hex string -> 0xRRGGBB number. */
export const hex = (s: string): number => parseInt(s.replace("#", ""), 16);

export const COLORS = {
  // Surfaces
  bg0: 0x06080f,
  bg1: 0x0c1020,
  bg2: 0x141a30,
  panel: 0x12182c,
  panelSolid: 0x121830,
  border: 0xffffff, // used with low alpha
  ink: 0xeaf2ff,
  inkSoft: 0x9fb0cc,
  inkFaint: 0x667586,

  // Accents
  cyan: 0x00e5ff,
  magenta: 0xff2e8b,
  violet: 0xb97bff,
  amber: 0xffb020,
  danger: 0xff3b5c,
  mint: 0x14f195,

  // Card families (color-blind separated)
  accentLetter: 0x14f195, // mint  — word/letter scoring
  accentClock: 0x2f86e6, // blue  — shot-clock
  accentEconomy: 0xffb020, // amber — points / economy / aggression
  accentUtility: 0xe36ec9, // orchid — utility / defensive
  accentNeutral: 0x8aa0b3, // slate — inert / unknown
} as const;

/** String mirrors for DOM/CSS use. */
export const CSS = {
  bg0: "#06080f",
  ink: "#eaf2ff",
  inkSoft: "rgba(234,242,255,0.62)",
  inkFaint: "rgba(234,242,255,0.38)",
  cyan: "#00e5ff",
  magenta: "#ff2e8b",
  amber: "#ffb020",
  danger: "#ff3b5c",
  mint: "#14f195",
  panel: "rgba(18,24,44,0.72)",
  border: "rgba(255,255,255,0.18)",
} as const;

/** Player accent rotation, assigned by turn-order index. */
export const PLAYER_ACCENTS = [
  0x00e5ff, // p1 cyan
  0xff2e8b, // p2 magenta
  0xb97bff, // p3 violet
  0xffd23a, // p4 gold
  0x14f195, // p5 mint
  0xff8a3d, // p6 orange
] as const;

export const playerAccent = (index: number): number =>
  PLAYER_ACCENTS[index % PLAYER_ACCENTS.length];

/** Shot-clock ring states. */
export const CLOCK_GO = COLORS.cyan;
export const CLOCK_WARN = COLORS.amber;
export const CLOCK_DANGER = COLORS.danger;

export const FONTS = {
  display: '"Segoe UI", system-ui, sans-serif',
  mono: '"Courier New", ui-monospace, monospace',
} as const;

/** Honor the user's reduced-motion preference. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Reusable tween factories recreating the original CSS keyframes as Phaser
 * tweens. All no-op (snap to final state) under reduced-motion.
 */
export const Anim = {
  /** ac-pop: scale up from small with a slight rise. */
  pop(scene: Phaser.Scene, target: Phaser.GameObjects.GameObject, duration = 260) {
    const t = target as unknown as { setScale?: (n: number) => void };
    if (prefersReducedMotion()) {
      t.setScale?.(1);
      return;
    }
    t.setScale?.(0.6);
    scene.tweens.add({
      targets: target,
      scale: 1,
      duration,
      ease: "Back.easeOut",
    });
  },

  /** ac-float-up: rise and fade — for floating score numbers. */
  floatUp(
    scene: Phaser.Scene,
    target: Phaser.GameObjects.GameObject,
    rise = 64,
    duration = 1100,
    onComplete?: () => void,
  ) {
    const obj = target as unknown as { y: number };
    if (prefersReducedMotion()) {
      onComplete?.();
      (target as Phaser.GameObjects.GameObject).destroy();
      return;
    }
    scene.tweens.add({
      targets: target,
      y: obj.y - rise,
      alpha: { from: 1, to: 0 },
      duration,
      ease: "Cubic.easeOut",
      onComplete: () => {
        onComplete?.();
        (target as Phaser.GameObjects.GameObject).destroy();
      },
    });
  },

  /** ac-rise: slide up into place while fading in. */
  rise(scene: Phaser.Scene, target: Phaser.GameObjects.GameObject, fromY = 16, duration = 300) {
    const obj = target as unknown as { y: number; alpha: number };
    if (prefersReducedMotion()) return;
    const finalY = obj.y;
    obj.y = finalY + fromY;
    obj.alpha = 0;
    scene.tweens.add({
      targets: target,
      y: finalY,
      alpha: 1,
      duration,
      ease: "Cubic.easeOut",
    });
  },

  /** ac-flash: a quick white flash overlay on a rectangle. */
  flash(scene: Phaser.Scene, target: Phaser.GameObjects.GameObject, duration = 320) {
    if (prefersReducedMotion()) return;
    scene.tweens.add({
      targets: target,
      alpha: { from: 0.85, to: 0 },
      duration,
      ease: "Quad.easeOut",
    });
  },

  /** ac-pulse: opacity heartbeat (looping). Returns the tween so callers can stop it. */
  pulse(scene: Phaser.Scene, target: Phaser.GameObjects.GameObject, duration = 700) {
    if (prefersReducedMotion()) return undefined;
    return scene.tweens.add({
      targets: target,
      alpha: { from: 1, to: 0.4 },
      duration,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  },
} as const;
