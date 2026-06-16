/* Small presentation helpers shared across components. */

import { COLORS, PLAYER_ACCENTS } from "../../theme";
import type { CardFamily } from "../../game/types";

/** CSS custom-property name for a player's accent, by turn-order index. */
export const playerAccentVar = (index: number): string => `var(--ac-p${(index % 6) + 1})`;

/** Numeric (0xRRGGBB) player accent, for FX calls. */
export const playerAccentColor = (index: number): number =>
  PLAYER_ACCENTS[index % PLAYER_ACCENTS.length];

/** CSS custom-property name for a card family's accent. */
export const familyAccentVar = (family: CardFamily): string => {
  switch (family) {
    case "letter":
      return "var(--ac-accent-letter)";
    case "clock":
      return "var(--ac-accent-clock)";
    case "economy":
      return "var(--ac-accent-economy)";
    case "utility":
      return "var(--ac-accent-utility)";
    default:
      return "var(--ac-accent-neutral)";
  }
};

/** Numeric (0xRRGGBB) family accent, for FX calls. */
export const familyAccentColor = (family: CardFamily): number => {
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

/** Thousands-separated score. */
export const fmtScore = (n: number): string => Math.round(n).toLocaleString("en-US");
