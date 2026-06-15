import { describe, expect, it } from "vitest";
import type { Dictionary } from "../game/dictionary";
import { DEFAULT_SETTINGS } from "../game/settings";
import { KnockBoxController, type NetPeer } from "./knockBoxController";

// ── A synchronous in-process relay that mimics the KnockBox server's routing. ──
type Listener = (...a: unknown[]) => void;

class Hub {
  peers: FakePeer[] = [];
  route(payload: unknown, to: string, from: string): void {
    if (to === "host") this.peers.find((p) => p.isHost)?.deliver(from, payload);
    else if (to === "all") this.peers.forEach((p) => p.deliver(from, payload));
    else this.peers.find((p) => p.playerId === to)?.deliver(from, payload);
  }
}

class FakePeer implements NetPeer {
  private listeners: Record<string, Listener[]> = {};
  events = {
    on: (e: string, fn: Listener) => ((this.listeners[e] ??= []).push(fn), undefined),
    off: (e: string, fn: Listener) => {
      this.listeners[e] = (this.listeners[e] ?? []).filter((f) => f !== fn);
    },
  };
  constructor(
    private readonly hub: Hub,
    public playerId: string,
    public isHost: boolean,
    public players: { id: string; displayName: string }[],
  ) {
    hub.peers.push(this);
  }
  private emit(e: string, ...a: unknown[]): void {
    (this.listeners[e] ?? []).slice().forEach((f) => f(...a));
  }
  fireReady(): void {
    this.emit("ready", { playerId: this.playerId, players: this.players, isHost: this.isHost });
  }
  deliver(from: string, payload: unknown): void {
    this.emit("message", { from, payload });
  }
  sendToHost(p: unknown): void {
    this.hub.route(p, "host", this.playerId);
  }
  sendToAll(p: unknown): void {
    this.hub.route(p, "all", this.playerId);
  }
  sendTo(id: string, p: unknown): void {
    this.hub.route(p, id, this.playerId);
  }
  setLobbyOpen(): void {
    /* no-op locally */
  }
}

const WORDS = new Set(["cat", "tiger", "rabbit", "torch", "rat", "art", "table"]);
const dict = { has: (w: string) => WORDS.has(w) } as unknown as Dictionary;

const roster = [
  { id: "host", displayName: "Host" },
  { id: "guest", displayName: "Guest" },
];

describe("KnockBoxController — host-authoritative sync", () => {
  it("converges guest state to the host's after a match starts and words are played", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict);
    const guestCtl = new KnockBoxController(guestPeer, dict);
    hostPeer.fireReady();
    guestPeer.fireReady();

    hostCtl.startMatch({ ...DEFAULT_SETTINGS, preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1 });
    hostCtl.tick(1); // burn the countdown → first turn armed, broadcast

    // The match reached the host AND the guest mirror.
    expect(hostCtl.match.state.phase).toBe("Round");
    expect(guestCtl.match.state.phase).toBe("Round");
    expect(guestCtl.match.state.players.length).toBe(2);

    // Host (player 0) submits; the guest's mirror converges.
    expect(hostCtl.match.current.id).toBe("host");
    hostCtl.submitWord("cat");
    expect(hostCtl.match.state.players[0].score).toBe(3);
    expect(guestCtl.match.state.players[0].score).toBe(3);
    expect(guestCtl.match.state.requiredLetter).toBe("t");
    expect([...guestCtl.match.state.usedWords]).toContain("cat");

    // Guest (player 1) submits a valid chained word as an intent; host validates.
    expect(guestCtl.match.current.id).toBe("guest");
    guestCtl.submitWord("tiger"); // t → ...r
    expect(hostCtl.match.state.players[1].score).toBe(5);
    expect(guestCtl.match.state.players[1].score).toBe(5);
    expect(guestCtl.match.state.requiredLetter).toBe("r");
  });

  it("replays the submission event on the guest mirror", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict);
    const guestCtl = new KnockBoxController(guestPeer, dict);
    hostPeer.fireReady();
    guestPeer.fireReady();

    let guestSawSubmission = "";
    guestCtl.events.on("submission", (e) => (guestSawSubmission = e.submission.word));

    hostCtl.startMatch({ ...DEFAULT_SETTINGS, preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1 });
    hostCtl.tick(1);
    hostCtl.submitWord("cat");

    expect(guestSawSubmission).toBe("cat");
  });
});
