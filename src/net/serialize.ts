/*
 * Wire (de)serialization for the host-authoritative snapshot. MatchState is
 * almost JSON-safe; the only non-serializable field is `usedWords` (a Set), so
 * we round-trip it through an array. We deep-clone via JSON so a snapshot is a
 * self-contained value that never aliases the host's live state (important for
 * the in-process local-test transport, which may pass references).
 */

import type { MatchState } from "../game/types";

/** MatchState with `usedWords` as a JSON-safe array. */
export type WireMatchState = Omit<MatchState, "usedWords"> & { usedWords: string[] };

export function serializeState(state: MatchState): WireMatchState {
  const { usedWords, ...rest } = state;
  // Deep clone the plain fields so the snapshot can't alias live host state.
  const cloned = JSON.parse(JSON.stringify(rest)) as Omit<MatchState, "usedWords">;
  return { ...cloned, usedWords: [...usedWords] };
}

export function deserializeState(wire: WireMatchState): MatchState {
  const { usedWords, ...rest } = wire;
  return { ...rest, usedWords: new Set(usedWords) };
}
