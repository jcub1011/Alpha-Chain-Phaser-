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
  | { kind: "reorderBay"; order: string[] }
  | { kind: "sniperBan"; letter: string }
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
  /** Turn-clock anchor so guests run a smooth local countdown (see controller). */
  serverClock: { currentPlayerIndex: number; clockTotal: number; clockRemaining: number };
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
