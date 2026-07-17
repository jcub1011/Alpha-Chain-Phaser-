/*
 * ServerController — the server-authoritative GameController. It is the client half
 * of the migration off host authority: the game's rules run in the sandboxed server
 * authority module (src/server/authority.ts), and EVERY client (this one included)
 * is a pure guest that renders from a local NetMatch mirror fed by the server's
 * broadcasts.
 *
 * Wire: intents go out via peer.sendToHost as `{_kb:"intent", action}` (the relay
 * routes them to the authority); the authority's absolute-valued state arrives as a
 * `message` stamped `from: "server"` (`{_kb:"state"|"delta"}`). There is no local
 * MatchController and no host tick loop — the server owns the clock; this client
 * only interpolates the visible countdowns between snapshots.
 *
 * Owner ≠ host: in server mode peer.isHost is always false. Lobby powers (start the
 * match, edit settings) gate on peer.isOwner; the authority reassigns the owner via
 * kb.setOwner when the current owner leaves, so the session survives their departure.
 */

import type { AlphaChainSettings, PlayerState, SubmitResult } from "../game/types";
import { createLogger } from "../log";
import type { GameController, MatchLike } from "./controller";
import type { Intent, KbEnvelope, ServerStatePayload } from "./messages";
import { NetMatch } from "./netMatch";
import type { NetPeer } from "./netPeer";

const log = createLogger("net");

/** The reserved sender id the platform stamps on authoritative broadcasts. */
const SERVER_ID = "server";

export class ServerController implements GameController {
  readonly match: MatchLike;
  private readonly mirror: NetMatch;
  private lobbyCbs: (() => void)[] = [];
  private sessionEndedCbs: ((reason: string) => void)[] = [];
  private ended = false;

  constructor(
    private readonly peer: NetPeer,
    /** Monotonic clock (ms) for the mirror's anchor-based countdowns. Injectable for
     *  deterministic tests; production uses performance.now. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.mirror = new NetMatch((intent) => this.dispatch(intent), this.now);
    this.match = this.mirror;
    this.mirror.events.on("gameOver", this.onGameOver);
    peer.events.on("ready", this.onReady);
    peer.events.on("message", this.onMessage);
    peer.events.on("player-joined", this.onRoster);
    peer.events.on("player-left", this.onRoster);
    peer.events.on("owner-changed", this.onRoster);
    peer.events.on("closed", this.onClosed);
    peer.events.on("resumed", this.onResumed);
  }

  get events(): MatchLike["events"] {
    return this.mirror.events;
  }
  get humanId(): string {
    return this.peer.playerId ?? "";
  }
  /** Whether this player holds the lobby powers (start / settings). Gate owner-only UI
   *  on this, never on isHost (always false in server mode). */
  get isOwner(): boolean {
    return this.peer.isOwner;
  }
  /** The lobby roster (for the pre-match waiting surface). */
  get roster(): { id: string; displayName: string }[] {
    return this.peer.players;
  }
  /** The current lobby owner's id (for marking them in the roster). */
  get ownerId(): string | null {
    return this.peer.ownerId;
  }
  /** The current lobby settings — the authority's working copy, mirrored via snapshots. */
  get lobbySettings(): AlphaChainSettings | undefined {
    return this.mirror.state.settings;
  }
  /** Whether a match has begun (vs. still in the lobby). */
  get inMatch(): boolean {
    return this.mirror.state.players.length > 0;
  }

  /** Subscribe to lobby/roster/owner/settings changes for the waiting UI. */
  onLobbyChange(cb: () => void): () => void {
    this.lobbyCbs.push(cb);
    return () => (this.lobbyCbs = this.lobbyCbs.filter((c) => c !== cb));
  }
  private notifyLobby(): void {
    this.lobbyCbs.slice().forEach((c) => c());
  }

  /** Subscribe to a terminal session end (socket closed for good). Unlike host mode,
   *  the session no longer ends when the creator leaves — the server keeps running. */
  onSessionEnded(cb: (reason: string) => void): () => void {
    this.sessionEndedCbs.push(cb);
    return () => (this.sessionEndedCbs = this.sessionEndedCbs.filter((c) => c !== cb));
  }
  private endSession(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    log.warn(`session ended: ${reason}`);
    this.sessionEndedCbs.slice().forEach((c) => c(reason));
  }

  /** Owner-only: publish the working lobby settings to the authority so every client's
   *  read-only lobby reflects the owner's live choices before the match starts. No-op
   *  for non-owners (the authority also re-checks fromId === ownerId). */
  setLobbySettings(settings: AlphaChainSettings): void {
    if (!this.peer.isOwner) return;
    this.dispatch({ kind: "setSettings", settings });
  }

  // ── GameController ──────────────────────────────────────────────────────────
  /** Owner-only: begin a match with the given settings. */
  startMatch(settings: AlphaChainSettings): void {
    this.dispatch({ kind: "startMatch", settings });
  }

  start(): void {
    // No-op: the match begins when the owner calls startMatch().
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    // The server owns the authoritative clock + timeouts; this client only smooths the
    // visible countdowns from the last snapshot's absolute-expiry anchor.
    this.mirror.localClockTick(dt);
  }

  submitWord(word: string): SubmitResult {
    this.dispatch({ kind: "submit", word });
    // The UI is event-driven (rejected/submission re-emitted on the mirror), so the
    // synchronous return is neutral.
    return { accepted: false };
  }

  reportDraft(word: string): void {
    // Stream the in-progress word to the authority so the server clock can auto-submit
    // it on timeout (the display mirror can't outrace the server clock).
    this.dispatch({ kind: "draftWord", word });
  }

  destroy(): void {
    this.peer.events.off("ready", this.onReady as never);
    this.peer.events.off("message", this.onMessage as never);
    this.peer.events.off("player-joined", this.onRoster as never);
    this.peer.events.off("player-left", this.onRoster as never);
    this.peer.events.off("owner-changed", this.onRoster as never);
    this.peer.events.off("closed", this.onClosed as never);
    this.peer.events.off("resumed", this.onResumed as never);
    this.mirror.events.off("gameOver", this.onGameOver);
  }

  /** Write a Play Log entry for THIS player when a match finishes (real peer only). */
  private onGameOver = (e: { winnerId: string | null; standings: PlayerState[] }): void => {
    const me = this.peer.playerId;
    if (!me) return;
    const idx = e.standings.findIndex((p) => p.id === me);
    if (idx < 0) return; // an owner who isn't playing (hostPlays=false) has no result to log
    const self = e.standings[idx];
    const winner = e.standings.find((p) => p.id === e.winnerId);
    this.peer.logPlay?.({
      placement: idx + 1,
      playerCount: e.standings.length,
      result: e.winnerId === me ? "win" : "loss",
      score: self.score,
      eras: this.mirror.state.settings.eraCount,
      words: this.mirror.state.history.length,
      winner: winner?.name ?? "",
    });
  };

  // ── Transport ────────────────────────────────────────────────────────────────
  private dispatch(action: Intent): void {
    log.debug(`intent → server: ${action.kind}`);
    this.peer.sendToHost({ _kb: "intent", action } satisfies KbEnvelope);
  }

  private requestSync(): void {
    this.peer.sendToHost({ _kb: "sync" } satisfies KbEnvelope);
  }

  private onReady = (): void => {
    log.info(
      `ready (id=${this.peer.playerId ?? "?"}, owner=${this.peer.isOwner}, players=${this.peer.players.length})`,
    );
    this.requestSync(); // ask the authority for the current full state
    this.notifyLobby();
  };

  private onResumed = (): void => {
    // Reconnected after a transient drop: re-request the authoritative state.
    this.requestSync();
    this.notifyLobby();
  };

  private onRoster = (): void => {
    // Roster / owner change. The authority also re-broadcasts state after roster
    // changes; refresh the lobby UI (roster + owner-gated controls) immediately.
    this.notifyLobby();
  };

  private onClosed = (...args: unknown[]): void => {
    const info = args[0] as { terminal?: boolean } | undefined;
    // Terminal close (bad ticket / ended membership) won't reconnect — end the session.
    // A transient close resolves via the SDK's "resumed".
    if (info?.terminal) this.endSession("Connection closed — the session has ended.");
  };

  private onMessage = (...args: unknown[]): void => {
    const { from, payload } = args[0] as { from: string; payload: KbEnvelope };
    // Only the authority (from === "server") may publish state; ignore anything else.
    if (from !== SERVER_ID || !payload || typeof payload !== "object" || !("_kb" in payload))
      return;
    switch (payload._kb) {
      case "state":
        this.applyServerState(payload.state);
        break;
      case "delta":
        // Patches are absolute-valued (full state), applied identically to a snapshot.
        this.applyServerState(payload.patch);
        break;
      case "error":
        // Dev-only diagnostics from a contained authority failure.
        log.warn(`authority error: ${payload.message ?? "(no message)"}`);
        break;
    }
  };

  private applyServerState(p: ServerStatePayload): void {
    log.debug(`applying server state (${p.events.length} events)`);
    this.mirror.applySnapshot(p.state, p.events, p.clock);
    // Refresh the lobby UI whenever we're NOT inside a live match: the pre-match lobby and the
    // post-match rematch lobby (GameOver) both carry owner settings edits that the read-only
    // lobby mirrors. During a live match the match surface renders from replayed events instead.
    const s = this.mirror.state;
    const liveMatch = s.players.length > 0 && s.phase !== "GameOver";
    if (!liveMatch) this.notifyLobby();
  }
}
