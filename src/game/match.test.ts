import { beforeEach, describe, expect, it } from "vitest";
import { MatchController, type PlayerSeed } from "./match";
import { DEFAULT_SETTINGS, rarityDealWeights, totalCardsDealtPerPlayer } from "./settings";
import { GameMode } from "./types";
import type { AlphaChainSettings, CardRarity } from "./types";
import { cardIdentity, dealableCardIds, dealPoolCapacity } from "./cards/library";
import { DEFAULT_MAX_INSTANCES } from "./cards/card";

/** Mirror the dealer's rarity-weighted pick (match.ts:dealCards) so tests can
 *  predict which card a fixed rng roll selects from an ordered pool. Zero-weight
 *  tiers leave the pool entirely, exactly as the dealer filters them. */
const weightedPick = (
  ids: readonly string[],
  roll: number,
  tierWeight: Record<CardRarity, number> = rarityDealWeights(DEFAULT_SETTINGS),
): string => {
  const pool = ids.filter((id) => tierWeight[cardIdentity(id)!.rarity] > 0);
  const weights = pool.map((id) => tierWeight[cardIdentity(id)!.rarity]);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = roll * total;
  for (let k = 0; k < pool.length; k++) {
    r -= weights[k];
    if (r < 0) return pool[k];
  }
  return pool[pool.length - 1];
};

/** The Classic deal pool. These suites assert Classic behaviour (see makeMatch), and the
 *  dealer is mode-scoped, so the expectations must read the same list the dealer will. */
const CLASSIC_IDS = dealableCardIds(GameMode.Classic);

const WORDS = new Set(["cat", "tiger", "rabbit", "tractor", "rat", "torch", "house", "elephant"]);
const seeds: PlayerSeed[] = [
  { id: "p1", name: "You", isBot: false },
  { id: "p2", name: "Bot", isBot: true },
];

const makeMatch = (overrides: Partial<AlphaChainSettings> = {}) =>
  new MatchController(
    seeds,
    // Every case here asserts CLASSIC dealer/timeout behaviour, and DEFAULT_SETTINGS now
    // selects Picker — pin it so a Classic assertion can never silently start running Picker
    // (whose pool excludes two cards). Picker has its own suites.
    { ...DEFAULT_SETTINGS, gameMode: GameMode.Classic, enableTutorials: false, ...overrides },
    {
      isWord: (w) => WORDS.has(w),
      rng: () => 0.5,
    },
  );

describe("MatchController", () => {
  let m: MatchController;
  beforeEach(() => {
    m = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 4, eraCount: 1 });
    m.start();
    m.tick(3); // burn the countdown → first turn armed
  });

  it("starts the first turn with free choice for player 1", () => {
    expect(m.state.phase).toBe("Round");
    expect(m.current.id).toBe("p1");
    expect(m.state.requiredLetter).toBe("");
  });

  it("rejects non-dictionary words without advancing the turn", () => {
    const r = m.submitWord("p1", "zzzz");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not-a-word");
    expect(m.current.id).toBe("p1");
  });

  it("scores an accepted word and enforces chain succession", () => {
    const r = m.submitWord("p1", "cat");
    expect(r.accepted).toBe(true);
    expect(m.state.players[0].score).toBe(3); // length seed, empty bay
    expect(m.current.id).toBe("p2"); // turn advanced
    expect(m.state.requiredLetter).toBe("t"); // last letter of "cat"
  });

  it("rejects a word with the wrong starting letter", () => {
    m.submitWord("p1", "cat"); // required letter now "t"
    const r = m.submitWord("p2", "rabbit"); // starts with r, not t
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("wrong-start-letter");
  });

  it("forbids reusing a word", () => {
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger"); // t→...r
    const r = m.submitWord("p1", "cat");
    expect(r.accepted).toBe(false);
    // 'cat' would also fail the start-letter rule, but uniqueness is checked first
    expect(["already-used", "wrong-start-letter"]).toContain(r.reason);
  });

  it("ends the match after the configured eras and picks the high scorer", () => {
    // A round is one full cycle of both players; eraInterval 2, eraCount 1 → 2
    // rounds (= 4 turns) then game over.
    const m2 = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 2, eraCount: 1 });
    m2.start();
    m2.tick(3);
    let winner: string | null = "unset";
    m2.events.on("gameOver", (e) => (winner = e.winnerId));
    m2.submitWord("p1", "cat"); // round 1: p1 +3, req t
    m2.submitWord("p2", "tiger"); // round 1 wraps: p2 +5, req r
    m2.submitWord("p1", "rabbit"); // round 2: p1 +6 (total 9), req t
    m2.submitWord("p2", "torch"); // round 2 wraps → game over: p2 +5 (total 10), req h
    m2.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
    expect(m2.state.phase).toBe("GameOver");
    expect(winner).toBe("p2"); // 10 vs 9
  });

  it("opens each new era on a wildcard starting letter (not the carry-over)", () => {
    // eraInterval 1 → one full round (both players) ends era 1.
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 2 });
    m2.start();
    m2.tick(1); // era 1, p1 free choice
    m2.submitWord("p1", "cat"); // required letter → "t"
    m2.submitWord("p2", "tiger"); // wraps era 1 → intermission; word ends in "r"
    m2.tick(2.001); // burn the era-end settle window (engineAnimationSeconds + buffer)
    expect(m2.state.phase).toBe("Intermission");
    m2.applySniperBanAndAdvance("r"); // ban "r" for era 2, roll into the countdown
    m2.tick(1); // burn the era-2 countdown → beginEra
    expect(m2.state.phase).toBe("Round");
    expect(m2.state.era).toBe(2);
    // Free start: the opener is NOT forced onto "r" (which is now the ban) by the
    // previous era's carry-over.
    expect(m2.state.requiredLetter).toBe("");
  });

  it("keeps the engine order and drops the discard bin on optimize", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger"); // wraps era 1 → intermission
    m2.tick(2.001); // burn the era-end settle window into the optimize sub-phase
    expect(m2.state.phase).toBe("Intermission");
    expect(m2.state.intermissionPhase).toBe("optimize");

    const p1 = m2.state.players[0];
    p1.slots = 2;
    // uid === id here so the setPlayerBay calls (which key by uid) read cleanly.
    p1.bay = [
      { id: "A", uid: "A" },
      { id: "B", uid: "B" },
      { id: "C", uid: "C" },
    ];
    // Engine [C, A] in that order, B parked in the discard bin. The full set is
    // retained (with flags) so the player can keep rearranging during optimize.
    m2.setPlayerBay("p1", ["C", "A"], ["B"]);
    expect(p1.bay.map((b) => b.id)).toEqual(["C", "A", "B"]);
    expect(p1.bay.map((b) => !!b.discarded)).toEqual([false, false, true]);

    // Completing optimize drops the discarded card, keeping the engine order.
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["C", "A"]);
  });

  it("lets a player keep fewer cards than their slot capacity", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger");
    m2.tick(2.001);

    const p1 = m2.state.players[0];
    p1.slots = 3;
    p1.bay = [
      { id: "A", uid: "A" },
      { id: "B", uid: "B" },
      { id: "C", uid: "C" },
    ];
    m2.setPlayerBay("p1", ["B"], ["A", "C"]); // keep only one, discard the rest
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["B"]);
  });

  it("falls back to trimming the first slots when the player never edits", () => {
    const m2 = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 3 });
    m2.start();
    m2.tick(1);
    m2.submitWord("p1", "cat");
    m2.submitWord("p2", "tiger");
    m2.tick(2.001);

    const p1 = m2.state.players[0];
    p1.slots = 2;
    p1.bay = [{ id: "A" }, { id: "B" }, { id: "C" }]; // no setPlayerBay → no flags
    m2.skipOptimize();
    expect(p1.bay.map((b) => b.id)).toEqual(["A", "B"]);
  });

  it("times out the current player, docks the base penalty, and skips their turn", () => {
    m.tick(m.state.clockTotal + 1); // run the shot clock out
    expect(m.state.players[0].score).toBe(-10); // flat base timeout penalty
    expect(m.current.id).toBe("p2"); // advanced past the timed-out player
  });

  it("auto-submits the current player's drafted word when the shot clock times out", () => {
    m.setDraft("p1", "cat"); // streamed in as the player types
    m.tick(m.state.clockTotal + 1); // run the shot clock out
    expect(m.state.players[0].score).toBe(3); // "cat" was auto-submitted, not lost
    expect(m.current.id).toBe("p2"); // turn advanced via submission
    expect(m.state.requiredLetter).toBe("t");
  });

  it("takes the base timeout penalty when the drafted word is illegal", () => {
    m.setDraft("p1", "zzzz"); // not a dictionary word
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBe(-10); // bad draft falls through to a real timeout
    expect(m.current.id).toBe("p2");
  });

  it("ignores a draft from a player whose turn it is not", () => {
    m.setDraft("p2", "cat"); // p2 is not the current player
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players[0].score).toBe(-10); // p1 times out (base penalty); p2's draft unused
    expect(m.current.id).toBe("p2");
  });

  it("returns an empty id (rather than throwing) when no active players remain", () => {
    // Defensive: the FSM guards this via gameOver(), but computeLastPlaceId must
    // not index into an empty active set if it is ever called bare.
    m.state.players.forEach((p) => (p.eliminated = true));
    expect(() => m.computeLastPlaceId()).not.toThrow();
    expect(m.computeLastPlaceId()).toBe("");
  });
});

describe("MatchController — Survival (the Sudden Death preset)", () => {
  const survival = (): MatchController => {
    const m = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 4, survivalMode: true });
    m.start();
    m.tick(3); // burn the countdown → p1's turn armed
    return m;
  };

  it("eliminates a player who lets the clock run out on an empty box", () => {
    const m = survival();
    expect(m.current.id).toBe("p1");
    m.tick(m.state.clockTotal + 1); // no draft → a real timeout
    expect(m.state.players.find((p) => p.id === "p1")!.eliminated).toBe(true);
    expect(m.state.phase).toBe("GameOver"); // one survivor left, so the match stops here
  });

  it("spares a player whose drafted word auto-submits at the buzzer", () => {
    // The clock expiring is not itself fatal: producing a word the engine accepts is showing up.
    const m = survival();
    m.setDraft("p1", "cat");
    m.tick(m.state.clockTotal + 1);
    const p1 = m.state.players.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(false);
    expect(p1.score).toBeGreaterThan(0);
  });

  it("eliminates a player whose drafted word is rejected at the buzzer", () => {
    const m = survival();
    m.setDraft("p1", "zzzz"); // not in WORDS → the auto-submit fails, so it is a real timeout
    m.tick(m.state.clockTotal + 1);
    expect(m.state.players.find((p) => p.id === "p1")!.eliminated).toBe(true);
  });
});

describe("MatchController — dropPlayer (mid-match departure)", () => {
  let m: MatchController;
  beforeEach(() => {
    m = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 4, eraCount: 1 });
    m.start();
    m.tick(3); // burn the countdown → p1's turn armed
  });

  it("skips a departed player's live turn with no timeout penalty, keeping them scored", () => {
    m.state.players[0].score = 7; // give the leaver a score to prove it is untouched
    expect(m.current.id).toBe("p1"); // p1 is up (from beforeEach)
    let timedOut = false;
    m.events.on("timeout", () => (timedOut = true));

    m.dropPlayer("p1"); // p1 disconnects on their own turn

    expect(timedOut).toBe(false); // no timeout theater / penalty fired
    expect(m.current.id).toBe("p2"); // turn advanced past the leaver immediately
    const gone = m.state.players.find((p) => p.id === "p1");
    expect(gone?.eliminated).toBe(true); // marked out so the order skips them...
    expect(gone?.score).toBe(7); // ...but their score stays on the leaderboard, untouched
  });

  it("only marks a non-current departed player, leaving the live turn intact", () => {
    expect(m.current.id).toBe("p1");
    const clockBefore = m.state.clockRemaining;

    m.dropPlayer("p2"); // the player who is NOT up leaves

    expect(m.state.players.find((p) => p.id === "p2")?.eliminated).toBe(true);
    expect(m.current.id).toBe("p1"); // p1's turn is untouched
    expect(m.state.clockRemaining).toBe(clockBefore); // clock not re-armed
  });

  it("skips an eliminated player in the turn order on the next advance", () => {
    const three: PlayerSeed[] = [
      { id: "p1", name: "One", isBot: false },
      { id: "p2", name: "Two", isBot: false },
      { id: "p3", name: "Three", isBot: false },
    ];
    const m3 = new MatchController(
      three,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 3,
        eraInterval: 4,
      },
      { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
    );
    m3.start();
    m3.tick(3); // → Round, free starting letter

    // Drop whoever is up NEXT (not the current player), then let the current player
    // submit — the advance must jump over the eliminated seat to the one after it.
    const order = m3.state.players.map((p) => p.id);
    const cur = m3.state.currentPlayerIndex;
    const nextId = order[(cur + 1) % 3];
    const afterId = order[(cur + 2) % 3];

    m3.dropPlayer(nextId);
    expect(m3.current.id).toBe(order[cur]); // dropping a non-current player didn't advance
    m3.submitWord(order[cur], "cat"); // free letter, valid word
    expect(m3.current.id).toBe(afterId); // skipped the eliminated seat
  });

  it("is idempotent and ignores an unknown id", () => {
    m.dropPlayer("p1");
    expect(m.current.id).toBe("p2");
    expect(() => m.dropPlayer("p1")).not.toThrow(); // already eliminated → no-op
    expect(() => m.dropPlayer("ghost")).not.toThrow(); // unknown id → no-op
    expect(m.current.id).toBe("p2");
  });
});

describe("shot-clock timeout penalty", () => {
  const armed = (overrides: Partial<AlphaChainSettings> = {}) => {
    const m = makeMatch({ preRoundCountdownSeconds: 3, eraInterval: 4, eraCount: 1, ...overrides });
    m.start();
    m.tick(3); // burn countdown → p1's turn armed (empty bay → 20s clock)
    return m;
  };
  const runClockOut = (m: MatchController) => m.tick(m.state.clockTotal + 1);

  it("docks the flat base penalty when a player times out with no clock cards", () => {
    const m = armed();
    m.state.players[0].score = 50;
    runClockOut(m);
    expect(m.state.players[0].score).toBe(40); // base 10
    expect(m.current.id).toBe("p2"); // turn still advances
  });

  it("stacks each glass-cannon card's drain on top of the base", () => {
    const m = armed();
    m.state.players[0].bay = [{ id: "Redline" }];
    m.state.players[0].score = 100;
    runClockOut(m);
    expect(m.state.players[0].score).toBe(66); // 100 − (10 + 24)
  });

  it("lets the score go negative (consistent with drains)", () => {
    const m = armed();
    m.state.players[0].bay = [{ id: "Redline" }]; // base 10 + 24
    m.state.players[0].score = 5;
    runClockOut(m);
    expect(m.state.players[0].score).toBe(-29); // 5 − 34
  });

  it("emits a timed-out submission carrying the penalty breakdown", () => {
    const m = armed();
    m.state.players[0].bay = [{ id: "TheVault" }];
    m.state.players[0].score = 20;
    let captured: import("./types").Submission | undefined;
    m.events.on("submission", ({ submission }) => {
      if (submission.timedOut) captured = submission;
    });
    let penalty = -1;
    m.events.on("timeout", (e) => (penalty = e.penalty));
    runClockOut(m);
    expect(captured?.timedOut).toBe(true);
    expect(captured?.score).toBe(-22); // −(10 + 12)
    expect(penalty).toBe(22);
    expect(m.state.players[0].score).toBe(-2); // 20 − 22
  });

  it("Insurance refunds the base penalty (general onTimeout-style reaction)", () => {
    const m = armed();
    m.state.players[0].bay = [{ id: "Insurance" }];
    m.state.players[0].score = 30;
    runClockOut(m);
    expect(m.state.players[0].score).toBe(30); // −10 base + 10 refund = net 0
  });

  it("breaks the Crescendo clean-streak on a real timeout", () => {
    const m = armed();
    m.services.crescendoStreak.increment("p1"); // p1 had an unbroken clean run
    expect(m.services.crescendoStreak.get("p1")).toBe(1);
    runClockOut(m); // p1 times out → the run is no longer clean
    expect(m.services.crescendoStreak.get("p1")).toBe(0);
  });
});

describe("shot-clock submit grace window", () => {
  // Grace is a MatchDep (host-side latency leeway), not a setting. Each turn lingers
  // at clockRemaining 0 for `grace` seconds before timing out, so a buzzer-time submit
  // still in flight over the network can land. The crossing must be driven in small
  // ticks: the grace is decremented by the same dt as the clock, so one coarse tick
  // that overshoots 0 by more than `grace` would time out immediately (intended —
  // that represents more than a grace window of real time having elapsed).
  const makeGraced = (grace: number) => {
    const m = new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 3,
        eraInterval: 4,
        eraCount: 1,
      },
      { isWord: (w) => WORDS.has(w), rng: () => 0.5, submitGraceSeconds: grace },
    );
    m.start();
    m.tick(3); // burn countdown → p1's turn armed (empty bay → 20s clock)
    return m;
  };
  const crossToZero = (m: MatchController) => {
    m.tick(m.state.clockTotal - 0.05); // run down to ~0.05s left
    m.tick(0.1); // overshoot the residue so clockRemaining clamps to exactly 0;
    //              consumes only 0.1 of any grace window (no float underflow above 0)
  };

  it("holds the turn open during the grace window so a late submit still lands", () => {
    const m = makeGraced(1);
    let timedOut = false;
    m.events.on("timeout", () => (timedOut = true));
    crossToZero(m);
    expect(m.state.clockRemaining).toBe(0);
    expect(timedOut).toBe(false); // still in grace — no timeout yet
    expect(m.current.id).toBe("p1"); // turn not advanced

    const r = m.submitWord("p1", "cat"); // arrives "late" (clock at 0) but within grace
    expect(r.accepted).toBe(true);
    expect(timedOut).toBe(false);
    expect(m.state.players[0].score).toBe(3);
    expect(m.current.id).toBe("p2"); // accepted submit advanced the turn
  });

  it("times out once the grace window elapses with no submit", () => {
    const m = makeGraced(1);
    let timedOut = false;
    m.events.on("timeout", () => (timedOut = true));
    crossToZero(m); // grace now ~0.9s
    m.tick(0.5);
    expect(timedOut).toBe(false); // grace ~0.4s left
    m.tick(0.5);
    expect(timedOut).toBe(true); // grace exhausted → timeout
    expect(m.state.players[0].score).toBe(-10);
    expect(m.current.id).toBe("p2");
  });

  it("times out immediately at 0 when grace is disabled (solo/default)", () => {
    const m = makeGraced(0);
    let timedOut = false;
    m.events.on("timeout", () => (timedOut = true));
    crossToZero(m);
    expect(timedOut).toBe(true); // no grace → byte-for-byte the old behaviour
    expect(m.current.id).toBe("p2");
  });
});

describe("turn order shuffles every era", () => {
  const threeSeeds: PlayerSeed[] = [
    { id: "p1", name: "P1", isBot: false },
    { id: "p2", name: "P2", isBot: true },
    { id: "p3", name: "P3", isBot: true },
  ];
  // Fisher-Yates with rng 0.5 over [p1,p2,p3]: i=2 swaps idx2↔idx1 → [p1,p3,p2];
  // i=1 is a no-op. So the shuffled order is deterministic for this RNG.
  const makeThree = (rng: () => number) =>
    new MatchController(
      threeSeeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 1,
        eraInterval: 9,
        eraCount: 1,
      },
      { isWord: (w) => WORDS.has(w), rng },
    );

  it("reorders the players and opens on the first live player of the shuffle", () => {
    const m = makeThree(() => 0.5);
    m.start();
    m.tick(1); // burn countdown → beginEra shuffles, then arms the opener
    expect(m.state.players.map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    expect(m.state.currentPlayerIndex).toBe(0);
    expect(m.current.id).toBe("p1");
  });

  it("skips an eliminated player when picking the era opener", () => {
    const m = makeThree(() => 0.5);
    // Eliminate p1 before the era-1 shuffle. With rng 0.5 the order becomes
    // [p1(dead), p3, p2], so the opener must skip seat 0 to the first live player.
    m.state.players.find((p) => p.id === "p1")!.eliminated = true;
    m.start();
    m.tick(1);
    expect(m.state.currentPlayerIndex).toBe(1);
    expect(m.current.id).toBe("p3");
    expect(m.current.eliminated).toBe(false);
  });
});

describe("Zero-Point Tax + Tax Collector", () => {
  it("zeroes a banned-letter word but the holder still scores 0 if last place exempt", () => {
    const m = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 9, eraCount: 1 });
    m.start();
    m.tick(1);
    // Force a banned letter and clear the last-place exemption by giving p1 a lead.
    m.state.players[0].score = 100;
    m.state.bannedLetter = "t";
    const r = m.submitWord("p1", "cat"); // contains 't' → taxed (p1 not last place)
    expect(r.accepted).toBe(true);
    expect(r.submission!.taxed).toBe(true);
    expect(r.submission!.score).toBe(0);
  });
});

describe("per-card deal caps", () => {
  // Drives a 2-player match through the end of era 1 into the optimize sub-phase,
  // by which point dealCards has dealt `modifiersDealtPerEra` cards to each player.
  // The human p1 is NOT auto-trimmed during optimize, so its bay holds the full
  // dealt set for inspection. rng 0.5 keeps p1 the era opener (matches the other
  // intermission tests) and makes the deal deterministic.
  const driveToIntermission = (modifiersDealtPerEra: number, mode: GameMode = GameMode.Classic) => {
    const m = new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: mode,
        enableTutorials: false,
        preRoundCountdownSeconds: 1,
        eraInterval: 1,
        eraCount: 3,
        modifiersDealtPerEra,
      },
      { isWord: (w) => WORDS.has(w), rng: () => 0.5 },
    );
    m.start();
    m.tick(1);
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger"); // wraps era 1 → intermission
    m.tick(2.001); // burn the era-end settle window into optimize
    expect(m.state.phase).toBe("Intermission");
    expect(m.state.intermissionPhase).toBe("optimize");
    return m;
  };

  const capOf = (id: string) => cardIdentity(id)?.maxInstances ?? DEFAULT_MAX_INSTANCES;
  const countIn = (bay: { id: string }[], id: string) => bay.filter((b) => b.id === id).length;

  it("declares the configured deviating caps; everything else defaults", () => {
    expect(capOf("Sesquipedalian")).toBe(1);
    expect(capOf("Blindfold")).toBe(1);
    expect(capOf("RouletteWheel")).toBe(1);
    expect(capOf("TollBooth")).toBe(1);
    expect(capOf("Speedracer")).toBe(2);
    // The one card capped ABOVE the default, so five compounding glasses stay reachable.
    expect(capOf("MagnifyingGlass")).toBe(5);
    // No override → falls back to the shared default.
    expect(cardIdentity("TheAnchor")?.maxInstances).toBeUndefined();
    expect(capOf("TheAnchor")).toBe(DEFAULT_MAX_INSTANCES);
  });

  it("caps a repeatedly-drawn card at its maxInstances", () => {
    const p1 = driveToIntermission(10).state.players[0];
    expect(p1.bay.length).toBe(10);
    // With a fixed rng the dealer keeps re-selecting the same card until it hits
    // its cap, then moves on — so the first-picked card lands on EXACTLY its cap
    // (without the cap it would have swallowed all 10 deals). The pick is now
    // rarity-weighted, so derive it via the same weighted algorithm.
    const firstPicked = weightedPick(CLASSIC_IDS, 0.5);
    expect(countIn(p1.bay, firstPicked)).toBe(capOf(firstPicked));
    for (const id of CLASSIC_IDS) {
      expect(countIn(p1.bay, id)).toBeLessThanOrEqual(capOf(id));
    }
  });

  it("deals each mode only its own cards", () => {
    /* Exhaust the pool in both modes and check the split from the DEALER's side, so this fails if
     * the dealer and dealableCardIds ever disagree — the failure the mode-scoping exists to
     * prevent, since the lobby's capacity warning reads the same list. */
    const picker = driveToIntermission(1000, GameMode.Picker).state.players[0];
    const classic = driveToIntermission(1000, GameMode.Classic).state.players[0];

    // Classic-only cards never reach a Picker bay...
    expect(countIn(picker.bay, "Blindfold")).toBe(0);
    expect(countIn(picker.bay, "Insurance")).toBe(0);
    expect(countIn(classic.bay, "Blindfold")).toBe(1);
    expect(countIn(classic.bay, "Insurance")).toBe(3);

    // ...and Preference Cards never reach a Classic one.
    for (const id of ["Sieve", "Winnower", "TunnelVision", "Sentinel"]) {
      expect(countIn(classic.bay, id), id).toBe(0);
      expect(countIn(picker.bay, id), id).toBeGreaterThan(0);
    }
    // Picker's pool is the larger of the two: −4 copies withheld, +17 gained.
    expect(picker.bay.length - classic.bay.length).toBe(13);
  });

  it("stops dealing early once every card is capped (no over-deal, no hang)", () => {
    // Ask for far more than the pool can supply; dealing must stop at the summed
    // caps rather than loop. This is the all-cards-exhausted safety path.
    const p1 = driveToIntermission(1000).state.players[0];
    const expectedTotal = CLASSIC_IDS.reduce((sum, id) => sum + capOf(id), 0);
    expect(p1.bay.length).toBe(expectedTotal);
    // Exhaustion means every card sits at exactly its cap — including unique
    // (maxInstances: 1) cards like Sesquipedalian.
    for (const id of CLASSIC_IDS) {
      expect(countIn(p1.bay, id)).toBe(capOf(id));
    }
    expect(countIn(p1.bay, "Sesquipedalian")).toBe(1);
  });
});

describe("rarity-weighted dealing", () => {
  // A simple deterministic LCG so we can prove two runs with the same seed deal
  // identical bays under a *varying* (non-constant) rng.
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // Drive one full round (one valid word per player, succession-respecting,
  // regardless of which player the rng makes the opener) and settle into the
  // era-1 intermission, where dealCards has run for every player.
  const driveOneRound = (
    rng: () => number,
    modifiersDealtPerEra: number,
    overrides: Partial<AlphaChainSettings> = {},
  ) => {
    const m = new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 1,
        eraInterval: 1,
        eraCount: 3,
        modifiersDealtPerEra,
        ...overrides,
      },
      { isWord: (w) => WORDS.has(w), rng },
    );
    m.start();
    m.tick(1);
    for (let i = 0; i < seeds.length; i++) {
      const cur = m.state.players[m.state.currentPlayerIndex];
      const req = m.state.requiredLetter;
      const word = [...WORDS].find(
        (w) => (req === "" || w[0] === req) && !m.state.usedWords.has(w),
      )!;
      m.submitWord(cur.id, word);
    }
    m.tick(2.001); // settle into optimize
    return m;
  };

  it("surfaces commoner rarities far more often than rarer ones", () => {
    // Sweep a uniform spread of rolls; the rarity mix of the first pick mirrors
    // the deal weights (10 / 5 / 2 / 1). Assert the monotonic ordering holds and
    // commons dominate legendaries by a wide margin.
    const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    const N = 150;
    for (let i = 0; i < N; i++) {
      const rarity = cardIdentity(weightedPick(CLASSIC_IDS, (i + 0.5) / N))!.rarity;
      counts[rarity]++;
    }
    expect(counts.common).toBeGreaterThan(counts.uncommon);
    expect(counts.uncommon).toBeGreaterThan(counts.rare);
    expect(counts.rare).toBeGreaterThan(counts.legendary);
    expect(counts.common).toBeGreaterThan(counts.legendary * 5);
  });

  it("deals deterministically: same seed → identical bays (KnockBox replication)", () => {
    const drive = () => driveOneRound(lcg(20260629), 8).state.players[0].bay.map((b) => b.id);
    const a = drive();
    expect(a.length).toBeGreaterThan(0); // guard: the deal actually happened
    expect(drive()).toEqual(a); // same seed → byte-identical bay (no rng divergence)
  });
});

// ── Host-configurable rarity weights (the rarityWeight* settings) ─────────────

describe("host-configured rarity weights", () => {
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // One full round into the era-1 intermission, where every player has been dealt.
  const driveWithWeights = (overrides: Partial<AlphaChainSettings>, rng = lcg(20260808)) => {
    const m = new MatchController(
      seeds,
      {
        ...DEFAULT_SETTINGS,
        gameMode: GameMode.Classic,
        enableTutorials: false,
        preRoundCountdownSeconds: 1,
        eraInterval: 1,
        eraCount: 3,
        modifiersDealtPerEra: 8,
        ...overrides,
      },
      { isWord: (w) => WORDS.has(w), rng },
    );
    m.start();
    m.tick(1);
    for (let i = 0; i < seeds.length; i++) {
      const cur = m.state.players[m.state.currentPlayerIndex];
      const req = m.state.requiredLetter;
      const word = [...WORDS].find(
        (w) => (req === "" || w[0] === req) && !m.state.usedWords.has(w),
      )!;
      m.submitWord(cur.id, word);
    }
    m.tick(2.001); // settle into optimize
    return m;
  };

  const ONLY_RARE = {
    rarityWeightCommon: 0,
    rarityWeightUncommon: 0,
    rarityWeightRare: 1,
    rarityWeightLegendary: 0,
  };

  const raritiesOf = (m: MatchController) =>
    m.state.players.flatMap((p) => p.bay.map((b) => cardIdentity(b.id)!.rarity));

  it('deals only the tiers with weight ("Rares Only")', () => {
    const dealt = raritiesOf(driveWithWeights(ONLY_RARE));
    expect(dealt.length).toBeGreaterThan(0); // guard: the deal actually happened
    expect(new Set(dealt)).toEqual(new Set(["rare"]));
  });

  it("inverts the default mix when the rare tiers carry all the weight", () => {
    // Proves the setting — not the old 10/5/2/1 constant — drives the pick: Legendaries
    // are the ONLY thing dealt, which the defaults would make vanishingly unlikely.
    const dealt = raritiesOf(
      driveWithWeights({
        rarityWeightCommon: 0,
        rarityWeightUncommon: 0,
        rarityWeightRare: 0,
        rarityWeightLegendary: 1,
      }),
    );
    expect(new Set(dealt)).toEqual(new Set(["legendary"]));
  });

  it("deals nothing when every tier is zeroed (no hang, no biased fallback)", () => {
    // The pool empties, so dealCards breaks out early. Without the zero-weight filter
    // totalWeight would be 0 and the float-drift fallback would deal the same last
    // card every time — the bug this guards.
    const m = driveWithWeights({
      rarityWeightCommon: 0,
      rarityWeightUncommon: 0,
      rarityWeightRare: 0,
      rarityWeightLegendary: 0,
    });
    for (const p of m.state.players) expect(p.bay).toEqual([]);
  });

  it("respects per-card caps within a single enabled tier", () => {
    // Rares only, asking for far more than the tier can supply: every rare lands at
    // exactly its cap and nothing exceeds it (Toll Booth 1, Magnifying Glass 5, rest 3).
    const m = driveWithWeights({ ...ONLY_RARE, modifiersDealtPerEra: 1000 });
    const bay = m.state.players[0].bay;
    const rares = CLASSIC_IDS.filter((id) => cardIdentity(id)!.rarity === "rare");
    expect(bay.length).toBe(
      dealPoolCapacity(rarityDealWeights({ ...DEFAULT_SETTINGS, ...ONLY_RARE }), GameMode.Classic),
    );
    for (const id of rares) {
      expect(bay.filter((b) => b.id === id).length).toBe(
        cardIdentity(id)!.maxInstances ?? DEFAULT_MAX_INSTANCES,
      );
    }
  });

  it("dealPoolCapacity is the dealer's real ceiling, not an estimate", () => {
    // The lobby warns by comparing this number against totalCardsDealtPerPlayer, so the two
    // sides have to agree: ask for far more than a single tier holds and the bay lands on
    // exactly the advertised capacity. Legendary-only is the tightest case (7 copies).
    const ONLY_LEGENDARY = {
      rarityWeightCommon: 0,
      rarityWeightUncommon: 0,
      rarityWeightRare: 0,
      rarityWeightLegendary: 1,
    };
    const capacity = dealPoolCapacity(
      rarityDealWeights({ ...DEFAULT_SETTINGS, ...ONLY_LEGENDARY }),
      GameMode.Classic,
    );
    const m = driveWithWeights({ ...ONLY_LEGENDARY, modifiersDealtPerEra: 1000 });
    expect(m.state.players[0].bay.length).toBe(capacity);
    // And it really is short of a default match's ask — the silent mid-match dry-up the
    // lobby now warns about, rather than a theoretical edge case.
    expect(capacity).toBeLessThan(totalCardsDealtPerPlayer(DEFAULT_SETTINGS));
  });

  it("skips the optimize sub-phase when the deal left every bay empty", () => {
    // Nobody can arrange an empty bay, so holding everyone for intermissionCardSelectSeconds
    // is dead time. Reached via a dry pool, and via Cards Per Era 0 (this case).
    const m = driveWithWeights({ modifiersDealtPerEra: 0 });
    for (const p of m.state.players) expect(p.bay).toEqual([]);
    expect(m.state.intermissionPhase).not.toBe("optimize");
    expect(m.state.intermissionPhase).toBe("sniperBan"); // straight on to the ban
  });

  it("still runs optimize when cards were dealt", () => {
    // Guard on the skip above: it must not swallow an ordinary intermission.
    const m = driveWithWeights({});
    expect(m.state.players[0].bay.length).toBeGreaterThan(0);
    expect(m.state.intermissionPhase).toBe("optimize");
  });

  it("stays deterministic under non-default weights (same seed → identical bays)", () => {
    const drive = () =>
      driveWithWeights(
        { rarityWeightCommon: 1, rarityWeightLegendary: 20 },
        lcg(4242),
      ).state.players[0].bay.map((b) => b.id);
    const a = drive();
    expect(a.length).toBeGreaterThan(0);
    expect(drive()).toEqual(a);
  });
});

describe("Submission.era stamping", () => {
  it("stamps each submission with the era it was played in", () => {
    const m = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 2 });
    m.start();
    m.tick(1);
    m.submitWord("p1", "cat"); // era 1
    m.submitWord("p2", "tiger"); // era 1, wraps → intermission
    m.tick(2.001);
    expect(m.state.history.every((h) => h.era === 1)).toBe(true);

    m.applySniperBanAndAdvance("z"); // → era 2 countdown
    m.tick(1);
    m.submitWord("p1", "rat"); // era 2
    expect(m.state.history[m.state.history.length - 1]?.era).toBe(2);
  });
});

describe("Sniper ban — repeat rule + history", () => {
  /** Drive a single-round era to its sniper ban with the given repeat rule. */
  const toBan = (overrides: Partial<AlphaChainSettings>) => {
    const m = makeMatch({ preRoundCountdownSeconds: 1, eraInterval: 1, eraCount: 9, ...overrides });
    m.start();
    m.tick(1);
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger"); // wraps era 1 → intermission
    m.tick(2.001);
    return m;
  };

  it("records each banned letter in bannedLetterHistory", () => {
    const m = toBan({ banRepeatRule: "AllowRepeat" });
    m.applySniperBanAndAdvance("q");
    expect(m.state.bannedLetterHistory).toEqual(["q"]);
    expect(m.state.bannedLetter).toBe("q");
  });

  it("NoConsecutive rejects re-banning last era's letter (random legal fallback)", () => {
    const m = toBan({ banRepeatRule: "NoConsecutive" });
    m.applySniperBanAndAdvance("q"); // era 2 ban = q
    m.tick(1);
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger");
    m.tick(2.001);
    m.applySniperBanAndAdvance("q"); // illegal (consecutive) → falls back to a legal letter
    expect(m.state.bannedLetter).not.toBe("q");
  });

  it("AllowRepeat lets the same letter be banned again", () => {
    const m = toBan({ banRepeatRule: "AllowRepeat" });
    m.applySniperBanAndAdvance("q");
    m.tick(1);
    m.submitWord("p1", "cat");
    m.submitWord("p2", "tiger");
    m.tick(2.001);
    m.applySniperBanAndAdvance("q"); // allowed
    expect(m.state.bannedLetter).toBe("q");
  });
});

describe("dealEngineCardsFirstEra", () => {
  it("deals an opening hand and runs optimize before era 1 when enabled", () => {
    const m = makeMatch({
      preRoundCountdownSeconds: 1,
      dealEngineCardsFirstEra: true,
      modifiersDealtPerEra: 3,
    });
    m.start();
    // Pre-era-1 setup intermission: cards dealt, optimize sub-phase active.
    expect(m.state.phase).toBe("Intermission");
    expect(m.state.intermissionPhase).toBe("optimize");
    expect(m.state.players[0].bay.length).toBe(3);
    expect(m.state.era).toBe(1);

    m.skipOptimize(); // → countdown (no sniper ban before era 1)
    expect(m.state.phase).toBe("Countdown");
    // The setup path bypasses the era-boundary isNew reset, so completeOptimize must
    // clear it here — otherwise the opening hand would re-default into the discard bin
    // at the era-1-end optimize.
    expect(m.state.players.every((p) => p.bay.every((b) => !b.isNew))).toBe(true);
    m.tick(1);
    expect(m.state.phase).toBe("Round");
    expect(m.state.era).toBe(1);
  });

  it("starts era 1 with empty bays when disabled (default)", () => {
    const m = makeMatch({ preRoundCountdownSeconds: 1, dealEngineCardsFirstEra: false });
    m.start();
    expect(m.state.phase).toBe("Countdown");
    expect(m.state.players[0].bay.length).toBe(0);
  });
});
