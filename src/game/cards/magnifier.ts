/*
 * EffectMagnifier — the Magnifying Glass neighbor-amplifier registry
 * (alpha-chain-gdd.md §5.2), ported from EffectMagnifier.cs.
 *
 * A Magnifying Glass magnifies the card immediately to its right by ×1.5. The
 * registry is deliberately dumb: it only maps a target slot to an accumulated
 * product of factors. Stacking is NOT special-cased here — it emerges because
 * the bay is walked strictly left → right, so when a glass at slot i submits,
 * any magnification already applied to *itself* (from a glass at i-1) is read
 * back via getMagnification(i) and folded into what it pushes onto i+1. Thus
 * [Glass][Glass][card] lands ×2.25 on the one neighbor, [Glass]×3 → ×3.375.
 *
 * CRITICAL divergence from C#: the C# registry keys by card object identity
 * (distinct instances per slot). The TS CARD_LIBRARY holds shared singletons,
 * so this registry — and every "walk the bay up to self" helper in scoring.ts
 * — is keyed by SLOT INDEX instead.
 */

import type { ModifierCard } from "./card";

export class EffectMagnifier {
  private readonly factors = new Map<number, number>();

  /** Accumulate a magnification factor onto a target slot (products compound). */
  push(targetIndex: number, factor: number): void {
    this.factors.set(targetIndex, (this.factors.get(targetIndex) ?? 1) * factor);
  }

  /** The magnification applied to the card at `slotIndex` (1.0 = none). */
  getMagnification(slotIndex: number): number {
    return this.factors.get(slotIndex) ?? 1;
  }
}

/** Build the registry by walking the resolved bay left → right. */
export function buildMagnifier(bay: readonly (ModifierCard | undefined)[]): EffectMagnifier {
  const reg = new EffectMagnifier();
  bay.forEach((card, i) => card?.submitMagnifications?.(reg, i));
  return reg;
}
