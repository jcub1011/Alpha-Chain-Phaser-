/*
 * The seam between gameplay and transport. The Phaser scenes talk only to a
 * GameController; they never touch the MatchController or the network directly.
 * Today the only implementation is LocalController (solo vs bots). A future
 * KnockBoxController will implement the same interface on top of the addon in
 * addons/knockbox/ (KBAuthority, perRecipient fog-of-war) without changing any
 * scene code.
 */

import type { Emitter } from "../game/emitter";
import type { MatchController, MatchEvents } from "../game/match";
import type { SubmitResult } from "../game/types";

export interface GameController {
  /** The authoritative match state + rules (read-only access for scenes). */
  readonly match: MatchController;
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
