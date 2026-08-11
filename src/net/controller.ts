/*
 * The seam between gameplay and transport. The Phaser/Lit scenes talk only to a
 * GameController; they never touch the MatchController or the network directly.
 * LocalController (solo vs bots) drives a real MatchController; ServerController
 * mirrors the one the server authority drives. Both expose the same surface — and
 * the scenes read `controller.match`, which on a networked client is a read-only
 * mirror, so `match` is typed as the structural `MatchLike` supertype both the real
 * MatchController and the mirror satisfy.
 */

import type { Emitter } from "../game/emitter";
import type { MatchController, MatchEvents } from "../game/match";
import type { GameMode, MatchState, PlayerState, SubmitResult } from "../game/types";

/** The subset of MatchController the presentation layer reads + mutates. The
 *  real MatchController satisfies this structurally; the guest mirror implements
 *  it explicitly (routing mutators to host intents). */
export interface MatchLike {
  readonly state: MatchState;
  readonly events: Emitter<MatchEvents>;
  readonly current: PlayerState;
  standings(): PlayerState[];
  computeLastPlaceId(): string;
  isExempt(player: PlayerState): boolean;
  /** Personal banned letters in force for a player this era (Toll Booth / Roulette
   *  Wheel), each tagged with the card that rolled it. */
  personalBansFor(playerId: string): { letter: string; cardName: string }[];
  /** The mode whose CARD VALUES this match uses. The single mode accessor for the presentation
   *  layer — never read `state.settings.gameMode` to resolve a card, because a Picker match that
   *  fell back for want of a word pool scores on Classic's values. */
  readonly effectiveMode: GameMode;
  /** Whether the player's own input should be masked while typing (Blindfold). */
  hidesInput(playerId: string): boolean;
  /** Commit a player's bay split. The arrays hold per-card uids (BayCard.uid),
   *  not card ids, so duplicate cards stay distinct. */
  setPlayerBay(playerId: string, engineUids: string[], discardUids: string[]): void;
  applySniperBanAndAdvance(letter: string): void;
  randomBanLetter(): string;
  /** Skip the on-screen tutorial dwell (host / solo). */
  skipTutorial(): void;
  /** Mark the current tutorial page read for a player; auto-advances once all are ready. */
  markTutorialReady(playerId: string): void;
  /** Fast-forward the optimize sub-phase (solo; no-op for guests). */
  skipOptimize(): void;
  /** Re-open a locked-in engine while waiting on other players (multiplayer). */
  unlockOptimize(): void;
}

// Compile-time assertion that MatchController is a MatchLike (no runtime cost).
export type _AssertMatchControllerIsMatchLike = MatchController extends MatchLike ? true : never;

export interface GameController {
  /** The authoritative match state + rules (read-only access for scenes). */
  readonly match: MatchLike;
  /** Networking events the scenes subscribe to (re-exposed from the match). */
  readonly events: Emitter<MatchEvents>;
  /** The local human player's id. */
  readonly humanId: string;
  /** Whether this client holds the lobby powers — the shared-state actions the authority
   *  accepts from one player only (skipping the tutorial dwell for everyone, starting the
   *  match, editing settings). Always true in solo, where there is nobody to share with.
   *
   *  Declared here rather than sniffed off the concrete controller so gating it is a type
   *  error to get wrong: a UI that probed for a property name instead silently fell open
   *  to every player when the server migration renamed host → owner. */
  readonly isOwner: boolean;

  /** Begin the match (Setup → Countdown). */
  start(): void;
  /** Advance real time (called from the scene's update loop). */
  tick(dtSeconds: number): void;
  /** Submit a word as the local human. */
  submitWord(word: string): SubmitResult;
  /** Report the local human's in-progress word so a shot-clock timeout can auto-submit
   *  it (networked play streams it to the host; solo is a no-op — the UI handles it). */
  reportDraft(word: string): void;
  /** Picker: report which Offer word the local human has selected, so a clock expiry commits it
   *  rather than counting as a no-show. Unlike `reportDraft` this is NOT a solo no-op: selections
   *  are discrete and rare, so the engine owns the expiry commit in both solo and networked play
   *  and stays the single authority on what a no-show is. */
  reportSelection(word: string): void;
  /** Picker: commit the selected Offer word (second tap, or the GO button). */
  commitSelection(word?: string): SubmitResult;
  /** Picker: Winnower's once-per-turn Offer redraw, bought with shot clock. */
  redrawOffer(): void;
  /** Tear down timers/listeners. */
  destroy(): void;
}
