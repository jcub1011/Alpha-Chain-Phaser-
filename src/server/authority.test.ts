/*
 * Server-authoritative integration tests. A synchronous in-process harness mimics the
 * KnockBox server's authority loop: it runs the REAL createAuthority(kb) module, routes
 * client `{_kb:"intent"}` / `{_kb:"sync"}` frames into it, and broadcasts its returned
 * patches back stamped `from:"server"` — the exact contract real ServerControllers speak.
 * This ports the old host-authoritative KnockBoxController suite onto the new topology
 * (every client a guest; the server owns the rules) and additionally pins the two
 * behaviours the migration changes: the session now survives the owner leaving, and word
 * validation runs against the injected word service (kb.words).
 */

import { describe, expect, it } from "vitest";
import { getCard } from "../game/cards/library";
import { orderPreservingRng } from "../game/rng";
import { DEFAULT_SETTINGS } from "../game/settings";
import { CardRarity } from "../game/types";
import type { AlphaChainSettings } from "../game/types";
import type { NetPeer } from "../net/netPeer";
import { ServerController } from "../net/serverController";
import { createAuthority, type Kb } from "./authority";

type Listener = (...a: unknown[]) => void;

/** The tiny dictionary the word service is stubbed with (mirrors the old suite). */
const WORDS = new Set(["cat", "tiger", "rabbit", "torch", "rat", "art", "table"]);

/** A kb.words stub over a Set — the five-method contract, ASCII lower-case. */
function makeWords(set: Set<string>): Kb["words"] {
  const arr = (): string[] => [...set];
  return {
    has: (_k, w) => typeof w === "string" && set.has(w),
    count: () => set.size,
    pick: (_k, i) => arr()[i] ?? null,
    countOfLength: (_k, len) => arr().filter((w) => w.length === len).length,
    pickOfLength: (_k, len, i) => arr().filter((w) => w.length === len)[i] ?? null,
  };
}

const FAST: Partial<AlphaChainSettings> = {
  enableTutorials: false,
  preRoundCountdownSeconds: 1,
  eraInterval: 9,
  eraCount: 1,
};

class ServerHub {
  peers: FakePeer[] = [];
  ownerId: string | null = null;
  private readonly authority: ReturnType<typeof createAuthority>;

  constructor(
    private readonly clock: { t: number },
    words: Set<string> | Kb["words"] = WORDS,
  ) {
    const kb: Kb = {
      now: () => this.clock.t,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      words: words instanceof Set ? makeWords(words) : words,
      setLobbyOpen: () => {},
      setOwner: (id) => this.assignOwner(id),
      rng: orderPreservingRng, // deterministic turn order (p1 opens)
    };
    this.authority = createAuthority(kb);
  }

  add(peer: FakePeer): void {
    this.peers.push(peer);
  }

  /** Start the lobby: init the authority with the roster and seat the first as owner. */
  init(): void {
    this.ownerId = this.peers[0]?.playerId ?? null;
    this.syncOwnerFlags();
    this.authority.init(this.peers.map((p) => ({ id: p.playerId, displayName: p.displayName })));
  }

  private assignOwner(id: string): void {
    this.ownerId = id;
    this.syncOwnerFlags();
    this.peers.forEach((p) => p.fireOwnerChanged(id));
  }
  private syncOwnerFlags(): void {
    for (const p of this.peers) {
      p.ownerId = this.ownerId;
      p.isOwner = p.playerId === this.ownerId;
    }
  }

  private broadcast(payload: unknown): void {
    this.peers.forEach((p) => p.deliver("server", payload));
  }
  private sendToOne(id: string, payload: unknown): void {
    this.peers.find((p) => p.playerId === id)?.deliver("server", payload);
  }

  /** Route a client frame. In server mode only `_kb` frames to "host" reach the authority. */
  route(payload: unknown, to: string, from: string): void {
    if (to !== "host") return; // no client-to-client chatter in this game's server mode
    const env = payload as { _kb?: string; action?: unknown };
    if (env?._kb === "intent") {
      const patch = this.authority.applyIntent(from, env.action as never);
      if (patch) this.broadcast({ _kb: "delta", patch });
    } else if (env?._kb === "sync") {
      this.sendToOne(from, { _kb: "state", state: this.authority.snapshot(from) });
    }
  }

  /** Advance real time by dtMs and drive the server tick (the platform's tick timer). */
  advance(dtMs: number): void {
    this.clock.t += dtMs;
    const patch = this.authority.tick(dtMs);
    if (patch) this.broadcast({ _kb: "delta", patch });
  }

  /** A player leaves: run the roster hook, drop them, re-broadcast state, notify peers. */
  playerLeft(id: string): void {
    this.authority.onPlayerLeft(id);
    this.peers = this.peers.filter((p) => p.playerId !== id);
    this.broadcast({ _kb: "state", state: this.authority.snapshot() });
    this.peers.forEach((p) => p.fireLeft(id));
  }
}

class FakePeer implements NetPeer {
  private listeners: Record<string, Listener[]> = {};
  events = {
    on: (e: string, fn: Listener): undefined => void (this.listeners[e] ??= []).push(fn),
    off: (e: string, fn: Listener): void => {
      this.listeners[e] = (this.listeners[e] ?? []).filter((f) => f !== fn);
    },
  };
  logCalls: Record<string, unknown>[] = [];
  isHost = false;
  authority = "server" as const;
  ownerId: string | null = null;
  isOwner = false;

  constructor(
    private readonly hub: ServerHub,
    public playerId: string,
    public displayName: string,
    public players: { id: string; displayName: string }[],
  ) {
    hub.add(this);
  }

  private emit(e: string, ...a: unknown[]): void {
    (this.listeners[e] ?? []).slice().forEach((f) => f(...a));
  }
  fireReady(): void {
    this.emit("ready");
  }
  fireLeft(id: string): void {
    this.emit("player-left", id);
  }
  fireOwnerChanged(id: string): void {
    this.emit("owner-changed", id);
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
  logPlay(metadata: Record<string, unknown>): void {
    this.logCalls.push(metadata);
  }
}

const roster = [
  { id: "p1", displayName: "One" },
  { id: "p2", displayName: "Two" },
];

/** Spin up an initialised two-player session with both clients ready (synced). */
function session() {
  const clock = { t: 0 };
  const hub = new ServerHub(clock);
  const p1 = new FakePeer(hub, "p1", "One", roster);
  const p2 = new FakePeer(hub, "p2", "Two", roster);
  const now = (): number => clock.t;
  const c1 = new ServerController(p1, now);
  const c2 = new ServerController(p2, now);
  hub.init();
  p1.fireReady();
  p2.fireReady();
  return { hub, p1, p2, c1, c2, clock };
}

/** Controllers keyed by player id, so tests can act as "whoever is up". */
function byId(c1: ServerController, c2: ServerController): Record<string, ServerController> {
  return { p1: c1, p2: c2 };
}

describe("authority — server-authoritative sync", () => {
  it("converges every client to the authoritative state as words are played", () => {
    const { hub, c1, c2 } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST }); // owner (p1) starts
    hub.advance(1000); // burn the countdown → first turn armed

    expect(c1.match.state.phase).toBe("Round");
    expect(c2.match.state.phase).toBe("Round");
    expect(c2.match.state.players.length).toBe(2);

    const ctl = byId(c1, c2);
    // First turn: free letter. Whoever is up plays "cat".
    expect(ctl[c1.match.current.id]).toBeDefined();
    ctl[c1.match.current.id].submitWord("cat");
    expect(c1.match.state.players[0].score).toBe(3);
    expect(c2.match.state.players[0].score).toBe(3); // converged
    expect(c2.match.state.requiredLetter).toBe("t");
    expect([...c2.match.state.usedWords]).toContain("cat");

    // Next turn: "t" → "...r". The other client's intent is validated server-side.
    ctl[c1.match.current.id].submitWord("tiger");
    expect(c2.match.state.requiredLetter).toBe("r");
    expect(c1.match.state.players[1].score).toBe(5);
    expect(c2.match.state.players[1].score).toBe(5);
  });

  it("replays the submission event on the other client's mirror", () => {
    const { hub, c1, c2 } = session();
    let seen = "";
    c2.events.on("submission", (e) => (seen = e.submission.word));
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    hub.advance(1000);
    byId(c1, c2)[c1.match.current.id].submitWord("cat");
    expect(seen).toBe("cat");
  });

  it("rejects a word the server word service does not know", () => {
    const { hub, c1, c2 } = session();
    let reason = "";
    c2.events.on("rejected", (e) => (reason = e.reason));
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    hub.advance(1000);
    byId(c1, c2)[c1.match.current.id].submitWord("zzzz"); // not in kb.words
    expect(reason).toBe("not-a-word");
    expect(c1.match.state.history.length).toBe(0);
  });

  it("auto-submits the current player's drafted word when their clock times out", () => {
    const { hub, c1, c2 } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    hub.advance(1000);
    const upId = c1.match.current.id;
    byId(c1, c2)[upId].reportDraft("cat"); // stream the in-progress word to the server
    hub.advance((c1.match.state.clockRemaining + 2) * 1000); // blow the clock + grace

    expect(c1.match.state.players.find((p) => p.id === upId)?.score).toBe(3);
    expect([...c2.match.state.usedWords]).toContain("cat"); // converged
    expect(c1.match.current.id).not.toBe(upId); // turn advanced via the auto-submit
  });
});

describe("authority — tutorials & owner gating", () => {
  it("syncs the tutorial phase to all clients, and only the owner may skip", () => {
    const { c1, c2 } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, enableTutorials: true });
    expect(c1.match.state.phase).toBe("Tutorial");
    expect(c2.match.state.currentTutorial).toBe("shiritori");

    c2.match.skipTutorial(); // non-owner: ignored server-side
    expect(c1.match.state.phase).toBe("Tutorial");

    c1.match.skipTutorial(); // owner: advances everyone
    expect(c1.match.state.currentTutorial).toBe("timeout");
    expect(c2.match.state.currentTutorial).toBe("timeout");
  });
});

describe("authority — lobby settings", () => {
  it("routes the owner's setSettings through the server so all clients converge", () => {
    const { c1, c2 } = session();
    c1.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 45, eraCount: 7 });
    expect(c2.lobbySettings?.shotClockSeconds).toBe(45);
    expect(c2.lobbySettings?.eraCount).toBe(7);
    expect(c1.lobbySettings?.shotClockSeconds).toBe(45);
  });

  it("ignores setSettings from a non-owner", () => {
    const { c1, c2 } = session();
    c2.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 99 });
    expect(c1.lobbySettings?.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
  });

  it("notifies lobby subscribers when settings change", () => {
    const { c1, c2 } = session();
    let n = 0;
    c2.onLobbyChange(() => n++);
    c1.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 30 });
    expect(n).toBeGreaterThan(0);
  });
});

/*
 * The authority is the ONLY thing standing between a client's settings blob and the rules the
 * match runs on — clients render what it broadcasts, so nothing downstream re-validates. These
 * pin that it settles WHAT, not just who and when. (Before the server migration this check lived
 * on each guest, where a bad value only spoiled that client's lobby readout.)
 */
describe("authority — settings sanitization (the server-side trust boundary)", () => {
  it("rejects an out-of-range value back to its default, keeping valid siblings", () => {
    const { c1, c2 } = session();
    c1.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 9999, eraCount: 7 });
    // Per-key, not wholesale: the bad value falls back and the good one still lands.
    expect(c2.lobbySettings?.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
    expect(c2.lobbySettings?.eraCount).toBe(7);
  });

  it("rejects a NaN shot clock rather than broadcasting a clock that never expires", () => {
    const { c1, c2 } = session();
    c1.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: Number.NaN });
    expect(c2.lobbySettings?.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
  });

  it("backfills a key a stale client omits instead of publishing undefined", () => {
    const { c1, c2 } = session();
    // A client built before the rarity settings existed sends a blob without them. Left
    // undefined these reach rarityDealWeights, and NaN weights make dealCards deal the same
    // last-pooled card every draw.
    const partial: Partial<AlphaChainSettings> = { ...DEFAULT_SETTINGS };
    delete partial.rarityWeightCommon;
    delete partial.rarityWeightLegendary;
    c1.setLobbySettings(partial as AlphaChainSettings);
    expect(c2.lobbySettings?.rarityWeightCommon).toBe(DEFAULT_SETTINGS.rarityWeightCommon);
    expect(c2.lobbySettings?.rarityWeightLegendary).toBe(DEFAULT_SETTINGS.rarityWeightLegendary);
  });

  it("sanitizes the startMatch payload too, not just setSettings", () => {
    // startMatch carries the owner lobby's own draft, NOT whatever setSettings last published,
    // so it is an independent entry point that has to validate in its own right.
    const { hub, c1, c2 } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, eraCount: 999, modifierSlotsStart: 0 });
    hub.advance(1000);
    expect(c2.match.state.settings.eraCount).toBe(DEFAULT_SETTINGS.eraCount);
    expect(c2.match.state.settings.modifierSlotsStart).toBe(DEFAULT_SETTINGS.modifierSlotsStart);
    expect(c2.match.state.phase).toBe("Round"); // and the match still started
  });

  it("still rejects a non-owner's setSettings before sanitizing it", () => {
    // Ordering guard: authorization runs first, so a rejected intent costs no validation.
    const { c1, c2 } = session();
    c2.setLobbySettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 45 });
    expect(c1.lobbySettings?.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
  });
});

describe("authority — roster, owner succession & session lifetime", () => {
  const start = () => {
    const s = session();
    s.c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    s.hub.advance(1000);
    return s;
  };

  it("marks a departed player eliminated and re-broadcasts to the remaining clients", () => {
    const { hub, c1 } = start();
    hub.playerLeft("p2"); // p2 disconnects; the remaining client must see them eliminated
    expect(c1.match.state.players.find((p) => p.id === "p2")?.eliminated).toBe(true);
  });

  it("skips a departed current player's turn with no penalty, keeping them scored", () => {
    const { hub, c2 } = start();
    // p1 (the deterministic opener) is up. They leave mid-turn — before their shot clock
    // runs down — so the turn must advance immediately with no timeout penalty.
    expect(c2.match.current.id).toBe("p1");
    hub.playerLeft("p1");
    expect(c2.match.current.id).toBe("p2"); // turn handed on, not waited out
    const gone = c2.match.state.players.find((p) => p.id === "p1");
    expect(gone?.eliminated).toBe(true); // still on the leaderboard, marked out
    expect(gone?.score).toBe(0); // untouched — no timeout expiration penalty
  });

  it("keeps the session alive when the owner leaves and migrates ownership", () => {
    const { hub, p2, c2 } = start();
    let ended = 0;
    c2.onSessionEnded(() => ended++);
    hub.playerLeft("p1"); // the owner departs
    expect(ended).toBe(0); // session survives — the key server-auth win
    expect(p2.isOwner).toBe(true); // ownership migrated to the remaining player
    expect(c2.ownerId).toBe("p2");
  });

  it("ends the session only on a terminal socket close", () => {
    const { p2, c2 } = start();
    let ended = 0;
    c2.onSessionEnded(() => ended++);
    p2.fireClosed(false); // transient — no end
    expect(ended).toBe(0);
    p2.fireClosed(true); // terminal — end once
    p2.fireClosed(true); // idempotent
    expect(ended).toBe(1);
  });

  it("re-syncs a client from the server on resume", () => {
    const { p2, c2 } = start();
    c2.match.state.players[0].score = -999; // desync the mirror
    p2.fireResumed(); // → {_kb:"sync"} → server re-pushes authoritative state
    expect(c2.match.state.players[0].score).toBe(0);
  });
});

describe("authority — startMatch guarding", () => {
  it("ignores a second startMatch mid-match but accepts a rematch after game over", () => {
    const { hub, c1, c2 } = session();
    const cfg = { ...DEFAULT_SETTINGS, ...FAST, eraInterval: 1, eraCount: 1 };
    c1.startMatch(cfg);
    hub.advance(1000); // → Round
    const ctl = byId(c1, c2);
    ctl[c1.match.current.id].submitWord("cat");
    expect(c1.match.state.history.length).toBe(1);

    // A stray startMatch while the match is live must NOT wipe the running match.
    c1.startMatch(cfg);
    expect(c1.match.state.phase).toBe("Round"); // still mid-match, not re-booted
    expect(c1.match.state.history.length).toBe(1); // progress preserved

    // Finish the match, then a rematch IS accepted (a fresh match boots).
    ctl[c1.match.current.id].submitWord("tiger"); // wraps era 1 → game-over settle
    hub.advance(10000);
    expect(c1.match.state.phase).toBe("GameOver");

    c1.startMatch(cfg);
    expect(c1.match.state.phase).toBe("Countdown"); // new match starting
    expect(c1.match.state.history.length).toBe(0); // fresh state
  });
});

describe("authority — intermission optimize", () => {
  const toOptimize = () => {
    const clock = { t: 0 };
    const hub = new ServerHub(clock);
    const p1 = new FakePeer(hub, "p1", "One", roster);
    const p2 = new FakePeer(hub, "p2", "Two", roster);
    const now = (): number => clock.t;
    const c1 = new ServerController(p1, now);
    const c2 = new ServerController(p2, now);
    hub.init();
    p1.fireReady();
    p2.fireReady();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, eraInterval: 1, eraCount: 2 });
    hub.advance(1000); // → Round
    const ctl = byId(c1, c2);
    ctl[c1.match.current.id].submitWord("cat"); // → t
    ctl[c1.match.current.id].submitWord("tiger"); // → r, wraps the round, ends the era
    hub.advance(10000); // burn the era-end settle → intermission → optimize
    return { hub, p1, p2, c1, c2 };
  };

  it("reaches optimize on all clients", () => {
    const { c1, c2 } = toOptimize();
    expect(c1.match.state.intermissionPhase).toBe("optimize");
    expect(c2.match.state.intermissionPhase).toBe("optimize");
  });

  it("waits for every human to lock in before advancing", () => {
    const { c1, c2 } = toOptimize();
    c2.match.skipOptimize(); // one lock-in — not enough
    expect(c1.match.state.intermissionPhase).toBe("optimize");
    c1.match.skipOptimize(); // both locked in → advances (tutorials off: → sniperBan)
    expect(c1.match.state.intermissionPhase).toBe("sniperBan");
    expect(c2.match.state.intermissionPhase).toBe("sniperBan");
  });

  it("lets a locked-in player unlock to keep editing", () => {
    const { c1, c2 } = toOptimize();
    const gid = c2.humanId;
    const locked = () => !!c1.match.state.players.find((p) => p.id === gid)?.lockedIn;
    c2.match.skipOptimize();
    expect(locked()).toBe(true);
    c2.match.unlockOptimize();
    expect(locked()).toBe(false);
    expect(c1.match.state.intermissionPhase).toBe("optimize");
  });

  it("advances optimize when the last unlocked player leaves", () => {
    const { hub, c1, c2 } = toOptimize();
    c1.match.skipOptimize(); // owner locks in; the other hasn't
    expect(c1.match.state.intermissionPhase).toBe("optimize");
    hub.playerLeft(c2.humanId); // the straggler leaves → recheck advances
    expect(c1.match.state.intermissionPhase).toBe("sniperBan");
  });
});

/*
 * Rarity dealing is a rules-layer feature (match.test.ts pins the weighting itself). What these
 * cover is that it survives the client→server move: the owner's tier settings reach the SERVER's
 * dealer, which runs once and hands every client the same bays.
 */
describe("authority — rarity-weighted dealing through the server", () => {
  /** Play one era through to its intermission so the server's dealer has run. Mirrors the
   *  `toOptimize` helper above, but takes the rarity settings under test. */
  const toFirstDeal = (overrides: Partial<AlphaChainSettings>) => {
    const s = session();
    s.c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, eraInterval: 1, eraCount: 2, ...overrides });
    s.hub.advance(1000); // → Round
    const ctl = byId(s.c1, s.c2);
    ctl[s.c1.match.current.id].submitWord("cat"); // → t
    ctl[s.c1.match.current.id].submitWord("tiger"); // → r, wraps the round, ends the era
    s.hub.advance(10000); // burn the era-end settle → intermission → deal
    return s;
  };

  const dealtIds = (c: ServerController): string[] =>
    c.match.state.players.flatMap((p) => p.bay.map((b) => b.id));

  it("deals only from the tiers the owner enabled, identically on every client", () => {
    const { c1, c2 } = toFirstDeal({
      rarityWeightCommon: 0,
      rarityWeightUncommon: 0,
      rarityWeightRare: 5,
      rarityWeightLegendary: 0,
    });
    const ids = dealtIds(c2);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(getCard(id)?.rarity).toBe(CardRarity.Rare);
    // Dealt once, server-side: both mirrors carry byte-identical bays, uids included.
    expect(c1.match.state.players[0].bay).toEqual(c2.match.state.players[0].bay);
  });

  it("tracks the owner's choice of tier — Legendary-only deals a different tier entirely", () => {
    const { c2 } = toFirstDeal({
      rarityWeightCommon: 0,
      rarityWeightUncommon: 0,
      rarityWeightRare: 0,
      rarityWeightLegendary: 1,
    });
    const ids = dealtIds(c2);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(getCard(id)?.rarity).toBe(CardRarity.Legendary);
  });

  it("skips optimize on every client when the owner disabled every tier", () => {
    // Nothing was dealt, so there is no bay to arrange: every client must fall through rather
    // than park on an empty bay for the whole card-select timer.
    const { c1, c2 } = toFirstDeal({
      rarityWeightCommon: 0,
      rarityWeightUncommon: 0,
      rarityWeightRare: 0,
      rarityWeightLegendary: 0,
    });
    expect(dealtIds(c1)).toEqual([]);
    expect(c1.match.state.intermissionPhase).not.toBe("optimize");
    expect(c2.match.state.intermissionPhase).not.toBe("optimize");
  });

  it("still deals when the owner sends an out-of-range weight (sanitized, not zeroed)", () => {
    // The two halves of this merge composed: a rejected weight falls back to its default, so it
    // must not read as "tier disabled" and silently starve the deal.
    const { c2 } = toFirstDeal({ rarityWeightCommon: 9999 });
    expect(c2.lobbySettings?.rarityWeightCommon).toBe(DEFAULT_SETTINGS.rarityWeightCommon);
    expect(dealtIds(c2).length).toBeGreaterThan(0);
  });
});

describe("authority — fault containment", () => {
  it("contains a throwing word-service call and re-converges without freezing the match", () => {
    const clock = { t: 0 };
    // A word service that throws on one specific word forces a throw deep inside
    // applyIntent — the authority must catch it, drop the intent, and re-snapshot.
    const throwingWords: Kb["words"] = {
      ...makeWords(WORDS),
      has: (_k, w) => {
        if (w === "boom") throw new Error("kaboom");
        return WORDS.has(String(w));
      },
    };
    const hub = new ServerHub(clock, throwingWords);
    const p1 = new FakePeer(hub, "p1", "One", roster);
    const p2 = new FakePeer(hub, "p2", "Two", roster);
    const now = (): number => clock.t;
    const c1 = new ServerController(p1, now);
    const c2 = new ServerController(p2, now);
    hub.init();
    p1.fireReady();
    p2.fireReady();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    hub.advance(1000);
    const upId = c1.match.current.id;

    // The throwing submission is contained (no exception escapes) and the turn does not
    // advance — the authority re-broadcasts the current state instead.
    expect(() => byId(c1, c2)[upId].submitWord("boom")).not.toThrow();
    expect(c1.match.current.id).toBe(upId);

    // The next valid intent still applies — the authority survived the throw.
    byId(c1, c2)[upId].submitWord("cat");
    expect(c1.match.state.players.find((p) => p.id === upId)?.score).toBe(3);
    expect(c2.match.state.players.find((p) => p.id === upId)?.score).toBe(3);
    expect(c1.match.current.id).not.toBe(upId);
  });
});

describe("authority — absolute-expiry timer anchoring", () => {
  it("keeps a client's shot clock on real time when frames are clamped (no drift)", () => {
    const { hub, c1, c2, clock } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, shotClockSeconds: 30 });
    hub.advance(1000); // → Round; the turn-arm snapshot anchors the clients' clocks
    const armed = c2.match.state.clockRemaining;
    expect(armed).toBeGreaterThan(25);

    // 5s of real time pass; the lagging client only gets 20 clamped 50ms frames.
    for (let i = 0; i < 20; i++) {
      clock.t += 250; // advance wall-clock without a server tick
      c2.tick(0.05);
    }
    expect(c2.match.state.clockRemaining).toBeLessThanOrEqual(armed - 4.9);
    expect(c2.match.state.clockRemaining).toBeGreaterThan(armed - 5.2);
  });

  it("drives the pre-round countdown from the absolute anchor", () => {
    const { c1, c2, clock } = session();
    const seen: number[] = [];
    c2.events.on("countdownTick", (n) => seen.push(n));
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, preRoundCountdownSeconds: 5 });
    expect(c2.match.state.phase).toBe("Countdown");
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      c2.tick(0.05);
    }
    expect(seen).toContain(4);
    expect(seen).toContain(1);
  });
});

describe("authority — game log (Play Log)", () => {
  const playToGameOver = (hub: ServerHub, c1: ServerController, c2: ServerController) => {
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, eraInterval: 1, eraCount: 1 });
    hub.advance(1000);
    const ctl = byId(c1, c2);
    const firstId = c1.match.current.id; // plays "cat" (score 3)
    ctl[firstId].submitWord("cat");
    const secondId = c1.match.current.id; // plays "tiger" (score 5)
    ctl[secondId].submitWord("tiger");
    hub.advance(10000); // settle → gameOver
    return { firstId, secondId };
  };

  it("writes one accurate Play Log entry per player when the match ends", () => {
    const { hub, p1, p2, c1, c2 } = session();
    const { firstId } = playToGameOver(hub, c1, c2);
    expect(c1.match.state.phase).toBe("GameOver");

    expect(p1.logCalls).toHaveLength(1);
    expect(p2.logCalls).toHaveLength(1);

    const byPlayer = { p1: p1.logCalls[0], p2: p2.logCalls[0] } as Record<
      string,
      Record<string, unknown>
    >;
    // The "cat" player scored 3 (2nd/loss); the "tiger" player scored 5 (1st/win).
    const loser = byPlayer[firstId];
    const winnerId = firstId === "p1" ? "p2" : "p1";
    const winner = byPlayer[winnerId];
    expect(loser).toMatchObject({ placement: 2, result: "loss", score: 3, playerCount: 2 });
    expect(winner).toMatchObject({ placement: 1, result: "win", score: 5, playerCount: 2 });
  });

  it("does not re-log on snapshots after the match ends", () => {
    const { hub, p1, c1, c2 } = session();
    playToGameOver(hub, c1, c2);
    expect(p1.logCalls).toHaveLength(1);
    hub.advance(1000);
    hub.advance(1000);
    expect(p1.logCalls).toHaveLength(1);
  });
});

describe("authority — event-delivery self-heal", () => {
  it("delivers game-over to the remaining client when a disconnect ends the match", () => {
    // Survival mode: when the current player leaves, their turn is skipped and only one
    // active player remains → the match ends. dropPlayer buffers the gameOver, but the
    // leave path clears `pending` and the platform re-broadcasts an events-less snapshot;
    // the remaining client must still reach game-over (and write its Play Log entry) by
    // re-deriving the transition from the authoritative state.
    const { hub, p2, c1, c2 } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, survivalMode: true });
    hub.advance(1000); // → Round; p1 (deterministic opener) is up
    expect(c1.match.current.id).toBe("p1");

    hub.playerLeft("p1"); // the current player disconnects → last-player-standing game-over

    expect(c2.match.state.phase).toBe("GameOver");
    expect(p2.logCalls).toHaveLength(1); // gameOver reached the remaining client's Play Log
  });

  it("drives a client that syncs mid-match onto the running phase (reconnect / late join)", () => {
    const { hub, c1, clock } = session();
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST });
    hub.advance(1000); // → Round
    // A fresh client appears mid-match (browser reload / late join): it starts blank and
    // syncs. The authority replies with an event-less fullSnapshot, so the client must
    // self-heal a phaseChanged to leave the lobby for the running match.
    const p3 = new FakePeer(hub, "p3", "Three", [...roster, { id: "p3", displayName: "Three" }]);
    const c3 = new ServerController(p3, () => clock.t);
    let seen: string | null = null;
    c3.events.on("phaseChanged", (ph) => (seen = ph));
    p3.fireReady(); // → {_kb:"sync"} → event-less fullSnapshot

    expect(c3.match.state.phase).toBe("Round");
    expect(seen).toBe("Round");
  });

  it("does not fabricate game-over for a client that syncs into a finished lobby", () => {
    // A brand-new client (blank mirror at Setup) syncing into a post-match GameOver state
    // must NOT synthesize a gameOver (which would wrongly write a Play Log entry for a match
    // it never played) nor get shoved onto the game-over screen.
    const { hub, c1, c2, clock } = session();
    playToGameOverInline(hub, c1, c2);
    expect(c1.match.state.phase).toBe("GameOver");

    const p3 = new FakePeer(hub, "p3", "Three", [...roster, { id: "p3", displayName: "Three" }]);
    const c3 = new ServerController(p3, () => clock.t);
    let over = 0;
    c3.events.on("gameOver", () => over++);
    p3.fireReady();

    expect(over).toBe(0); // no fabricated gameOver for the fresh joiner
    expect(p3.logCalls).toHaveLength(0);
  });
});

/** Play a two-player FAST match through to GameOver (shared by the rematch / sync tests). */
function playToGameOverInline(hub: ServerHub, c1: ServerController, c2: ServerController): void {
  c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, eraInterval: 1, eraCount: 1 });
  hub.advance(1000);
  const ctl = byId(c1, c2);
  ctl[c1.match.current.id].submitWord("cat");
  ctl[c1.match.current.id].submitWord("tiger");
  hub.advance(10000); // settle → GameOver
}

describe("authority — rematch lobby settings", () => {
  it("lets the owner edit settings after a match and propagates them to other clients", () => {
    const { hub, c1, c2 } = session();
    playToGameOverInline(hub, c1, c2);
    expect(c1.match.state.phase).toBe("GameOver");

    let notified = 0;
    c2.onLobbyChange(() => notified++);
    // Owner re-tunes in the rematch lobby (the finished MatchController still sits on `host`).
    c1.setLobbySettings({ ...DEFAULT_SETTINGS, ...FAST, eraCount: 9 });

    expect(c2.lobbySettings?.eraCount).toBe(9); // propagated despite the finished match
    expect(notified).toBeGreaterThan(0); // read-only lobby refreshed
  });
});

describe("authority — start guarding", () => {
  it("ignores a startMatch that would seat no players (solo owner sitting out)", () => {
    const clock = { t: 0 };
    const hub = new ServerHub(clock);
    const p1 = new FakePeer(hub, "p1", "One", [{ id: "p1", displayName: "One" }]);
    const c1 = new ServerController(p1, () => clock.t);
    hub.init();
    p1.fireReady();

    // Owner is the only member and sits out → the filter yields zero seeds. A player-less
    // MatchController would throw on every tick and hang the lobby; the start must no-op.
    c1.startMatch({ ...DEFAULT_SETTINGS, ...FAST, hostPlays: false });
    expect(c1.match.state.phase).toBe("Setup"); // never started
    expect(() => hub.advance(1000)).not.toThrow(); // no player-less controller ticking
    expect(c1.match.state.phase).toBe("Setup");
  });
});
