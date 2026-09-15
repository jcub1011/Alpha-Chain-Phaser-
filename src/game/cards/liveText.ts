/*
 * Live engine-card faces. The catalogue (`library.ts`) holds STATIC copy — one
 * chip + description per card per mode — and each card additionally owns a
 * `renderText` template: the `fold` twin for READING, interpolating the same
 * numbers over the display context (glass magnification, bay counts, streak,
 * guard charges, rolled bans). This module is the seam between the two: it
 * derives the per-slot context (bay position, glass chain, bay-size counts)
 * from caller-supplied primitives, hands it to the card's template, and
 * applies the generic staged-word projection on top.
 *
 * DISPLAY ONLY. Every value here is a pre-read primitive (numbers/booleans),
 * never a RoomService — so a networked guest feeds it from snapshot fields and
 * can never mutate host state through it. When no context is available (sandbox
 * palette, legacy history entries) the resolver returns the static catalogue
 * copy unchanged.
 *
 * The same resolver backs live bays AND frozen history playback: a Submission
 * stores the primitives (magnification, streak, guard states) captured at score
 * time, and the replay renders them through here — so faces and live text can
 * never disagree by construction.
 */

import { getCard, cardIdentity } from "./library";
import { isInertPreference } from "../picker/preference";
import { CardOp, GameMode } from "../types";
import type { CardFaceText, CardRenderContext } from "./card";

/** Everything the face of one card needs, pre-read by the caller. */
export interface LiveCardCtx {
  mode: GameMode;
  /** Full bay in slot order (ids). Needed for Flywheel / Booster / Dividend counts. */
  bayIds: readonly string[];
  /** This card's slot index. */
  index: number;
  /** Magnifying-Glass factor on this slot (1.0 = none). */
  magnification: number;
  /** Owner's bay slot capacity (Booster Pack scales by it). */
  slots: number;
  /** Consecutive clean words this era (Crescendo). */
  streak: number;
  wildcardAvailable: boolean;
  /** The scored word consumed the Wildcard charge (playback only). */
  wildcardUsed?: boolean;
  prismAvailable: boolean;
  winnowerAvailable: boolean;
  /** Personal ban this card instance rolled (Roulette / Toll Booth). */
  personalBan?: string;
  /** Projected step outcome for a staged/typed word (exact, mag included). */
  previewValueText?: string;
  previewTriggered?: boolean;
}

/** Display copy for one card face. */
export type LiveCardText = CardFaceText;

/** Scoring cards in the bay (inert Preference Cards are invisible to bay-size
 *  scoring — the same masking `makeBayEvaluator` applies, so the numbers here
 *  match the fold exactly). */
function scoringMask(bayIds: readonly string[]): boolean[] {
  return bayIds.map((id) => !isInertPreference(cardIdentity(id)));
}

function scoringCount(bayIds: readonly string[]): number {
  return scoringMask(bayIds).reduce((sum, n) => sum + (n ? 1 : 0), 0);
}

function scoringRightOf(bayIds: readonly string[], index: number): number {
  const mask = scoringMask(bayIds);
  let n = 0;
  for (let i = index + 1; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function otherMultipliers(bayIds: readonly string[], index: number): number {
  return bayIds.filter((id, i) => i !== index && cardIdentity(id)?.op === CardOp.Multiplicative)
    .length;
}

export function describeCardLive(id: string, mode: GameMode, ctx?: LiveCardCtx): LiveCardText {
  const card = getCard(id, mode);
  if (!card) return { magnitudeText: "?", description: "Unknown card." };
  if (!ctx) return { magnitudeText: card.magnitudeText, description: card.description };

  // The card owns its resting face; a card without a template renders static.
  const renderCtx: CardRenderContext = {
    magnification: ctx.magnification,
    streak: ctx.streak,
    slots: ctx.slots,
    cardsToRight: scoringRightOf(ctx.bayIds, ctx.index),
    scoringCount: scoringCount(ctx.bayIds),
    otherMultipliers: otherMultipliers(ctx.bayIds, ctx.index),
    wildcardAvailable: ctx.wildcardAvailable,
    wildcardUsed: ctx.wildcardUsed,
    prismAvailable: ctx.prismAvailable,
    winnowerAvailable: ctx.winnowerAvailable,
    personalBan: ctx.personalBan,
    previewValueText: ctx.previewValueText,
    previewTriggered: ctx.previewTriggered,
  };
  const face: LiveCardText = card.renderText?.(renderCtx) ?? {
    magnitudeText: card.magnitudeText,
    description: card.description,
  };
  // A staged/typed word fired this card: the exact step outcome (glass already
  // baked in) replaces whatever the resting template computed — uniformly, so
  // no template repeats this branch.
  if (ctx.previewTriggered === true && ctx.previewValueText) {
    return { ...face, magnitudeText: ctx.previewValueText };
  }
  return face;
}
