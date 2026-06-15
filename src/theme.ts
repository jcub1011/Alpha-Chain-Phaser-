/*
 * FX color constants for the Phaser particle layer. The canonical DOM palette
 * lives in src/styles/tokens.css; this module mirrors only the few colors the
 * canvas FX needs as 0xRRGGBB numbers (Phaser tints/particles want numbers).
 */

/** Hex string -> 0xRRGGBB number. */
export const hex = (s: string): number => parseInt(s.replace("#", ""), 16);

export const COLORS = {
  cyan: 0x00e5ff,
  magenta: 0xff2e8b,
  violet: 0xb97bff,
  amber: 0xffb020,
  danger: 0xff3b5c,
  mint: 0x14f195,
  ink: 0xeaf2ff,

  // Card-family accents (mirror tokens.css).
  accentLetter: 0x14f195,
  accentClock: 0x2f86e6,
  accentEconomy: 0xffb020,
  accentUtility: 0xe36ec9,
  accentNeutral: 0x8aa0b3,
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

/** Map a card-family string to its FX tint. */
export const familyColor = (family: string): number => {
  switch (family) {
    case "letter":
      return COLORS.accentLetter;
    case "clock":
      return COLORS.accentClock;
    case "economy":
      return COLORS.accentEconomy;
    case "utility":
      return COLORS.accentUtility;
    default:
      return COLORS.accentNeutral;
  }
};

/** Honor the user's reduced-motion preference. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
