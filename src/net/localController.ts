/*
 * Single-player controller: drives the MatchController locally and plays the
 * bot turns. Bots "think" for a difficulty-tuned delay (advanced by the same
 * tick() the shot clock uses, so pausing the game pauses bots too) before
 * submitting a word chosen from the dictionary.
 */

import {
  BOT_CANDIDATE_COUNT,
  BOT_THINK_SECONDS,
  chooseBotWordScored,
  planBotBay,
} from "../game/bots";
import type { Dictionary } from "../game/dictionary";
import { MatchController, type PlayerSeed } from "../game/match";
import type { AlphaChainSettings, SubmitResult } from "../game/types";
import { createLogger } from "../log";
import type { GameController } from "./controller";

const log = createLogger("local");

export class LocalController implements GameController {
  readonly match: MatchController;
  readonly humanId = "you";
  private readonly dict: Dictionary;

  /** Seconds until the current bot submits; null when it's not a bot's turn. */
  private botCountdown: number | null = null;
  private botPlayerId: string | null = null;

  /**
   * Debug-only: freezes every gameplay timer (shot clock, countdown, bots) by
   * short-circuiting tick(). Toggled from <ac-app> via Esc. Solo-only by design
   * — it lives here, not on GameController, so networked play never gets it.
   */
  private _paused = false;

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
      if (p?.isBot) this.scheduleBotTurn(p.id);
      else {
        this.botCountdown = null;
        this.botPlayerId = null;
      }
    });

    // Bots build + trim their engine when the optimize sub-phase opens (fired AFTER
    // any intermission tutorials, so the bay and slot count are final). The human's
    // optimize is handled by the scene.
    this.match.events.on("subPhaseChanged", ({ intermissionPhase }) => {
      if (intermissionPhase !== "optimize") return;
      for (const p of this.match.state.players) {
        if (!p.isBot) continue;
        const { engine, discard } = planBotBay(p.bay, p.slots, this.botScoreOpts(p.slots));
        this.match.setPlayerBay(p.id, engine, discard);
      }
    });
  }

  /** Pure scoring context bots use to evaluate candidate words / bay orderings.
   *  `slots` is the scoring bot's bay capacity (Booster Pack scales by it). */
  private botScoreOpts(slots: number) {
    const s = this.match.state;
    return {
      prevWordLength: this.match.lastWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      baseClockSeconds: s.settings.shotClockSeconds,
      era: s.era,
      slots,
      history: s.history,
    };
  }

  get events(): MatchController["events"] {
    return this.match.events;
  }

  start(): void {
    log.info(
      `solo match starting (${this.match.state.players.length} players, ${this.match.state.settings.botDifficulty} bots)`,
    );
    this.match.start();
  }

  /** Whether all timers are currently frozen (debug pause). */
  get paused(): boolean {
    return this._paused;
  }

  /** Flip the debug pause and report the new state. */
  togglePause(): boolean {
    this._paused = !this._paused;
    return this._paused;
  }

  tick(dt: number): void {
    // Debug pause: freeze the shot clock, countdown, and bot thinking together.
    if (this._paused) return;
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

  reportDraft(): void {
    // No-op: solo auto-submits on timeout via the synchronous UI clockTick path
    // (ac-word-entry), so the engine's draft auto-submit never needs to fire here.
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
    const player = s.players.find((p) => p.id === playerId);
    const word = chooseBotWordScored(this.dict, {
      requiredLetter: s.requiredLetter,
      usedWords: s.usedWords,
      bannedLetter: s.bannedLetter,
      difficulty: s.settings.botDifficulty,
      bay: player?.bay ?? [],
      scoreOpts: this.botScoreOpts(player?.slots ?? 0),
      candidateCount: BOT_CANDIDATE_COUNT[s.settings.botDifficulty],
    });
    if (word) {
      log.debug(`bot ${playerId} plays "${word}"`);
      this.match.submitWord(playerId, word);
    } else {
      // No valid word found — the bot lets its clock run out (handled by tick).
      log.warn(`bot ${playerId} found no valid word (letter="${s.requiredLetter}")`);
    }
  }
}
