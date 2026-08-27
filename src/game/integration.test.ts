/*
 * Headless end-to-end: drive a whole match (real dictionary, bot words, eras,
 * intermissions, sniper bans) to GameOver without the browser. Exercises the
 * full FSM + scoring + bots integration the Phaser scenes sit on top of.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { chooseBotWord } from "./bots";
import {
  canConstructWordFromTiles,
  generateRack,
  verifyRackDiversity,
} from "./builder/rack";
import { Dictionary } from "./dictionary";
import { MatchController, type PlayerSeed } from "./match";
import { buildPoolIndex } from "./picker/offer";
import { dictionaryWordPool } from "./picker/wordPool";
import { DEFAULT_SETTINGS } from "./settings";

const here = dirname(fileURLToPath(import.meta.url));
const wordsPath = resolve(here, "../../public/assets/words.txt");

let dict: Dictionary;
beforeAll(() => {
  const text = readFileSync(wordsPath, "utf8");
  dict = new Dictionary(
    text
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
});

describe("full match (integration)", () => {
  it("loads the real dictionary", () => {
    expect(dict.size).toBeGreaterThan(300000);
    expect(dict.has("cat")).toBe(true);
    expect(dict.has("zzzzzz")).toBe(false);
  });

  it("plays from Setup to GameOver with a valid chain and a winner", () => {
    const seeds: PlayerSeed[] = [
      { id: "you", name: "You", isBot: false },
      { id: "b1", name: "Vex", isBot: true },
      { id: "b2", name: "Echo", isBot: true },
    ];
    const m = new MatchController(
      seeds,
      { ...DEFAULT_SETTINGS, eraCount: 3, eraInterval: 4 },
      { isWord: (w) => dict.has(w) },
    );

    let gameOver = false;
    let winnerId: string | null = null;
    m.events.on("gameOver", (e) => {
      gameOver = true;
      winnerId = e.winnerId;
    });

    m.start();
    let sawTutorial = false;
    // Drive the FSM until GameOver (or a generous iteration cap). Tutorials are
    // ON (the default), so the loop also drives the Shiritori phase and the
    // engine/tax intermission tutorial sub-phases.
    for (let i = 0; i < 5000 && !gameOver; i++) {
      const s = m.state;
      if (s.phase === "Tutorial") {
        sawTutorial = true;
        m.skipTutorial();
      } else if (s.phase === "Countdown") {
        m.tick(1);
      } else if (s.phase === "Round") {
        // Era-end settle: phase stays Round but submits are refused; tick it out.
        if (m.isSettling()) {
          m.tick(1);
          continue;
        }
        const word = chooseBotWord(dict, {
          requiredLetter: s.requiredLetter,
          usedWords: s.usedWords,
          bannedLetter: s.bannedLetter,
          difficulty: "hard",
        });
        if (word) {
          const required = s.requiredLetter; // capture before submit advances it
          if (required) expect(word[0]).toBe(required);
          const r = m.submitWord(s.players[s.currentPlayerIndex].id, word);
          // accepted === true proves the chain rule + dictionary + uniqueness held.
          expect(r.accepted).toBe(true);
        } else {
          m.tick(s.clockTotal + 1); // no word available → let the clock run out
        }
      } else if (s.phase === "Intermission") {
        if (s.intermissionPhase === "tutorial") {
          sawTutorial = true;
          m.skipTutorial();
        } else if (s.intermissionPhase === "optimize") {
          for (const p of s.players) m.autoTrimBay(p.id);
          m.tick(s.subTimerRemaining + 1); // run out the optimize timer
        } else if (s.intermissionPhase === "sniperBan") {
          m.applySniperBanAndAdvance(m.randomBanLetter());
        } else {
          m.tick(1);
        }
      }
    }

    expect(sawTutorial).toBe(true);
    expect(gameOver).toBe(true);
    expect(winnerId).not.toBeNull();
    // 3 eras × 4 rounds = 12 turns; some may time out, but most should score.
    expect(m.state.history.length).toBeGreaterThan(5);
    // Every played word is unique and a real dictionary word.
    const words = m.state.history.map((h) => h.word);
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(dict.has(w)).toBe(true);
    // Bays grew over eras (cards were dealt at intermissions).
    const totalCards = m.state.players.reduce((a, p) => a + p.bay.length, 0);
    expect(totalCards).toBeGreaterThan(0);
  });
});

/*
 * Rack generation against the FULL word list — the tier Sudden Death selects, alongside its 15s
 * clock and Survival. Nothing in rack.test.ts can protect this: on the Reduced list the fattest
 * starting letter holds 947 words, so an unbounded per-draw scan never showed up there, while here
 * `s` holds 40,310 and the same scan ran up to twelve times per turn, on the turn-arm path, inside
 * the server's Jint sandbox where there is no JIT.
 */
describe("Word Builder rack generation on the full dictionary", () => {
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("stays bounded on the fattest starting letters", () => {
    const pool = dictionaryWordPool(dict);
    const index = buildPoolIndex(pool);

    // Measured in candidates examined rather than milliseconds. A wall-clock assertion here is a
    // flake waiting to happen — this suite runs alongside 34 others — and candidates walked is the
    // quantity the generator actually controls. A census of one of these buckets costs 7,000-23,000
    // per attempt, and the old code paid that up to twelve times per draw.
    for (const letter of ["s", "p", "c"]) {
      const rng = makeRng(5150);
      const N = 50;
      let worst = 0;
      for (let i = 0; i < N; i++) {
        const r = generateRack({
          pool,
          index,
          requiredLetter: letter,
          usedWords: new Set(),
          rackSize: 7, // Sudden Death's thinner rack
          rng,
        });
        expect(r.tiles.length).toBe(7);
        expect(r.seedWord).not.toBe("");
        expect(canConstructWordFromTiles(r.seedWord, r.tiles)).toBe(true);
        worst = Math.max(worst, r.examined);
      }
      expect(worst).toBeLessThan(20_000);
    }
  });

  it("verifies diversity for a fraction of a census, and agrees with it", () => {
    const pool = dictionaryWordPool(dict);
    const index = buildPoolIndex(pool);
    const rng = makeRng(24601);
    const letters = index.startLetters();

    const ratios: number[] = [];
    for (let i = 0; i < 60; i++) {
      const letter = letters[i % letters.length];
      const r = generateRack({
        pool,
        index,
        requiredLetter: letter,
        usedWords: new Set(),
        rackSize: 7,
        rng,
      });
      const fast = verifyRackDiversity(r.tiles, pool, index, letter, new Set(), {
        seedWord: r.seedWord,
      });
      const census = verifyRackDiversity(r.tiles, pool, index, letter, new Set(), {
        exhaustive: true,
      });

      // A budget-exhausted verdict is allowed to differ — that is what the flag is for. Every other
      // draw must agree with the census exactly.
      if (!fast.budgetExhausted) expect(fast.valid).toBe(census.valid);
      if (census.examined > 0) ratios.push(fast.examined / census.examined);
    }

    // The point of the whole exercise. The median draw settles the contract on a small fraction of
    // what enumerating the bucket costs; the tail is what the budget is there to cap.
    ratios.sort((a, b) => a - b);
    expect(ratios.length).toBeGreaterThan(40);
    expect(ratios[Math.floor(ratios.length / 2)]).toBeLessThan(0.1);
  });
});
