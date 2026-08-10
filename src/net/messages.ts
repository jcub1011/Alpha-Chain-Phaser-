/*
 * The wire contract between the clients and the server authority. Alpha Chain runs
 * server-authoritative (GAME.json "serverAuthority"): clients send intents to the
 * sandboxed authority module and render the absolute-valued state it publishes back.
 * Everything crossing the boundary is tagged with `_kb` so each side knows what it
 * received (GAME_DEVELOPER_GUIDE §6).
 */

import type { MatchEvents } from "../game/match";
import type { AlphaChainSettings } from "../game/types";
import type { WireMatchState } from "./serialize";

/** Client → authority: an action validated against authoritative state. */
export type Intent =
  | { kind: "startMatch"; settings: AlphaChainSettings } // owner's start, looped through
  | { kind: "setSettings"; settings: AlphaChainSettings } // owner edits the pre-match lobby settings
  | { kind: "submit"; word: string }
  | { kind: "draftWord"; word: string } // current player's in-progress word, for timeout auto-submit
  | { kind: "reorderBay"; engine: string[]; discard: string[] }
  | { kind: "lockInOptimize" } // any player locking in fast-forwards the shared optimize dwell
  | { kind: "unlockOptimize" } // a locked-in player re-opening their engine while others finish
  | { kind: "sniperBan"; letter: string }
  | { kind: "tutorialReady" } // any player marking the current tutorial page read
  | { kind: "skipTutorial" }; // owner-only: skip the on-screen tutorial dwell

/** A match event serialized for replay on clients (payloads are already JSON-safe). */
export interface WireEvent<K extends keyof MatchEvents = keyof MatchEvents> {
  type: K;
  payload: MatchEvents[K];
}

/**
 * Absolute-expiry anchor for the visible countdowns, so clients display the correct
 * remaining time regardless of frame timing or how far they've lagged (instead of
 * accumulating per-frame drift). Each `*ExpiresAt` is a server `kb.now()` epoch-ms
 * instant — UTC, no timezone — and is non-null only when its phase is active. Clients
 * work in durations (`expiresAt − sentAt`) so the server↔client wall-clock difference
 * cancels (see NetMatch.applySnapshot).
 */
export interface ClockAnchor {
  /** Server `kb.now()` when the payload was built (epoch UTC ms). */
  sentAt: number;
  /** When the Round shot clock hits 0, or null outside Round. */
  clockExpiresAt: number | null;
  /** When the Tutorial/Intermission sub-timer hits 0, or null otherwise. */
  subTimerExpiresAt: number | null;
  /** When the pre-round Countdown hits 0, or null outside Countdown. */
  countdownExpiresAt: number | null;
}

/**
 * Authority → clients. The module returns this as an absolute-valued patch (broadcast
 * by the platform as `{_kb:"delta", patch}`) or as a full snapshot (`{_kb:"state",
 * state}`) — both carry the whole state, so the client applies either identically via
 * NetMatch.applySnapshot.
 */
export interface ServerStatePayload {
  state: WireMatchState;
  events: WireEvent[];
  clock: ClockAnchor;
}

/** The `_kb` envelope the platform relay uses in server-authoritative mode. Client →
 *  authority frames go out via peer.sendToHost; authority → client frames arrive as a
 *  `message` stamped `from: "server"`. */
export type KbEnvelope =
  | { _kb: "intent"; action: Intent }
  | { _kb: "sync" }
  | { _kb: "state"; state: ServerStatePayload }
  | { _kb: "delta"; patch: ServerStatePayload }
  | { _kb: "error"; message?: string };
