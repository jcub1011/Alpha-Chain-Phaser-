/*
 * The "Rarity Weights" lobby group — one stepper per tier, its share-of-a-draw readout, and
 * the warnings for configurations that can't supply the match.
 *
 * Lives here as a free function rather than a method on either lobby: <ac-lobby> and
 * <ac-net-lobby> render an identical group, and a copy in each is exactly how the solo and
 * multiplayer settings lists drift apart. Each lobby passes its OWN `stepper` (see
 * SettingControls), so the multiplayer copy still inherits the guest read-only disabling.
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
import type { SettingControls } from "./setting-controls";
import { SETTING_GROUP_HINTS } from "./settings-hints";

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

/**
 * Render the rarity group for a lobby. The clamp bounds live here beside the rows they bound,
 * rather than at the call site, so the two lobbies cannot pass different ones.
 *
 * The whole group is wrapped in `.set-group`, a full-width nested grid: `.set-subhead` spans
 * every column and so opens a row, and without a wrapper the settings that follow the group
 * in render order flow into that same row and read as rarity settings.
 *
 * The group's explanation is rendered once as `.set-groupdesc` rather than per row — see the
 * note in settings-hints.ts for why the four tiers share one.
 */
export const renderRarityWeights = (
  draft: AlphaChainSettings,
  c: SettingControls,
): TemplateResult => {
  const weights = rarityDealWeights(draft);
  // Both reads are MODE-SCOPED, and must stay that way: the dealer filters the pool by
  // `settings.gameMode`, so a mode-blind readout here would quietly advertise a capacity and a
  // per-tier share the dealer never uses — the warning would be wrong exactly when it matters.
  const share = rarityDealShare(weights, draft.gameMode);
  const capacity = dealPoolCapacity(weights, draft.gameMode);
  const requested = totalCardsDealtPerPlayer(draft);
  return html`
    <details class="set-group set-details">
      <summary class="set-summary">
        <span class="set-subhead">Rarity Weights</span>
        <span class="set-chevron" aria-hidden="true"></span>
      </summary>
      <div class="set-group-body">
        <!-- The mechanic is identical for all four tiers, so it is stated once
             here and the rows carry only their tier name. Each row's value still
             reports that tier's own share of a draw. -->
        <p class="set-groupdesc">${SETTING_GROUP_HINTS.rarityWeights}</p>
        <div class="set-rows">
          ${RARITY_WEIGHT_ROWS.map((r) =>
            c.stepper(
              r.label,
              rarityWeightValue(draft[r.key], share[r.tier]),
              () => c.step(r.key, -1, RARITY_WEIGHT_BOUNDS.min, RARITY_WEIGHT_BOUNDS.max),
              () => c.step(r.key, 1, RARITY_WEIGHT_BOUNDS.min, RARITY_WEIGHT_BOUNDS.max),
            ),
          )}
        </div>
        ${RARITY_WEIGHT_ROWS.every((r) => draft[r.key] <= 0)
          ? html`<p class="set-warn">Every tier is disabled — no cards will be dealt.</p>`
          : capacity < requested
            ? html`<p class="set-warn">
                The enabled tiers hold only ${capacity} cards per player, but this match deals
                ${requested} — once they run out, later intermissions deal nothing.
              </p>`
            : nothing}
      </div>
    </details>
  `;
};

/** The clamp bounds every rarity stepper shares: 0 (tier disabled) up to the persistence
 *  validator's ceiling. Applied by `renderRarityWeights` itself — exported for tests and for
 *  anything else that needs the editable range without re-deriving it. */
export const RARITY_WEIGHT_BOUNDS = { min: 0, max: MAX_RARITY_DEAL_WEIGHT } as const;
