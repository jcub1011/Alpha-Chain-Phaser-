/*
 * NetPeer — the transport surface shared by the real KnockBoxPlugin, the local-tab
 * KnockBoxLocalPeer, and the test FakePeer. ServerController talks only to this
 * interface, never to the addon directly.
 *
 * The `authority`/`ownerId`/`isOwner` trio arrived with plugin v0.2.0's
 * server-authoritative support: in server mode every client is `isHost: false`,
 * so lobby powers (start, settings, kick) gate on `isOwner`, not `isHost`.
 *
 * Deliberately narrower than the plugin: `sendToHost` is the only send. The plugin also
 * offers sendToAll/sendTo and setLobbyOpen, but under server authority this game has no
 * client-to-client chatter (the authority is the only publisher of state — the local peer
 * warns and drops a client-sent `delta`/`state`) and the join gate belongs to
 * `kb.setLobbyOpen` inside the authority module. Leaving them off the interface keeps
 * that a compile error rather than a subtle divergence from the real relay.
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
  /** Send a frame to the game's authority (the relay diverts `to:"host"` to the module). */
  sendToHost(payload: unknown): void;
  /** Records a Play Log entry on the player's KnockBox home page. Present on the real
   *  WebSocket plugin only; absent on the local-tab peer (calls are a no-op there). */
  logPlay?(metadata: Record<string, unknown>): void;
  /** Ships diagnostic lines to the server log (the addon's console-like logger). */
  log?: KnockBoxLogger;
}
