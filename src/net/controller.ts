/*
 * The seam between gameplay and transport. The Phaser/Lit scenes talk only to a
 * GameController; they never touch the MatchController or the network directly.
 * LocalController (solo vs bots) drives a real MatchController; KnockBoxController
 * drives it host-authoritatively over the KnockBox network. Both expose the same
 * surface — and the scenes read `controller.match`, which on a guest is a
 * read-only mirror, so `match` is typed as the structural `MatchLike` supertype
 * both the real MatchController and the mirror satisfy.
 */

import type { Emitter } from "../game/emitter";
import type { MatchController, MatchEvents } from "../game/match";
import type { MatchState, PlayerState, SubmitResult } from "../game/types";

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
  /** Personal banned letters in force for a player this era (Toll Booth / Roulette Wheel). */
  personalBansFor(playerId: string): string[];
  /** Whether the player's own input should be masked while typing (Blindfold). */
  hidesInput(playerId: string): boolean;
  setPlayerBay(playerId: string, engineIds: string[], discardIds: string[]): void;
  applySniperBanAndAdvance(letter: string): void;
  randomBanLetter(): string;
  /** Skip the on-screen tutorial dwell (host / solo). */
  skipTutorial(): void;
  /** Fast-forward the optimize sub-phase (solo; no-op for guests). */
  skipOptimize(): void;
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

  /** Begin the match (Setup → Countdown). */
  start(): void;
  /** Advance real time (called from the scene's update loop). */
  tick(dtSeconds: number): void;
  /** Submit a word as the local human. */
  submitWord(word: string): SubmitResult;
  /** Tear down timers/listeners. */
  destroy(): void;
}
