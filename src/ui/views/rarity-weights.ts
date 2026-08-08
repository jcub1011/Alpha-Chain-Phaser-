/*
 * The "Rarity Weights" lobby group — one stepper per tier, its share-of-a-draw readout, and
 * the warnings for configurations that can't supply the match.
 *
 * Lives here as a free function rather than a method on either lobby: <ac-lobby> and
 * <ac-net-lobby> render an identical group, and a copy in each is exactly how the solo and
 * multiplayer settings lists drift apart. Each lobby passes its OWN `stepper`, so the
 * multiplayer copy still inherits the guest read-only disabling.
 */

import { html, nothing, type TemplateResult } from "lit";
import { CardRarity } from "../../game/types";
import type { AlphaChainSettings, RarityWeightKey } from "../../game/types";
import {
  MAX_RARITY_DEAL_WEIGHT,
  RARITY_WEIGHT_KEYS,
  rarityDealWeights,
  totalCardsDealtPerPlayer,
} from "../../game/settings";
import { dealPoolCapacity, rarityDealShare } from "../../game/cards/library";
import { SETTING_HINTS } from "./settings-hints";

/** Display name per tier. CardRarity's values are lowercase wire strings ("common"), which
 *  the card back renders verbatim; the lobby wants them title-cased. */
export const RARITY_LABELS: Record<CardRarity, string> = {
  [CardRarity.Common]: "Common",
  [CardRarity.Uncommon]: "Uncommon",
  [CardRarity.Rare]: "Rare",
  [CardRarity.Legendary]: "Legendary",
};

/** The rarity deal-weight steppers, in tier order. Derived from the tier-keyed maps rather
 *  than listed, so a new tier can't compile without also getting a row. */
export const RARITY_WEIGHT_ROWS: readonly {
  key: RarityWeightKey;
  label: string;
  tier: CardRarity;
}[] = Object.values(CardRarity).map((tier) => ({
  key: RARITY_WEIGHT_KEYS[tier],
  label: RARITY_LABELS[tier],
  tier,
}));

/** A rarity deal-weight stepper's value text: the raw relative weight plus the share of
 *  draws it works out to, or "Never" at 0 (the tier is dropped from the deal pool).
 *  `share` is a fraction in [0, 1], from `rarityDealShare`. */
export const rarityWeightValue = (weight: number, share: number): string => {
  if (weight <= 0) return "Never";
  const pct = Math.round(share * 100);
  return `${weight} (${pct === 0 ? "<1" : pct}%)`;
};

/** A lobby's stepper renderer (both lobbies expose this shape; the multiplayer one also
 *  disables its buttons for guests). */
export type SettingStepper = (
  label: string,
  value: string,
  onMinus: () => void,
  onPlus: () => void,
  hint?: string,
) => TemplateResult;

/**
 * Render the rarity group for a lobby. `step` applies a delta to one weight key (the caller
 * owns the clamp bounds it shares with every other stepper).
 *
 * The whole group is wrapped in `.set-group`, a full-width nested grid: `.set-subhead` spans
 * every column and so opens a row, and without a wrapper the settings that follow the group
 * in render order flow into that same row and read as rarity settings.
 */
export const renderRarityWeights = (
  draft: AlphaChainSettings,
  step: (key: RarityWeightKey, delta: number) => void,
  stepper: SettingStepper,
): TemplateResult => {
  const weights = rarityDealWeights(draft);
  const share = rarityDealShare(weights);
  const capacity = dealPoolCapacity(weights);
  const requested = totalCardsDealtPerPlayer(draft);
  return html`
    <div class="set-group">
      <p class="set-subhead">Rarity Weights</p>
      ${RARITY_WEIGHT_ROWS.map((r) =>
        stepper(
          r.label,
          rarityWeightValue(draft[r.key], share[r.tier]),
          () => step(r.key, -1),
          () => step(r.key, 1),
          SETTING_HINTS[r.key],
        ),
      )}
      ${RARITY_WEIGHT_ROWS.every((r) => draft[r.key] <= 0)
        ? html`<p class="set-warn">Every tier is disabled — no cards will be dealt.</p>`
        : capacity < requested
          ? html`<p class="set-warn">
              The enabled tiers hold only ${capacity} cards per player, but this match deals
              ${requested} — once they run out, later intermissions deal nothing.
            </p>`
          : nothing}
    </div>
  `;
};

/** The clamp bounds every rarity stepper shares: 0 (tier disabled) up to the persistence
 *  validator's ceiling. Re-exported so a lobby's `step` call doesn't have to import it
 *  from the engine separately. */
export const RARITY_WEIGHT_BOUNDS = { min: 0, max: MAX_RARITY_DEAL_WEIGHT } as const;
