/*
 * Live engine-card faces. The catalogue (`library.ts`) holds STATIC copy — one
 * chip + description per card per mode — but a card's real magnitude depends on
 * its bay position (Magnifying Glass chain), its owner's slot count (Booster
 * Pack), the other multipliers around it (Flywheel), and room state that moves
 * every turn (Crescendo streak, once-per-era/turn guards, rolled personal
 * bans). This module resolves the DISPLAY copy for one card in one bay: the
 * chip, the description, and an optional state badge (READY / SPENT / STREAK).
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
export interface LiveCardText {
  magnitudeText: string;
  description: string;
  /** State pill, e.g. "READY", "SPENT", "STREAK 2", "USED". Omitted when N/A. */
  badge?: string;
  /** True when the charge is spent (lets the face dim the card). */
  spent?: boolean;
  /** True when a glass magnifies this slot (face shows the ×N glass chip). */
  magnified?: boolean;
  /** The glass factor (set when magnified), for the ×N chip. */
  magFactor?: number;
}

/** Round for DISPLAY (per-letter steps are 0.1; glass stacking yields float dust). */
const round1 = (n: number): number => Math.round(n * 10) / 10;
const fmt2 = (n: number): string => `${Math.round(n * 100) / 100}`;

const isMag = (magnification: number): boolean => magnification > 1.001;

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

function describeCardInner(id: string, mode: GameMode, ctx?: LiveCardCtx): LiveCardText {
  const card = getCard(id, mode);
  if (!card) return { magnitudeText: "?", description: "Unknown card." };
  if (!ctx) return { magnitudeText: card.magnitudeText, description: card.description };

  const mag = ctx.magnification;
  const magnified = isMag(mag);
  const previewHit = ctx.previewTriggered === true && !!ctx.previewValueText;
  // A projected step outcome already bakes the glass in — prefer it whenever the
  // staged/typed word actually fires this card.
  const projected = (resting: string): string => (previewHit ? ctx.previewValueText! : resting);

  switch (id) {
    case "Crescendo": {
      const factor = ctx.streak > 0 ? Math.min(2, 1 + 0.25 * ctx.streak) : 1;
      const next = Math.min(2, 1 + 0.25 * (ctx.streak + 1));
      return {
        magnitudeText: projected(`×${fmt2(factor)}`),
        description:
          `${card.description} Streak ${ctx.streak}` +
          (ctx.streak > 0 ? ` (next word ×${fmt2(next)}).` : " — play clean to start it."),
        badge: `STREAK ${ctx.streak}`,
        magnified,
      };
    }

    case "Wildcard": {
      if (ctx.wildcardUsed) {
        return {
          magnitudeText: card.magnitudeText,
          description: `${card.description} Used by this word.`,
          badge: "USED",
          magnified,
        };
      }
      const ready = ctx.wildcardAvailable;
      return {
        magnitudeText: card.magnitudeText,
        description: `${card.description} ${ready ? "Charge available." : "Spent this era."}`,
        badge: ready ? "READY" : "SPENT",
        spent: !ready,
        magnified,
      };
    }

    case "Prism": {
      const ready = ctx.prismAvailable;
      return {
        magnitudeText: card.magnitudeText,
        description: `${card.description} ${ready ? "Charge available." : "Spent this era."}`,
        badge: ready ? "READY" : "SPENT",
        spent: !ready,
        magnified,
      };
    }

    case "Winnower": {
      const ready = ctx.winnowerAvailable;
      return {
        magnitudeText: card.magnitudeText,
        description: `${card.description} ${ready ? "Redraw available." : "Spent this turn."}`,
        badge: ready ? "READY" : "SPENT",
        spent: !ready,
        magnified,
      };
    }

    case "BoosterPack": {
      const right = scoringRightOf(ctx.bayIds, ctx.index);
      return {
        magnitudeText: projected(`+${2 * right * ctx.slots}`),
        description:
          right > 0
            ? `${card.description} (${right} right × ${ctx.slots} slots = +${2 * right * ctx.slots}).`
            : `${card.description} (no cards to its right).`,
        magnified,
      };
    }

    case "Dividend": {
      const count = scoringCount(ctx.bayIds);
      return {
        magnitudeText: projected(`+${2 * count}`),
        description: `${card.description} (${count} cards = +${2 * count}).`,
        magnified,
      };
    }

    case "TheFlywheel": {
      const others = otherMultipliers(ctx.bayIds, ctx.index);
      if (others === 0) {
        return {
          magnitudeText: "—",
          description: `${card.description} (no other multipliers in your bay).`,
          magnified,
        };
      }
      const factor = Math.min(2.3, round1(1 + 0.15 * others));
      return {
        magnitudeText: projected(`×${fmt2(factor)}`),
        description: `${card.description} (${others} other multiplier${others === 1 ? "" : "s"}).`,
        magnified,
      };
    }

    case "RouletteWheel":
    case "TollBooth": {
      return {
        magnitudeText: projected(card.magnitudeText),
        description: ctx.personalBan
          ? `${card.description} (ban: ${ctx.personalBan.toUpperCase()}).`
          : card.description,
        magnified,
      };
    }

    case "Forgery": {
      return {
        magnitudeText: card.magnitudeText,
        description: magnified
          ? `${card.description} (magnified ×${fmt2(mag)}).`
          : card.description,
        magnified,
      };
    }

    default: {
      return {
        magnitudeText: projected(card.magnitudeText),
        description: card.description,
        magnified,
      };
    }
  }
}

export function describeCardLive(id: string, mode: GameMode, ctx?: LiveCardCtx): LiveCardText {
  const out = describeCardInner(id, mode, ctx);
  // The glass factor rides alongside (the chip needs the number, not just the flag).
  if (ctx && out.magnified) out.magFactor = ctx.magnification;
  return out;
}
