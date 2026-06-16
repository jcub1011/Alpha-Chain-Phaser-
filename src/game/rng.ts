/*
 * Small randomness helpers shared across game logic. All take an injectable RNG
 * (`() => number` in [0, 1)) so callers can supply a deterministic source for
 * tests and the network host can drive a controlled stream.
 */

/** An RNG that makes `shuffle` a no-op — every element keeps its position. For
 *  deterministic harnesses/tests that need the input order preserved while still
 *  routing through the same shuffle path production uses. */
export const orderPreservingRng = (): number => 1 - Number.EPSILON;

/** Fisher-Yates shuffle. Returns a new array; does not mutate the input. */
export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
