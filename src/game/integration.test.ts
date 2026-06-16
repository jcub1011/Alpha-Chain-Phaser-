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
import { Dictionary } from "./dictionary";
import { MatchController, type PlayerSeed } from "./match";
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
