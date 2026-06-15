/*
 * Single-player controller: drives the MatchController locally and plays the
 * bot turns. Bots "think" for a difficulty-tuned delay (advanced by the same
 * tick() the shot clock uses, so pausing the game pauses bots too) before
 * submitting a word chosen from the dictionary.
 */

import { BOT_THINK_SECONDS, chooseBotWord } from "../game/bots";
import type { Dictionary } from "../game/dictionary";
import { MatchController, type PlayerSeed } from "../game/match";
import type { AlphaChainSettings, SubmitResult } from "../game/types";
import type { GameController } from "./controller";

export class LocalController implements GameController {
  readonly match: MatchController;
  readonly humanId = "you";
  private readonly dict: Dictionary;

  /** Seconds until the current bot submits; null when it's not a bot's turn. */
  private botCountdown: number | null = null;
  private botPlayerId: string | null = null;

  constructor(settings: AlphaChainSettings, dict: Dictionary) {
    this.dict = dict;
    const seeds: PlayerSeed[] = [{ id: this.humanId, name: "You", isBot: false }];
    const botNames = ["Vex", "Echo", "Nyx", "Rune", "Zephyr"];
    for (let i = 0; i < settings.botCount; i++) {
      seeds.push({ id: `bot${i + 1}`, name: botNames[i] ?? `Bot ${i + 1}`, isBot: true });
    }
    this.match = new MatchController(seeds, settings, {
      isWord: (w) => this.dict.has(w),
    });

    this.match.events.on("turnArmed", ({ playerIndex }) => {
      const p = this.match.state.players[playerIndex];
      if (p.isBot) this.scheduleBotTurn(p.id);
      else {
        this.botCountdown = null;
        this.botPlayerId = null;
      }
    });

    // Bots auto-arrange their bays at intermission; the human is handled by the scene.
    this.match.events.on("intermission", () => {
      for (const p of this.match.state.players) {
        if (p.isBot) this.match.autoTrimBay(p.id);
      }
    });
  }

  get events(): MatchController["events"] {
    return this.match.events;
  }

  start(): void {
    this.match.start();
  }

  tick(dt: number): void {
    // Advance bot thinking before the shot clock, so a fast bot can still beat it.
    if (this.botCountdown !== null && this.botPlayerId) {
      this.botCountdown -= dt;
      if (this.botCountdown <= 0) {
        const id = this.botPlayerId;
        this.botCountdown = null;
        this.botPlayerId = null;
        this.playBotTurn(id);
      }
    }
    this.match.tick(dt);
  }

  submitWord(word: string): SubmitResult {
    return this.match.submitWord(this.humanId, word);
  }

  destroy(): void {
    this.botCountdown = null;
    this.botPlayerId = null;
  }

  // ── Bots ─────────────────────────────────────────────────────────────────
  private scheduleBotTurn(playerId: string): void {
    const [lo, hi] = BOT_THINK_SECONDS[this.match.state.settings.botDifficulty];
    const think = lo + Math.random() * (hi - lo);
    // Never let the bot blow its own clock by thinking too long.
    const cap = Math.max(0.4, this.match.state.clockTotal - 1.2);
    this.botCountdown = Math.min(think, cap);
    this.botPlayerId = playerId;
  }

  private playBotTurn(playerId: string): void {
    const s = this.match.state;
    if (s.phase !== "Round" || this.match.current.id !== playerId) return;
    const word = chooseBotWord(this.dict, {
      requiredLetter: s.requiredLetter,
      usedWords: s.usedWords,
      bannedLetter: s.bannedLetter,
      difficulty: s.settings.botDifficulty,
    });
    if (word) this.match.submitWord(playerId, word);
    // If no word found, the bot simply lets its clock run out (handled by tick).
  }
}
