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
    const clock = { t: 0 };
    const now = (): number => clock.t;
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng, now);
    new KnockBoxController(guestPeer, dict, orderPreservingRng, now);
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
    // The mirror now reads off the absolute anchor, so advance the monotonic clock.
    const before = hostCtl.match.state.clockRemaining;
    clock.t += 100;
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
    const clock = { t: 0 };
    const now = (): number => clock.t;
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng, now);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng, now);
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
    return { hostPeer, guestPeer, hostCtl, guestCtl, clock };
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
    const { hostCtl, clock } = startToOptimize();
    const before = hostCtl.match.state.subTimerRemaining;
    clock.t += 100; // the mirror reads off the absolute anchor — advance the monotonic clock
    hostCtl.tick(0.1); // a frame with no replayed event — the host must drive its mirror
    expect(hostCtl.match.state.subTimerRemaining).toBeLessThan(before);
  });

  it("advances optimize when the last unlocked player leaves mid-optimize", () => {
    const { hostPeer, hostCtl } = startToOptimize();
    // The host locks in, but the guest hasn't — the shared dwell must keep waiting.
    hostCtl.match.skipOptimize();
    expect(hostCtl.match.state.intermissionPhase).toBe("optimize");

    // The only player we were still waiting on leaves. recheckOptimizeCompletion must
    // re-evaluate so the locked-in host isn't stranded waiting on a departed straggler.
    hostPeer.fireLeft("guest");
    expect(hostCtl.match.state.intermissionPhase).toBe("sniperBan"); // tutorials off: optimize → ban
  });
});

describe("KnockBoxController — fault containment", () => {
  it("contains a throwing intent without tearing down the host loop", () => {
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    // A dictionary that throws while validating one specific word, to force a throw
    // inside the host's applyIntent path.
    const throwingDict = {
      has: (w: string) => {
        if (w === "boom") throw new Error("kaboom");
        return WORDS.has(w);
      },
    } as unknown as Dictionary;
    const hostCtl = new KnockBoxController(hostPeer, throwingDict, orderPreservingRng);
    const guestCtl = new KnockBoxController(guestPeer, throwingDict, orderPreservingRng);
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
    expect(hostCtl.match.current.id).toBe("host");

    // The throwing submission must be swallowed by applyIntent's try/catch — it must
    // not propagate out, and it must not advance the turn.
    expect(() => hostCtl.submitWord("boom")).not.toThrow();
    expect(hostCtl.match.current.id).toBe("host");

    // The very next valid intent still applies — the host loop survived the throw.
    hostCtl.submitWord("cat");
    expect(hostCtl.match.state.players[0].score).toBe(3);
    expect(guestCtl.match.state.players[0].score).toBe(3);
    expect(hostCtl.match.current.id).toBe("guest"); // turn advanced normally
  });
});

describe("KnockBoxController — absolute-expiry timer anchoring", () => {
  it("keeps the guest shot clock on real time when frames are clamped (no drift)", () => {
    const clock = { t: 0 };
    const now = (): number => clock.t;
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng, now);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng, now);
    hostPeer.fireReady();
    guestPeer.fireReady();

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 1,
      shotClockSeconds: 30,
      eraInterval: 9,
      eraCount: 1,
    });
    hostCtl.tick(1); // → Round; the turn-arm snapshot anchors the guest's clock
    const armed = guestCtl.match.state.clockRemaining;
    expect(armed).toBeGreaterThan(25);

    // 5s of real time pass, but the lagging guest only gets 20 clamped 50ms frames
    // (1s of summed dt). The old dt-subtraction would lose 4s; the anchor must not.
    for (let i = 0; i < 20; i++) {
      clock.t += 250;
      guestCtl.tick(0.05);
    }
    expect(guestCtl.match.state.clockRemaining).toBeLessThanOrEqual(armed - 4.9);
    expect(guestCtl.match.state.clockRemaining).toBeGreaterThan(armed - 5.2);
  });

  it("drives the pre-round countdown from the absolute anchor (no per-second events)", () => {
    const clock = { t: 0 };
    const now = (): number => clock.t;
    const hub = new Hub();
    const hostPeer = new FakePeer(hub, "host", true, roster);
    const guestPeer = new FakePeer(hub, "guest", false, roster);
    const hostCtl = new KnockBoxController(hostPeer, dict, orderPreservingRng, now);
    const guestCtl = new KnockBoxController(guestPeer, dict, orderPreservingRng, now);
    hostPeer.fireReady();
    guestPeer.fireReady();

    const seen: number[] = [];
    guestCtl.events.on("countdownTick", (n) => seen.push(n));

    hostCtl.startMatch({
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      preRoundCountdownSeconds: 5,
      eraInterval: 9,
      eraCount: 1,
    });
    // The Countdown-start snapshot (phaseChanged) reaches the guest and anchors it.
    expect(guestCtl.match.state.phase).toBe("Countdown");

    // Advance real time second-by-second; the guest derives the integer countdown
    // from the anchor alone — the host never sends per-second countdown snapshots.
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      guestCtl.tick(0.05);
    }
    expect(seen).toContain(4);
    expect(seen).toContain(1);
  });
});
