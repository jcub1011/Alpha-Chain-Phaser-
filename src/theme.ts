/*
 * FX color constants for the Phaser particle layer. The canonical DOM palette
 * lives in src/styles/tokens.css; this module mirrors only the few colors the
 * canvas FX needs as 0xRRGGBB numbers (Phaser tints/particles want numbers).
 */

import { CardFamily } from "./game/types";

/** Hex string -> 0xRRGGBB number. */
export const hex = (s: string): number => parseInt(s.replace("#", ""), 16);

export const COLORS = {
  // Sparks and heat — what the FX layer is almost entirely made of. A particle
  // burst is a die landing, so it throws hot metal, never coloured light.
  ember: 0xe1552a,
  emberHot: 0xf4a23c,
  brass: 0xc08f3c,
  brassLit: 0xe0b25c,
  copper: 0xa9603a,
  oxide: 0xa33a2a,
  patina: 0x5f9e77,
  stock: 0xdcd2be,
  ink: 0xf0e9dc,

  // Card-family accents (mirror tokens.css).
  accentLetter: 0x7cbf98,
  accentClock: 0x5d97c0,
  accentEconomy: 0xefcf6e,
  accentUtility: 0x8b4254,
  accentNeutral: 0x7e7669,
} as const;

/**
 * Confetti tints. Warm metal and paint codes rather than a rainbow — this is
 * the one place the FX layer is allowed to be festive, and it still has to look
 * like it came off the same shop floor as everything else.
 */
export const CONFETTI_TINTS = [
  0xe0b25c, 0xc08f3c, 0xa9603a, 0x5f9e77, 0xdcd2be,
] as const;

/** Player accent rotation, assigned by turn-order index. */
export const PLAYER_ACCENTS = [
  0xe5c890, // p1 brass
  0xb44e30, // p2 vermilion
  0x53b283, // p3 verdigris
  0x4d8dba, // p4 quench blue
  0x753d61, // p5 plum
  0xeae8e3, // p6 bone
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
