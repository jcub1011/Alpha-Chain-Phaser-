import { describe, expect, it } from "vitest";
import type { Dictionary } from "../game/dictionary";
import { orderPreservingRng } from "../game/rng";
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
  fireLeft(playerId: string): void {
    this.emit("player-left", playerId);
  }
  fireClosed(terminal: boolean): void {
    this.emit("closed", { terminal });
  }
  fireResumed(): void {
    this.emit("resumed");
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
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
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
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();

    let guestSawSubmission = "";
    guestCtl.events.on("submission", (e) => (guestSawSubmission = e.submission.word));

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
    hostCtl.tick(1);
    hostCtl.submitWord("cat");

    expect(guestSawSubmission).toBe("cat");
  });

  it("counts the host's own display shot clock down between snapshots", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
    hostCtl.tick(1); // burn the countdown → Round; the turn-arm snapshot resets the clock to full
    expect(hostCtl.match.state.phase).toBe("Round");

    // A frame with no replayed event (no submission / turn-arm) sends no snapshot. The
    // host must still drive its own render mirror, or its displayed clock would freeze.
    const before = hostCtl.match.state.clockRemaining;
    hostCtl.tick(0.1);
    expect(hostCtl.match.state.clockRemaining).toBeLessThan(before);
  });

  it("auto-submits the current player's drafted word when their shot clock times out", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
    hostCtl.tick(1); // burn the countdown → Round, host (player 0) is up
    expect(hostCtl.match.current.id).toBe("host");

    // The host streams its in-progress word (draftWord intent), then its clock expires.
    hostCtl.reportDraft("cat");
    hostCtl.tick(hostCtl.match.state.clockRemaining + 1); // blow the shot clock

    // The drafted word was auto-submitted authoritatively and converged to the guest.
    expect(hostCtl.match.state.players[0].score).toBe(3);
    expect(guestCtl.match.state.players[0].score).toBe(3);
    expect([...guestCtl.match.state.usedWords]).toContain("cat");
    expect(hostCtl.match.current.id).toBe("guest"); // turn advanced via submission
  });

  it("syncs the host's Shiritori tutorial phase to the guest, and host-skip advances both", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();

    // Tutorials ON: the match opens on the Shiritori tutorial for everyone.
    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: true,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
    expect(hostCtl.match.state.phase).toBe("Tutorial");
    expect(guestCtl.match.state.phase).toBe("Tutorial");
    expect(guestCtl.match.state.currentTutorial).toBe("shiritori");

    // A guest skip is ignored (only the host may skip the shared dwell).
    guestCtl.match.skipTutorial();
    expect(hostCtl.match.state.phase).toBe("Tutorial");

    // The host skip advances both into the countdown.
    hostCtl.match.skipTutorial();
    expect(hostCtl.match.state.phase).toBe("Countdown");
    expect(guestCtl.match.state.phase).toBe("Countdown");
  });
});

describe("KnockBoxController — edge cases", () => {
  const startBoth = () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();
    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 9,
      eraCount: 1,
    });
    hostCtl.tick(1);
    return { hostPeer, guestPeer, hostCtl, guestCtl };
  };

  it("marks a departed player eliminated mid-match and re-broadcasts", () => {
    const { hostPeer, hostCtl, guestCtl } = startBoth();
    hostPeer.fireLeft("guest");
    const onHost = hostCtl.match.state.players.find((p) => p.id === "guest");
    const onGuest = guestCtl.match.state.players.find((p) => p.id === "guest");
    expect(onHost?.eliminated).toBe(true);
    expect(onGuest?.eliminated).toBe(true); // converged via re-broadcast
  });

  it("ends the session for a guest when the host leaves", () => {
    const { guestPeer, guestCtl } = startBoth();
    let reason = "";
    guestCtl.onSessionEnded((r) => (reason = r));
    guestPeer.fireLeft("host"); // the host departs
    expect(reason).toContain("host");
  });

  it("ends the session on a terminal close", () => {
    const { guestPeer, guestCtl } = startBoth();
    let ended = 0;
    guestCtl.onSessionEnded(() => ended++);
    guestPeer.fireClosed(false); // transient — no end
    expect(ended).toBe(0);
    guestPeer.fireClosed(true); // terminal — end once
    guestPeer.fireClosed(true); // idempotent
    expect(ended).toBe(1);
  });

  it("re-syncs the guest from the host on resume", () => {
    const { guestPeer, guestCtl } = startBoth();
    // Desync the guest mirror, then resume → guest asks, host re-pushes.
    guestCtl.match.state.players[0].score = -999;
    guestPeer.fireResumed();
    expect(guestCtl.match.state.players[0].score).toBe(0); // host's real score, re-pushed
  });
});

describe("KnockBoxController — intermission optimize", () => {
  // Drive a one-round era to its end so the match enters the "optimize" intermission.
  const startToOptimize = () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng);
    hostPeer.fireReady();
    guestPeer.fireReady();
    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      eraInterval: 1, // a single full round ends the era
      eraCount: 2, // ...into an intermission, not game over
    });
    hostCtl.tick(1); // burn the countdown → Round
    hostCtl.submitWord("cat"); // host (player 0): "" → t
    guestCtl.submitWord("tiger"); // guest (player 1): t → r — wraps the round, ends the era
    hostCtl.tick(10); // burn the era-end settle dwell → enterIntermission → optimize
    return { hostCtl, guestCtl };
  };

  it("reaches the optimize sub-phase on both host and guest without throwing", () => {
    let ctls!: ReturnType<typeof startToOptimize>;
    expect(() => (ctls = startToOptimize())).not.toThrow();
    expect(ctls.hostCtl.match.state.phase).toBe("Intermission");
    expect(ctls.hostCtl.match.state.intermissionPhase).toBe("optimize");
    expect(ctls.guestCtl.match.state.intermissionPhase).toBe("optimize"); // converged
  });

  it("waits for every human to lock in before advancing optimize (lockInOptimize intent)", () => {
    const { hostCtl, guestCtl } = startToOptimize();
    expect(guestCtl.match.state.intermissionPhase).toBe("optimize");

    // One player's LOCK IN routes a lockInOptimize intent to the host, which records it
    // but does NOT end the shared dwell — the other human hasn't locked in yet.
    guestCtl.match.skipOptimize();
    expect(hostCtl.match.state.intermissionPhase).toBe("optimize");
    expect(guestCtl.match.state.intermissionPhase).toBe("optimize");

    // Once the last human (the host plays by default) locks in too, optimize advances
    // for everyone. With tutorials off, optimize → sniperBan.
    hostCtl.match.skipOptimize();
    expect(hostCtl.match.state.intermissionPhase).toBe("sniperBan");
    expect(guestCtl.match.state.intermissionPhase).toBe("sniperBan"); // converged
  });

  it("ticks the host's own optimize sub-timer down between snapshots", () => {
    const { hostCtl } = startToOptimize();
    const before = hostCtl.match.state.subTimerRemaining;
    hostCtl.tick(0.1); // a frame with no replayed event — the host must drive its mirror
    expect(hostCtl.match.state.subTimerRemaining).toBeLessThan(before);
  });
});
