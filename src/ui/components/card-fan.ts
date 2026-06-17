/*
 * Shared overlap math for the card fan. A fan lays its cards out left → right at a
 * fixed horizontal advance (`step`) so they always fit one line: spread out (with a
 * small gap) when there's room, compress into an overlap when there isn't. Used by
 * <ac-card-fan> and by <ac-score-replay>'s animated theater fan, which renders its
 * own cards but shares this spacing so the two read identically.
 */

/** Tightest spacing when compressed: still shows a readable sliver of each card. */
export const FAN_MIN_STEP = 24;
/** Extra spacing beyond a card's width when the fan has room to spread out. */
export const FAN_GAP = 10;

/** Horizontal advance per card so `count` cards of width `cardWidth` fit `fanWidth`:
 *  spread out when there's room, compress (overlap) when there isn't. */
export function fanStep(count: number, fanWidth: number, cardWidth: number): number {
  const max = cardWidth + FAN_GAP;
  if (count <= 1 || fanWidth <= 0) return max;
  const fit = (fanWidth - cardWidth) / (count - 1);
  return Math.max(FAN_MIN_STEP, Math.min(max, fit));
}
