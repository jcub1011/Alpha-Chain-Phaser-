/*
 * FX color constants for the Phaser particle layer. The canonical DOM palette
 * lives in src/styles/tokens.css; this module mirrors only the few colors the
 * canvas FX needs as 0xRRGGBB numbers (Phaser tints/particles want numbers).
 */

import { CardFamily } from "./game/types";

/** Hex string -> 0xRRGGBB number. */
export const hex = (s: string): number => parseInt(s.replace("#", ""), 16);

export const COLORS = {
  // Sparks and heat / signal glow
  ember: 0xff1744,
  emberHot: 0xff9100,
  brass: 0x00f0ff,
  brassLit: 0x70f8ff,
  copper: 0xff6d00,
  oxide: 0xff1744,
  patina: 0x00e676,
  stock: 0xffffff,
  ink: 0xffffff,

  // Card-family accents (mirror tokens.css).
  accentLetter: 0x00e676,
  accentClock: 0x00f0ff,
  accentEconomy: 0xffd600,
  accentUtility: 0xd500f9,
  accentNeutral: 0x64748b,
} as const;

/**
 * Confetti tints. Bold, maximum-contrast signal colors.
 */
export const CONFETTI_TINTS = [
  0x00f0ff, 0xff1744, 0x00e676, 0xffd600, 0xd500f9, 0xffffff,
] as const;

/** Player accent rotation, assigned by turn-order index. */
export const PLAYER_ACCENTS = [
  0x00f0ff, // p1 Saturated Cyan
  0xff1744, // p2 Laser Crimson
  0x00e676, // p3 Electric Emerald
  0xffd600, // p4 Solar Gold
  0xd500f9, // p5 Neon Violet
  0xffffff, // p6 Pure White
] as const;

export const playerAccent = (index: number): number =>
  PLAYER_ACCENTS[index % PLAYER_ACCENTS.length];

/** Map a card-family to its FX tint. */
export const familyColor = (family: CardFamily): number => {
  switch (family) {
    case CardFamily.Letter:
      return COLORS.accentLetter;
    case CardFamily.Clock:
      return COLORS.accentClock;
    case CardFamily.Economy:
      return COLORS.accentEconomy;
    case CardFamily.Utility:
      return COLORS.accentUtility;
    default:
      return COLORS.accentNeutral;
  }
};

/** Honor the user's reduced-motion preference. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
