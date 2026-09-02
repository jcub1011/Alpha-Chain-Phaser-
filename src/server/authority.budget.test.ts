/*
 * Sandbox work budget — the guard the shipped timeout bug got past.
 *
 * The KnockBox server runs authority.js inside Jint with a 250 ms wall-clock budget PER EXPORTED
 * CALL (KnockBox:AuthorityCallTimeoutMs) and a 1,000,000-statement cap. Overrunning either is not a
 * dropped frame: ServerAuthority tears the lobby down with AuthorityConstraintException, mid-match.
 *
 * Nothing in the browser can catch that. Solo play runs the same generator over an in-memory array
 * under a JIT, where the era-1 turn arm measured 15.5 ms and felt instant; the same call under Jint,
 * where every pool query is a CLR crossing and the loops around it are interpreted, went fatal.
 *
 * So this suite pins the cost in the one unit that is deterministic in Node AND meaningful on the
 * server: POOL QUERIES per authority call. Each is a Jint->CLR crossing, and it stands in for the
 * per-candidate work wrapped around it. A wall-clock assertion here would flake; this will not.
 *
 * The match is driven with nobody ever submitting, so every shot clock expires — which exercises
 * the no-show auto-pick (randomBuildableWord), the single most expensive call measured anywhere
 * (26,258 queries in one tick on the Full list) and a fatal path in its own right.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DictionaryTier } from "../game/types";
import { createAuthority, type Kb } from "./authority";

/* Ceilings on pool queries in a single `tick` / `applyIntent`, per dictionary tier.
 *
 * NOT wall-clock figures in disguise — they are fan-out regression markers, and the tiers get
 * separate numbers because a single ceiling loose enough for Full would not catch a Reduced
 * regression. Before the fix the era-opener tick issued 8,947 queries on Reduced and 26,349 on
 * Full, and real-Jint runs of that build went fatal on every configuration tested. After it the
 * worst call across a full match is ~1,400 (Reduced, ~2,300 at rackSize 7) and ~6,300 (Full).
 *
 * Queries alone do not decide the time — a 12,615-query call measured 27 ms under Jint while a
 * 3,585-query one measured 117 ms, because the per-candidate exact-cover work dominates on a
 * chunked rack. The wall-clock side is bounded separately, by RACK_SCAN_BUDGET and
 * NO_SHOW_SCAN_BUDGET; over 120 simulated matches Jint came in at p50 8.2 ms / p99 46.9 ms /
 * max 97.1 ms against the 250 ms budget. These ceilings are here to fail loudly if a 26-letter
 * fan-out ever comes back. */
const REDUCED_QUERY_CEILING = 3500;
const FULL_QUERY_CEILING = 9000;

function readWords(file: string): string[] {
  return readFileSync(path.resolve(__dirname, "../../public/assets", file), "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** The platform's ordering contract: length buckets ascending, ASCII-ordinal within a length,
 *  exposed as one contiguous global index. `buildPoolIndex` binary-searches against exactly this,
 *  so a stub that got it wrong would hand back ranges spanning the wrong letters — the offers would
 *  look plausible and be wrong. Mirrors the stub in authority.test.ts deliberately. */
function makePool(words: string[]): {
  byLength: Map<number, string[]>;
  all: string[];
  set: Set<string>;
} {
  const byLength = new Map<number, string[]>();
  for (const w of new Set(words)) {
    const bucket = byLength.get(w.length);
    if (bucket) bucket.push(w);
    else byLength.set(w.length, [w]);
  }
  const all: string[] = [];
  for (const len of [...byLength.keys()].sort((a, b) => a - b)) {
    const arr = byLength.get(len)!.sort();
    byLength.set(len, arr);
    for (const w of arr) all.push(w);
  }
  return { byLength, all, set: new Set(all) };
}

const POOLS: Record<string, ReturnType<typeof makePool>> = {
  en: makePool(readWords("words.txt")),
  "en-common": makePool(readWords("words-common.txt")),
};

/** kb.words over the real shipped lists, counting every query the module makes. */
function countingWords(): Kb["words"] & { queries: number } {
  const w = {
    queries: 0,
    has: (k: string, word: string): boolean => {
      w.queries++;
      return POOLS[k].set.has(String(word).toLowerCase());
    },
    count: (k: string): number => {
      w.queries++;
      return POOLS[k].all.length;
    },
    pick: (k: string, i: number): string | null => {
      w.queries++;
      return POOLS[k].all[i] ?? null;
    },
    countOfLength: (k: string, len: number): number => {
      w.queries++;
      return POOLS[k].byLength.get(len)?.length ?? 0;
    },
    pickOfLength: (k: string, len: number, i: number): string | null => {
      w.queries++;
      return POOLS[k].byLength.get(len)?.[i] ?? null;
    },
  };
  return w;
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harness(seed: number): {
  auth: ReturnType<typeof createAuthority>;
  words: ReturnType<typeof countingWords>;
  clock: { t: number };
} {
  const words = countingWords();
  const clock = { t: 1_700_000_000_000 };
  const kb: Kb = {
    now: () => clock.t,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    words,
    setLobbyOpen() {},
    setOwner() {},
    rng: mulberry(seed),
  };
  return { auth: createAuthority(kb), words, clock };
}

/** Run a whole match at the real 20 Hz tick rate, nobody submitting, and report the most expensive
 *  single authority call along with which one it was. */
function worstCall(
  settings: Record<string, unknown>,
  players: number,
  seed: number,
): { queries: number; where: string } {
  const { auth, words, clock } = harness(seed);
  auth.init(Array.from({ length: players }, (_, i) => ({ id: `p${i}`, displayName: `P${i}` })));

  let worst = 0;
  let where = "none";
  const measure = (label: string, fn: () => void): void => {
    const before = words.queries;
    fn();
    const spent = words.queries - before;
    if (spent > worst) {
      worst = spent;
      where = label;
    }
  };

  measure("startMatch", () => {
    auth.applyIntent("p0", { kind: "startMatch", settings } as never);
  });
  // 6,000 ticks at config.tickHz = 20 is five minutes of match — past the era-4 game over at the
  // defaults, so every era opener and every intermission is covered.
  for (let i = 0; i < 6000; i++) {
    clock.t += 50;
    measure(`tick@${i}`, () => auth.tick(50));
  }
  return { queries: worst, where };
}

describe("authority — per-call sandbox work budget", () => {
  const cases: {
    label: string;
    settings: Record<string, unknown>;
    players: number;
    ceiling: number;
  }[] = [
    {
      label: "Reduced dictionary, 2 players",
      settings: { enableTutorials: false },
      players: 2,
      ceiling: REDUCED_QUERY_CEILING,
    },
    {
      label: "Reduced, tutorials on",
      settings: {},
      players: 2,
      ceiling: REDUCED_QUERY_CEILING,
    },
    {
      label: "Reduced, rackSize 7",
      settings: { enableTutorials: false, rackSize: 7 },
      players: 4,
      ceiling: REDUCED_QUERY_CEILING,
    },
    {
      label: "Full dictionary, 2 players",
      settings: { enableTutorials: false, offerDictionary: DictionaryTier.Full },
      players: 2,
      ceiling: FULL_QUERY_CEILING,
    },
    {
      label: "Full dictionary, 8 players",
      settings: { enableTutorials: false, offerDictionary: DictionaryTier.Full },
      players: 8,
      ceiling: FULL_QUERY_CEILING,
    },
  ];

  for (const { label, settings, players, ceiling } of cases) {
    it(`keeps every authority call under the query ceiling — ${label}`, () => {
      // Several seeds: the expensive draws are the unlucky ones, and production seeds the match
      // from Math.random rather than a fixed stream. Every seed runs before asserting, so a failure
      // reports the true worst rather than whichever seed tripped first.
      let worst = 0;
      let detail = "";
      for (const seed of [7, 31337, 90210]) {
        const { queries, where } = worstCall(settings, players, seed);
        if (queries > worst) {
          worst = queries;
          detail = `seed ${seed}, ${where}`;
        }
      }
      expect(
        worst,
        `${label}: worst authority call was ${detail} at ${worst} pool queries`,
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it("arms the era-1 turn — the call that used to kill the lobby — without a spike", () => {
    /* The literal repro: startMatch, then tick at 20 Hz through the 4 s countdown. The tick that
     * flips the phase to Round runs beginEra -> armCurrentTurn -> generateRack inline, and with
     * requiredLetter "" that used to fan out over all 26 start letters. */
    const { auth, words, clock } = harness(4242);
    auth.init([
      { id: "p0", displayName: "A" },
      { id: "p1", displayName: "B" },
    ]);
    auth.applyIntent("p0", {
      kind: "startMatch",
      settings: { enableTutorials: false },
    } as never);

    let armQueries = -1;
    for (let i = 0; i < 200 && armQueries < 0; i++) {
      const wasCountdown = auth.snapshot()?.state.phase === "Countdown";
      const before = words.queries;
      clock.t += 50;
      auth.tick(50);
      if (wasCountdown && auth.snapshot()?.state.phase === "Round") {
        armQueries = words.queries - before;
      }
    }

    expect(armQueries, "never reached the era-1 arm tick").toBeGreaterThanOrEqual(0);
    expect(armQueries).toBeLessThanOrEqual(REDUCED_QUERY_CEILING);
    // The tick actually produced the rack it was there to produce — a cheap tick that armed
    // nothing would pass the ceiling and fail the player.
    expect(auth.snapshot()?.state.rack.length).toBeGreaterThan(0);
  });
});
