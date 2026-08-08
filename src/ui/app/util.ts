/* Small presentation helpers shared across components. */

import { COLORS, PLAYER_ACCENTS } from "../../theme";
import { CardFamily, CardRarity } from "../../game/types";
import type { AlphaChainSettings } from "../../game/types";

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

/** CSS custom-property name for a card's rarity color — tints the hover shine
 *  and the back-face rarity label. */
export const rarityAccentVar = (rarity: CardRarity): string => {
  switch (rarity) {
    case CardRarity.Uncommon:
      return "var(--ac-rarity-uncommon)";
    case CardRarity.Rare:
      return "var(--ac-rarity-rare)";
    case CardRarity.Legendary:
      return "var(--ac-rarity-legendary)";
    default:
      return "var(--ac-rarity-common)";
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

/** The per-tier deal-weight setting keys, derived from the settings interface so a renamed
 *  or added tier weight surfaces here as a type error rather than a silently missing row. */
export type RarityWeightKey = Extract<keyof AlphaChainSettings, `rarityWeight${string}`>;

/** The rarity deal-weight steppers, in tier order. Shared by both lobbies so the solo and
 *  multiplayer settings lists can't drift in labels or ordering. */
export const RARITY_WEIGHT_ROWS: readonly {
  key: RarityWeightKey;
  label: string;
  tier: CardRarity;
}[] = [
  { key: "rarityWeightCommon", label: "Common", tier: CardRarity.Common },
  { key: "rarityWeightUncommon", label: "Uncommon", tier: CardRarity.Uncommon },
  { key: "rarityWeightRare", label: "Rare", tier: CardRarity.Rare },
  { key: "rarityWeightLegendary", label: "Legendary", tier: CardRarity.Legendary },
];

/** A rarity deal-weight stepper's value text: the raw relative weight plus the share of
 *  draws it works out to, or "Never" at 0 (the tier is dropped from the deal pool). Shared
 *  by both lobbies so the solo and multiplayer readouts can't drift. `share` is a fraction
 *  in [0, 1], from `rarityDealShare`. */
export const rarityWeightValue = (weight: number, share: number): string => {
  if (weight <= 0) return "Never";
  const pct = Math.round(share * 100);
  return `${weight} (${pct === 0 ? "<1" : pct}%)`;
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
