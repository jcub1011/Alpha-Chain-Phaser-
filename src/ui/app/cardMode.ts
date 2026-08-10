/*
 * The mode whose card FACES are on screen.
 *
 * DISPLAY ONLY, and deliberately a separate channel from the engine's mode
 * (`MatchLike.effectiveMode` → `ScoreOptions.mode`): a wrong value here produces a wrong
 * SENTENCE, never a wrong SCORE. It lives under src/ui so src/game stays engine-pure and the
 * authority bundle never sees it.
 *
 * WHY AMBIENT RATHER THAN A THREADED PROPERTY. <ac-card> is a leaf reached through <ac-card-fan>,
 * <ac-engine-bay>, <ac-score-replay>, <ac-word-history>, <ac-intermission> and <ac-sandbox> — about
 * ten template sites. Lit template bindings are NOT type-checked (there is no lit-analyzer in this
 * build), so a forgotten `.mode=` would compile silently and be wrong only in Picker: the worst
 * failure shape available. One ambient value cannot be forgotten per-site, fixes every surface at
 * once including ones added later, and fails visibly (wrong prose everywhere) rather than subtly.
 *
 * PRECONDITION: no surface renders two modes' faces simultaneously. True today — the app shows one
 * match, and the Testing Bay's mode <select> holds one mode. <ac-card> still accepts a per-element
 * `mode` override, which is the escape hatch if a comparison view is ever built.
 */

import { Emitter } from "../../game/emitter";
import { GameMode } from "../../game/types";

/** Classic is the initial value because it is the catalogue's baseline — a card's base definition
 *  IS its Classic form, so before any match or bench exists, base copy is the honest thing to
 *  show. Both setters below fire before the first card is rendered. */
let displayMode: GameMode = GameMode.Classic;

export const cardModeEvents = new Emitter<{ changed: GameMode }>();

/** The mode <ac-card> renders copy for when no per-element override is set. */
export const cardDisplayMode = (): GameMode => displayMode;

/** Point every card face at `mode`. Call when a match or bench is created, or its mode changes. */
export function setCardDisplayMode(mode: GameMode): void {
  if (mode === displayMode) return;
  displayMode = mode;
  cardModeEvents.emit("changed", mode);
}
