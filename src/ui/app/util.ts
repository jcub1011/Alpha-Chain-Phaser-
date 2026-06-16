/* Small presentation helpers shared across components. */

import { COLORS, PLAYER_ACCENTS } from "../../theme";
import { CardFamily } from "../../game/types";

/** CSS custom-property name for a player's accent, by turn-order index. */
export const playerAccentVar = (index: number): string => `var(--ac-p${(index % 6) + 1})`;

/** Numeric (0xRRGGBB) player accent, for FX calls. */
export const playerAccentColor = (index: number): number =>
  PLAYER_ACCENTS[index % PLAYER_ACCENTS.length];

/** CSS custom-property name for a card family's accent. */
export const familyAccentVar = (family: CardFamily): string => {
  switch (family) {
    case CardFamily.Letter:
      return "var(--ac-accent-letter)";
    case CardFamily.Clock:
      return "var(--ac-accent-clock)";
    case CardFamily.Economy:
      return "var(--ac-accent-economy)";
    case CardFamily.Utility:
      return "var(--ac-accent-utility)";
    default:
      return "var(--ac-accent-neutral)";
  }
};

/** Numeric (0xRRGGBB) family accent, for FX calls. */
export const familyAccentColor = (family: CardFamily): number => {
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

/** Thousands-separated score. */
export const fmtScore = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A duration in ms as `m:ss` (e.g. 765000 → "12:45"). Clamps negatives to 0. */
export const fmtDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};
