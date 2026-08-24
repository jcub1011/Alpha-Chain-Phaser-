/*
 * Player-facing copy for every submission rejection.
 *
 * Centralized here because BOTH input surfaces render it — <ac-word-entry> in Classic and
 * <ac-offer-grid> in Picker — and a copy in each is how the two drift. The `Record` is
 * exhaustive over `SubmitResult["reason"]`, so adding a rejection reason to the engine is a
 * compile error here until it has copy, which is the point.
 */

import type { SubmitResult } from "../../game/types";

export const REJECT_REASON: Record<NonNullable<SubmitResult["reason"]>, string> = {
  "not-a-word": "Not a word",
  "already-used": "Already played",
  "wrong-start-letter": "Wrong start letter",
  "too-short": "Too short",
  "prism-saved": "The Prism — clock refilled",
  // Picker / Word Builder only: the Offer / Tile Rack is the authority on what is playable
  "not-offered": "That word isn't on offer",
  "not-constructible": "Cannot be built from rack",
};
