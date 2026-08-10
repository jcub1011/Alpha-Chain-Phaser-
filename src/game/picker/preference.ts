/*
 * Preference Cards — the family that shapes the Offer instead of scoring the word.
 *
 * THE LOAD-BEARING DESIGN DECISION: they occupy Engine Bay slots. There is no second engine. A
 * separate picker engine would be a strip of pure upside, and pure upside is not a decision.
 * Sharing the bay makes the whole family an extension of the Intermission Dilemma, and poses a
 * question with no correct answer — do I want the highest ceiling, or to be reliably offered good
 * words?
 *
 * DESIGN GUARDRAIL: these are shape constraints WITH A COST, not alignment buffs. A Preference Card
 * that is strictly good for its owner is mis-designed. "Only 6+ letter words" is a poor bonus and an
 * excellent glass cannon — it means you can never duck a Banned Letter with a short safe word.
 *
 * Only TYPES and pure helpers live here. The file is imported by `cards/card.ts` for the spec type
 * and by the Offer generator for the shaping type, so it must not import the card library — the
 * `ModifierCard` import below is type-only and erases at build time, which is what keeps the
 * authority bundle free of an import cycle.
 */

import { CardOp } from "../types";
import type { ModifierCard } from "../cards/card";

/** Everything a Preference Card needs to know about the turn beyond the word itself. */
export interface PreferenceContext {
  /** Every letter that would tax this player right now: the era Banned Letter (unless they are
   *  exempt), their personal card bans, and any hijack. Sentinel guarantees a clean word. */
  readonly bannedLetters: readonly string[];
}

export type WordPredicate = (word: string) => boolean;

/** How a card shapes the Offer. Presence of this on a `ModifierCard` is what makes it a Preference
 *  Card at all. */
export interface PreferenceSpec {
  /** Change to the number of Offer Cards (Wide Net +2, Tunnel Vision −2). */
  readonly countDelta?: number;
  /** A hard shape constraint on every Offer Card. Filters compose left → right and intersect;
   *  one that would drop the candidate pool below the Offer count is skipped ENTIRELY rather than
   *  partially applied, so the picker can never soft-lock. */
  filter?(ctx: PreferenceContext): WordPredicate | null;
  /** At least one Offer Card must satisfy this. Drawn before the rest, so it visibly costs a slot
   *  — which is the card's price, not a bug. */
  guarantee?(ctx: PreferenceContext): WordPredicate | null;
  /** A soft bias, honoured while the pool allows and then abandoned. Never blocks a full Offer. */
  prefer?(ctx: PreferenceContext): WordPredicate | null;
  /** Once-per-turn Offer redraw, priced as a fraction of the ARMED clock (Winnower). The price
   *  is fixed, so it grows harsher as your engine grows and each Offer takes longer to read. */
  readonly redraw?: { readonly clockCostFraction: number };
}

/**
 * Whether this card is hidden from bay-size scoring and bubbled to the left of the scoring chain.
 *
 * True for a Preference Card that is scoring-INERT. Such a card must not count toward bay length or
 * "cards to the right", or Dividend (+2 per card in your bay) and Booster Pack (+2 per card to its
 * right) would silently inflate — Booster Pack doubly so, since bubbling puts every Preference Card
 * to its left.
 *
 * TUNNEL VISION IS THE DELIBERATE EXCEPTION, and it is worth spelling out because the GDD's own
 * wording is self-contradictory there: it calls the card "FX" while giving it "×1.4 always". It
 * cannot be both. Treating it as inert would mean either (a) filtering it out of the scoring bay, so
 * its fold never runs and the ×1.4 simply does not exist, or (b) bubbling it to the far left, where
 * a multiplier scales almost nothing because the fold is strictly left → right. Both delete the
 * card. So Tunnel Vision is modelled as what its EFFECT says — a real multiplier, placed and counted
 * like any other — whose COST is the −2 Offer Cards. Every other clause of the family still applies
 * to it; only the invisibility and the bubbling do not.
 */
export function isInertPreference(card: ModifierCard | undefined): boolean {
  return !!card?.preference && card.op === CardOp.Fx;
}

/**
 * Stable partition: inert Preference Cards first, everything else keeping its relative order.
 *
 * This is the bubbling rule, and it is NOT cosmetic. The Magnifying Glass magnifies whatever sits
 * immediately to its right (`reg.push(i + 1, …)`, with no card-type check anywhere), so a
 * hand-placed Preference Card could silently swallow a glass. Bubbling makes that impossible rather
 * than merely punishing: every glass sits at some index `i` among the scoring cards, and `i + 1`
 * can never land back inside the preference block to its left.
 *
 * Scoring cards keep their relative order, so bubbling can never change what a word scores.
 *
 * Generic over the item type because the engine reorders `BayCard`s while the optimize UI reorders
 * bare uid strings — and the two MUST agree, or the client would present an order the authority
 * then rewrites under the player's hands.
 */
export function bubblePreferences<T>(items: readonly T[], isInert: (item: T) => boolean): T[] {
  const preference: T[] = [];
  const scoring: T[] = [];
  for (const item of items) (isInert(item) ? preference : scoring).push(item);
  return [...preference, ...scoring];
}

/** A hard constraint, tagged with the card that imposed it so a skip can be reported. */
export interface OfferFilter {
  readonly cardId: string;
  readonly accepts: WordPredicate;
}

/** The resolved shaping for one turn: everything the generator needs, with no card knowledge. */
export interface OfferShaping {
  /** In bay order, left → right. Order is player-controlled and meaningful. */
  readonly filters: readonly OfferFilter[];
  /** Each costs one Offer slot, drawn before the general fill. */
  readonly guarantees: readonly OfferFilter[];
  /** Soft bias, or null. */
  readonly prefer: WordPredicate | null;
  /** Net change to the Offer count. */
  readonly countDelta: number;
}

export const NO_SHAPING: OfferShaping = {
  filters: [],
  guarantees: [],
  prefer: null,
  countDelta: 0,
};

/**
 * Resolve a player's bay into one turn's shaping.
 *
 * `cards` is the bay's resolved cards in BAY ORDER — left → right is the composition order the
 * player controls, and it is preserved here because it decides which filter is dropped first when
 * the pool cannot satisfy them all.
 *
 * Multiple `prefer`s are intersected: two soft biases both apply while the pool allows.
 */
export function buildOfferShaping(
  cards: readonly (ModifierCard | undefined)[],
  ctx: PreferenceContext,
): OfferShaping {
  const filters: OfferFilter[] = [];
  const guarantees: OfferFilter[] = [];
  const prefers: WordPredicate[] = [];
  let countDelta = 0;

  for (const card of cards) {
    const spec = card?.preference;
    if (!card || !spec) continue;
    countDelta += spec.countDelta ?? 0;
    const filter = spec.filter?.(ctx);
    if (filter) filters.push({ cardId: card.id, accepts: filter });
    const guarantee = spec.guarantee?.(ctx);
    if (guarantee) guarantees.push({ cardId: card.id, accepts: guarantee });
    const prefer = spec.prefer?.(ctx);
    if (prefer) prefers.push(prefer);
  }

  return {
    filters,
    guarantees,
    prefer: prefers.length === 0 ? null : (w) => prefers.every((p) => p(w)),
    countDelta,
  };
}
