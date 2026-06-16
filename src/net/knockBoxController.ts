/*
 * KnockBoxController — the host-authoritative multiplayer GameController.
 *
 * Model: EVERY client (host included) renders from a local NetMatch mirror fed
 * by the host's authoritative snapshots — a single code path (GAME_DEVELOPER_GUIDE
 * §5). The HOST additionally owns the real MatchController: it applies each intent
 * (its own loop back through sendToHost too), buffers the resulting match events,
 * and broadcasts a full snapshot + those events to everyone. The host applies its
 * own snapshot directly to its mirror (so it never depends on the relay echoing
 * sendToAll back to the sender) and ignores any echoed snapshot.
 *
 * Shot clock: only the host's real MatchController ticks + times out. Guests run
 * a smooth local countdown between snapshots and never time out; the host's next
 * turn-arm snapshot resyncs everyone.
 */

import type { Dictionary } from "../game/dictionary";
import { MatchController, type MatchEvents, type PlayerSeed } from "../game/match";
import type { AlphaChainSettings, SubmitResult } from "../game/types";
import type { GameController, MatchLike } from "./controller";
import type { Intent, NetMessage, SnapshotMsg, WireEvent } from "./messages";
import { NetMatch } from "./netMatch";
import { serializeState } from "./serialize";

/** The transport surface shared by KnockBoxPlugin and KnockBoxLocalPeer. */
export interface NetPeer {
  playerId: string | null;
  players: { id: string; displayName: string }[];
  isHost: boolean;
  events: {
    on(event: string, fn: (...args: unknown[]) => void): unknown;
    off(event: string, fn: (...args: unknown[]) => void): unknown;
  };
  sendToHost(payload: unknown): void;
  sendToAll(payload: unknown): void;
  sendTo(playerId: string, payload: unknown): void;
  setLobbyOpen?(open: boolean): void;
}

/** Match events the host broadcasts for replay (everything but the per-frame clock). */
const REPLAYED_EVENTS: (keyof MatchEvents)[] = [
  "phaseChanged",
  "subPhaseChanged",
  "countdownTick",
  "turnArmed",
  "submission",
  "rejected",
  "timeout",
  "intermission",
  "gameOver",
];

export class KnockBoxController implements GameController {
  readonly match: MatchLike;
  private readonly mirror: NetMatch;
  private host?: MatchController;
  private pending: WireEvent[] = [];
  private startSettings?: AlphaChainSettings;
  private lobbyCbs: (() => void)[] = [];
  private sessionEndedCbs: ((reason: string) => void)[] = [];
  /** The host's player id (learned from snapshots), for host-departure detection. */
  private hostId = "";
  private ended = false;

  /** Subscribe to lobby/roster changes (ready, join, leave) for the waiting UI. */
  onLobbyChange(cb: () => void): () => void {
    this.lobbyCbs.push(cb);
    return () => (this.lobbyCbs = this.lobbyCbs.filter((c) => c !== cb));
  }
  private notifyLobby(): void {
    this.lobbyCbs.slice().forEach((c) => c());
  }

  /** Subscribe to a terminal session end (host left / socket closed). */
  onSessionEnded(cb: (reason: string) => void): () => void {
    this.sessionEndedCbs.push(cb);
    return () => (this.sessionEndedCbs = this.sessionEndedCbs.filter((c) => c !== cb));
  }
  private endSession(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.sessionEndedCbs.slice().forEach((c) => c(reason));
  }

  constructor(
    private readonly peer: NetPeer,
    private readonly dict: Dictionary,
  ) {
    this.mirror = new NetMatch((intent) => this.dispatch(intent));
    this.match = this.mirror;
    peer.events.on("ready", this.onReady);
    peer.events.on("message", this.onMessage);
    peer.events.on("player-joined", this.onRoster);
    peer.events.on("player-left", this.onLeft);
    peer.events.on("closed", this.onClosed);
    peer.events.on("resumed", this.onResumed);
  }

  get events(): MatchLike["events"] {
    return this.mirror.events;
  }
  get humanId(): string {
    return this.peer.playerId ?? "";
  }
  get isHost(): boolean {
    return this.peer.isHost;
  }
  /** The lobby roster (for the pre-match waiting surface). */
  get roster(): { id: string; displayName: string }[] {
    return this.peer.players;
  }

  // ── GameController ──────────────────────────────────────────────────────────
  /** Host-only: begin a match with the given settings (loops through dispatch). */
  startMatch(settings: AlphaChainSettings): void {
    this.dispatch({ kind: "startMatch", settings });
  }

  start(): void {
    // No-op: the match begins when the host calls startMatch().
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    if (this.host) {
      this.host.tick(dt); // authoritative clock + timeouts
      this.flush();
    } else {
      this.mirror.localClockTick(dt); // smooth guest countdown, never times out
    }
  }

  submitWord(word: string): SubmitResult {
    this.dispatch({ kind: "submit", word });
    // The UI is event-driven (rejected/submission re-emitted on the mirror), so the
    // synchronous return is neutral.
    return { accepted: false };
  }

  destroy(): void {
    this.peer.events.off("ready", this.onReady as never);
    this.peer.events.off("message", this.onMessage as never);
    this.peer.events.off("player-joined", this.onRoster as never);
    this.peer.events.off("player-left", this.onLeft as never);
    this.peer.events.off("closed", this.onClosed as never);
    this.peer.events.off("resumed", this.onResumed as never);
    this.pending = [];
  }

  // ── Transport ────────────────────────────────────────────────────────────────
  private dispatch(action: Intent): void {
    this.peer.sendToHost({ t: "intent", action } satisfies NetMessage);
  }

  private onReady = (): void => {
    if (!this.peer.isHost) {
      this.peer.sendToHost({ t: "sync" } satisfies NetMessage);
    } else if (this.host) {
      this.broadcast(); // host reconnect: re-push current state
    }
    this.notifyLobby();
  };

  private onRoster = (): void => {
    if (this.peer.isHost && this.host) this.broadcast();
    this.notifyLobby();
  };

  private onLeft = (...args: unknown[]): void => {
    const leftId = args[0] as string;
    if (this.peer.isHost && this.host) {
      // Mirror the Blazor HasLeft: mark eliminated so turns skip them.
      const p = this.host.state.players.find((x) => x.id === leftId);
      if (p) p.eliminated = true;
      this.broadcast();
    } else if (!this.peer.isHost && leftId && leftId === this.hostId) {
      // The host left and there is no host migration — the session is over.
      this.endSession("The host left — the session has ended.");
    }
    this.notifyLobby();
  };

  private onClosed = (...args: unknown[]): void => {
    const info = args[0] as { terminal?: boolean } | undefined;
    // Terminal close (bad ticket / ended membership) won't reconnect — end the
    // session. A transient close resolves via the SDK's "resumed"/"ready".
    if (info?.terminal) this.endSession("Connection closed — the session has ended.");
  };

  private onResumed = (): void => {
    // Reconnected after a transient drop: host re-pushes, guest re-requests.
    if (this.peer.isHost) {
      if (this.host) this.broadcast();
    } else {
      this.peer.sendToHost({ t: "sync" } satisfies NetMessage);
    }
    this.notifyLobby();
  };

  private onMessage = (...args: unknown[]): void => {
    const { from, payload } = args[0] as { from: string; payload: NetMessage };
    if (!payload || typeof payload !== "object" || !("t" in payload)) return;
    switch (payload.t) {
      case "intent":
        if (this.peer.isHost) this.applyIntent(from, payload.action);
        break;
      case "sync":
        if (this.peer.isHost && this.host) this.sendSnapshotTo(from);
        break;
      case "snap":
        // The host already applied its own snapshot directly; ignore the echo.
        if (!this.peer.isHost) {
          this.hostId = payload.hostId;
          this.mirror.applySnapshot(payload.state, payload.events);
        }
        break;
    }
  };

  // ── Host authority ───────────────────────────────────────────────────────────
  private applyIntent(fromId: string, action: Intent): void {
    if (action.kind === "startMatch") {
      if (fromId !== this.peer.playerId) return; // only the host starts
      this.beginHostMatch(action.settings);
      return;
    }
    const h = this.host;
    if (!h) return;
    switch (action.kind) {
      case "submit":
        h.submitWord(fromId, action.word);
        break;
      case "reorderBay":
        if (h.state.phase === "Intermission" && h.state.intermissionPhase === "optimize") {
          h.setPlayerBay(fromId, action.engine, action.discard);
          // setPlayerBay emits no match event, so the trailing flush() would no-op
          // and clients would never see the reorder. Force a snapshot.
          this.flush(true);
        }
        break;
      case "sniperBan":
        if (
          h.state.phase === "Intermission" &&
          h.state.intermissionPhase === "sniperBan" &&
          h.computeLastPlaceId() === fromId
        )
          h.applySniperBanAndAdvance(action.letter);
        break;
      case "skipTutorial":
        if (fromId === this.peer.playerId) h.skipTutorial(); // only the host may skip
        break;
    }
    this.flush();
  }

  private beginHostMatch(settings: AlphaChainSettings): void {
    this.startSettings = settings;
    const seeds: PlayerSeed[] = this.peer.players
      .filter((p) => settings.hostPlays || p.id !== this.peer.playerId)
      .map((p) => ({ id: p.id, name: p.displayName, isBot: false }));
    this.host = new MatchController(seeds, settings, { isWord: (w) => this.dict.has(w) });
    for (const type of REPLAYED_EVENTS) {
      this.host.events.on(type, (payload) => this.pending.push({ type, payload } as WireEvent));
    }
    this.peer.setLobbyOpen?.(false); // close the lobby once the match starts
    this.host.start();
    this.flush(true);
  }

  /** Flush buffered host events as a snapshot to everyone (and the host's own mirror). */
  private flush(force = false): void {
    if (!this.host) return;
    if (!force && this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    const snap = this.buildSnapshot(events);
    this.peer.sendToAll(snap);
    this.mirror.applySnapshot(snap.state, snap.events); // host renders via the same path
  }

  private broadcast(): void {
    this.flush(true);
  }

  private sendSnapshotTo(playerId: string): void {
    this.peer.sendTo(playerId, this.buildSnapshot([]));
  }

  private buildSnapshot(events: WireEvent[]): SnapshotMsg {
    const s = this.host!.state;
    return {
      t: "snap",
      state: serializeState(s),
      events,
      hostId: this.peer.playerId ?? "",
      serverClock: {
        currentPlayerIndex: s.currentPlayerIndex,
        clockTotal: s.clockTotal,
        clockRemaining: s.clockRemaining,
      },
    };
  }

  /** Whether a match has begun (vs. still in the lobby). */
  get inMatch(): boolean {
    return this.mirror.state.players.length > 0;
  }

  /** The settings the host started with (for late UI). */
  get matchSettings(): AlphaChainSettings | undefined {
    return this.startSettings;
  }
}
