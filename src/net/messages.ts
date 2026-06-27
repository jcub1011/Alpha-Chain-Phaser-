/*
 * The wire contract between the host and guests. The KnockBox server is a blind
 * relay; these are the payloads Alpha Chain sends through it. Everything is
 * tagged with `t` so each side knows what it received (GAME_DEVELOPER_GUIDE §6).
 */

import type { MatchEvents } from "../game/match";
import type { AlphaChainSettings } from "../game/types";
import type { WireMatchState } from "./serialize";

/** Guest → host: an action the host validates against authoritative state. */
export type Intent =
  | { kind: "startMatch"; settings: AlphaChainSettings } // host's own start, looped through
  | { kind: "submit"; word: string }
  | { kind: "draftWord"; word: string } // current player's in-progress word, for timeout auto-submit
  | { kind: "reorderBay"; engine: string[]; discard: string[] }
  | { kind: "lockInOptimize" } // any player locking in fast-forwards the shared optimize dwell
  | { kind: "unlockOptimize" } // a locked-in player re-opening their engine while others finish
  | { kind: "sniperBan"; letter: string }
  | { kind: "tutorialReady" } // any player marking the current tutorial page read
  | { kind: "skipTutorial" }; // host-only: skip the on-screen tutorial dwell

/** A match event serialized for replay on guests (payloads are already JSON-safe). */
export interface WireEvent<K extends keyof MatchEvents = keyof MatchEvents> {
  type: K;
  payload: MatchEvents[K];
}

/** Host → all: the authoritative snapshot + the events to replay since the last one. */
export interface SnapshotMsg {
  t: "snap";
  state: WireMatchState;
  events: WireEvent[];
  /** The host's player id, so guests can detect a host departure authoritatively. */
  hostId: string;
  /**
   * Absolute-expiry anchor for the visible countdowns, so clients display the
   * correct remaining time regardless of frame timing or how far they've lagged
   * (instead of accumulating per-frame drift). Each `*ExpiresAt` is a host
   * `Date.now()` epoch-ms instant — UTC, no timezone — and is non-null only when
   * its phase is active. Clients work in durations (`expiresAt − sentAt`) so the
   * host↔client wall-clock difference cancels (see NetMatch.applySnapshot).
   */
  clock: {
    /** Host `Date.now()` when this snapshot was built (epoch UTC ms). */
    sentAt: number;
    /** When the Round shot clock hits 0, or null outside Round. */
    clockExpiresAt: number | null;
    /** When the Tutorial/Intermission sub-timer hits 0, or null otherwise. */
    subTimerExpiresAt: number | null;
    /** When the pre-round Countdown hits 0, or null outside Countdown. */
    countdownExpiresAt: number | null;
  };
}

/** Guest → host on (re)entry: "send me the current state." */
export interface SyncMsg {
  t: "sync";
}

/** Guest → host: an intent. */
export interface IntentMsg {
  t: "intent";
  action: Intent;
}

export type NetMessage = SnapshotMsg | SyncMsg | IntentMsg;
