/*
 * Turn-order arithmetic, shared by the engine and both input surfaces.
 *
 * Extracted because three places need the same answer and only two of them had it. The engine
 * advances the turn past eliminated seats, <ac-word-entry> walked past them to decide whether the
 * human was on deck, and <ac-word-builder> used a bare `(currentPlayerIndex + 1) % length` — so with
 * an eliminated seat in between, a player who was genuinely next was told they were not, and got no
 * standby warning before their turn opened.
 *
 * Pure and dependency-free: the engine bundle runs inside the Jint sandbox, and the UI imports it
 * from the browser.
 */

/** The next non-eliminated seat after `index`, and whether reaching it wrapped the round.
 *
 *  Takes seats structurally so the engine's PlayerState, the replicated mirror's, and a test double
 *  all satisfy it. When no other seat is live the walk completes a full cycle and comes back to
 *  `index` with `wrapped: true` — the caller decides what an all-eliminated table means, since for
 *  the engine that is game over and for a UI it is simply "nobody is on deck".
 */
export function nextLiveIndex(
  players: readonly { readonly eliminated?: boolean }[],
  index: number,
): { index: number; wrapped: boolean } {
  const n = players.length;
  if (n === 0) return { index, wrapped: false };

  let cur = index;
  let wrapped = false;
  for (let i = 0; i < n; i++) {
    const next = (cur + 1) % n;
    if (next <= cur) wrapped = true;
    cur = next;
    if (!players[next].eliminated) break;
  }
  return { index: cur, wrapped };
}
