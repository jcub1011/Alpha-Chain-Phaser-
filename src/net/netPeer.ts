/*
 * NetPeer — the transport surface shared by the real KnockBoxPlugin, the local-tab
 * KnockBoxLocalPeer, and the test FakePeer. Both the legacy host-authoritative
 * controller and the server-authoritative ServerController talk only to this
 * interface, never to the addon directly.
 *
 * The `authority`/`ownerId`/`isOwner` trio arrived with plugin v0.2.0's
 * server-authoritative support: in server mode every client is `isHost: false`,
 * so lobby powers (start, settings, kick) gate on `isOwner`, not `isHost`.
 */

import type { KnockBoxLogger } from "../log";

export interface NetPeer {
  playerId: string | null;
  players: { id: string; displayName: string }[];
  /** True only for the authoritative host in host mode; ALWAYS false in server mode. */
  isHost: boolean;
  /** Who runs the game's authoritative logic. 'server' ⇒ the authority module runs server-side. */
  authority: "host" | "server";
  /** The member holding lobby powers (setLobbyOpen/kickPlayer); reassigned via kb.setOwner. */
  ownerId: string | null;
  /** Whether this player is the lobby owner. Gate owner-only UI on this, never on isHost. */
  isOwner: boolean;
  events: {
    on(event: string, fn: (...args: unknown[]) => void): unknown;
    off(event: string, fn: (...args: unknown[]) => void): unknown;
  };
  sendToHost(payload: unknown): void;
  sendToAll(payload: unknown): void;
  sendTo(playerId: string, payload: unknown): void;
  setLobbyOpen?(open: boolean): void;
  /** Records a Play Log entry on the player's KnockBox home page. Present on the real
   *  WebSocket plugin only; absent on the local-tab peer (calls are a no-op there). */
  logPlay?(metadata: Record<string, unknown>): void;
  /** Ships diagnostic lines to the server log (the addon's console-like logger). */
  log?: KnockBoxLogger;
}
