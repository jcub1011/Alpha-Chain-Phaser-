/*
 * MatchController — the Alpha Chain finite-state machine and single source of
 * truth for one match. Pure logic: it is driven by explicit calls (start, tick,
 * submitWord, …) and a small set of injected dependencies (a word validator and
 * an RNG), so it is fully deterministic and unit-testable. Bots, real timers,
 * and human input live in the driver/presentation layers, which listen to the
 * events emitted here.
 *
 * Phase flow:  Setup → Countdown → Round×eraInterval → Intermission → … → GameOver
 */

import { DEALABLE_CARD_IDS, getCard } from "./cards/library";
import { Emitter } from "./emitter";
import { armedClockSeconds, scoreWord } from "./scoring";
import {
  legalBanLetters,
  MODIFIER_SLOTS_START,
  isVowel,
} from "./settings";
import type {
  AlphaChainSettings,
  BayCard,
  GamePhase,
  MatchState,
  PlayerState,
  Submission,
  SubmitResult,
} from "./types";

export interface PlayerSeed {
  id: string;
  name: string;
  isBot: boolean;
}

export interface MatchDeps {
  /** Dictionary validation (browser supplies the real Set-backed checker). */
  isWord: (word: string) => boolean;
  /** Injectable RNG (defaults to Math.random) for deterministic tests. */
  rng?: () => number;
}

export interface MatchEvents {
  phaseChanged: GamePhase;
  countdownTick: number; // seconds remaining
  turnArmed: { playerIndex: number; requiredLetter: string; clockTotal: number };
  clockTick: number; // shot-clock seconds remaining
  submission: { submission: Submission; bounties: { playerId: string; amount: number }[] };
  rejected: { playerId: string; reason: NonNullable<SubmitResult["reason"]> };
  timeout: { playerId: string };
  intermission: { lastPlaceId: string; dealt: Record<string, string[]> };
  gameOver: { winnerId: string | null; standings: PlayerState[] };
}

export class MatchController {
  readonly events = new Emitter<MatchEvents>();
  private readonly rng: () => number;
  private readonly isWord: (w: string) => boolean;

  private countdownRemaining = 0;
  private prevWordLength = 0;
  readonly state: MatchState;

  constructor(seeds: PlayerSeed[], settings: AlphaChainSettings, deps: MatchDeps) {
    this.isWord = deps.isWord;
    this.rng = deps.rng ?? Math.random;
    const players: PlayerState[] = seeds.map((s, i) => ({
      id: s.id,
      name: s.name,
      isBot: s.isBot,
      accentIndex: i,
      score: 0,
      eliminated: false,
      bay: [],
      slots: MODIFIER_SLOTS_START,
    }));
    this.state = {
      phase: "Setup",
      era: 1,
      round: 0,
      roundInEra: 0,
      players,
      currentPlayerIndex: 0,
      requiredLetter: "",
      bannedLetter: "",
      usedWords: new Set<string>(),
      history: [],
      clockRemaining: 0,
      clockTotal: 0,
      settings,
      winnerId: null,
    };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────
  get current(): PlayerState {
    return this.state.players[this.state.currentPlayerIndex];
  }

  private get activePlayers(): PlayerState[] {
    return this.state.players.filter((p) => !p.eliminated);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  start(): void {
    this.setPhase("Countdown");
    this.countdownRemaining = this.state.settings.preRoundCountdownSeconds;
    this.events.emit("countdownTick", Math.ceil(this.countdownRemaining));
  }

  /** Advance time. Called by the driver each frame with elapsed seconds. */
  tick(dt: number): void {
    if (dt <= 0) return;
    const s = this.state;
    if (s.phase === "Countdown") {
      const prev = Math.ceil(this.countdownRemaining);
      this.countdownRemaining -= dt;
      const now = Math.ceil(Math.max(0, this.countdownRemaining));
      if (now !== prev) this.events.emit("countdownTick", now);
      if (this.countdownRemaining <= 0) this.beginEra(s.era === 1);
    } else if (s.phase === "Round") {
      s.clockRemaining = Math.max(0, s.clockRemaining - dt);
      this.events.emit("clockTick", s.clockRemaining);
      if (s.clockRemaining <= 0) this.timeoutCurrent();
    }
  }

  private setPhase(phase: GamePhase): void {
    this.state.phase = phase;
    this.events.emit("phaseChanged", phase);
  }

  private beginEra(first: boolean): void {
    this.setPhase("Round");
    this.state.roundInEra = 0;
    if (first) {
      this.state.currentPlayerIndex = 0;
      this.state.requiredLetter = "";
      this.armNextTurn(false);
    } else {
      this.armNextTurn(true);
    }
  }

  private advanceIndex(): void {
    const n = this.state.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.state.currentPlayerIndex + i) % n;
      if (!this.state.players[idx].eliminated) {
        this.state.currentPlayerIndex = idx;
        return;
      }
    }
  }

  private armNextTurn(advance: boolean): void {
    if (advance) this.advanceIndex();
    this.state.roundInEra++;
    this.state.round++;
    const p = this.current;
    this.state.clockTotal = armedClockSeconds(
      this.state.settings.shotClockSeconds,
      p.bay,
    );
    this.state.clockRemaining = this.state.clockTotal;
    this.events.emit("turnArmed", {
      playerIndex: this.state.currentPlayerIndex,
      requiredLetter: this.state.requiredLetter,
      clockTotal: this.state.clockTotal,
    });
  }

  private endTurn(): void {
    // Survival: stop the match when one player remains.
    if (this.state.settings.survivalMode && this.activePlayers.length <= 1) {
      this.gameOver();
      return;
    }
    if (this.state.roundInEra >= this.state.settings.eraInterval) {
      if (this.state.era >= this.state.settings.eraCount) this.gameOver();
      else this.enterIntermission();
    } else {
      this.armNextTurn(true);
    }
  }

  // ── Turn resolution ──────────────────────────────────────────────────────────
  /** Whether the era banned letter is currently waived for `player` (last place). */
  private isExempt(player: PlayerState): boolean {
    const min = Math.min(...this.activePlayers.map((p) => p.score));
    return player.score === min;
  }

  submitWord(playerId: string, rawWord: string): SubmitResult {
    const s = this.state;
    if (s.phase !== "Round" || playerId !== this.current.id) {
      return { accepted: false };
    }
    const word = rawWord.trim().toLowerCase();
    const reject = (reason: NonNullable<SubmitResult["reason"]>): SubmitResult => {
      this.events.emit("rejected", { playerId, reason });
      return { accepted: false, reason };
    };

    if (word.length < 2 || !/^[a-z]+$/.test(word) || !this.isWord(word)) {
      return reject("not-a-word");
    }
    if (s.usedWords.has(word)) return reject("already-used");
    if (s.requiredLetter && word[0] !== s.requiredLetter) {
      return reject("wrong-start-letter");
    }

    const player = this.current;
    const taxed =
      s.bannedLetter.length > 0 &&
      word.includes(s.bannedLetter) &&
      !this.isExempt(player);

    const breakdown = scoreWord(word, player.bay, {
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      taxed,
    });

    // Tax Collector siphon: each opponent holding one takes half the would-be score.
    const bounties: { playerId: string; amount: number }[] = [];
    if (taxed) {
      const half = Math.floor(breakdown.finalBeforeTax / 2);
      if (half > 0) {
        for (const opp of s.players) {
          if (opp.id === player.id) continue;
          if (opp.bay.some((b) => getCard(b.id)?.reactive === "tax-collector")) {
            opp.score += half;
            bounties.push({ playerId: opp.id, amount: half });
          }
        }
      }
    }

    player.score += breakdown.finalScore;
    s.usedWords.add(word);
    this.prevWordLength = word.length;

    const submission: Submission = {
      playerId: player.id,
      displayName: player.name,
      accentIndex: player.accentIndex,
      word,
      score: breakdown.finalScore,
      taxed,
      taxBounty: bounties.reduce((a, b) => a + b.amount, 0),
      breakdown,
    };
    s.history.push(submission);

    // Chain succession: next word starts with this word's last letter, unless
    // that last letter is the banned letter (then the next player is free).
    const last = word[word.length - 1];
    s.requiredLetter = s.bannedLetter && last === s.bannedLetter ? "" : last;

    this.events.emit("submission", { submission, bounties });
    this.endTurn();
    return { accepted: true, submission };
  }

  private timeoutCurrent(): void {
    const p = this.current;
    if (this.state.settings.survivalMode) p.eliminated = true;
    // Required letter is unchanged: the next player still faces it.
    this.events.emit("timeout", { playerId: p.id });
    this.endTurn();
  }

  // ── Intermission ─────────────────────────────────────────────────────────────
  private enterIntermission(): void {
    this.setPhase("Intermission");
    const dealt: Record<string, string[]> = {};
    for (const p of this.state.players) {
      const newIds = this.dealCards(p, this.state.settings.modifiersDealtPerEra);
      dealt[p.id] = newIds;
      p.slots += 1; // Expansion
    }
    const lastPlaceId = this.computeLastPlaceId();
    this.events.emit("intermission", { lastPlaceId, dealt });
  }

  private dealCards(player: PlayerState, count: number): string[] {
    const owned = new Set(player.bay.map((b) => b.id));
    const pool = DEALABLE_CARD_IDS.filter((id) => !owned.has(id));
    const dealt: string[] = [];
    for (let i = 0; i < count && pool.length > 0; i++) {
      const idx = Math.floor(this.rng() * pool.length);
      const [id] = pool.splice(idx, 1);
      dealt.push(id);
      player.bay.push({ id, isNew: true });
    }
    return dealt;
  }

  /** The current last-place active player (lowest score; first by turn order on ties). */
  computeLastPlaceId(): string {
    const active = this.activePlayers;
    let last = active[0];
    for (const p of active) if (p.score < last.score) last = p;
    return last.id;
  }

  /** Replace a player's bay with an explicit ordering (used by reorder/discard UI). */
  setPlayerBay(playerId: string, orderedIds: string[]): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    const owned = new Map(p.bay.map((b) => [b.id, b] as const));
    p.bay = orderedIds
      .filter((id) => owned.has(id))
      .slice(0, p.slots)
      .map((id) => owned.get(id)!);
  }

  /** Bots/non-submitters: trim oldest (left) cards to fit the expanded capacity. */
  autoTrimBay(playerId: string): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    if (p.bay.length > p.slots) p.bay = p.bay.slice(p.bay.length - p.slots);
  }

  /** Apply the sniper ban then roll into the next era's countdown. */
  applySniperBanAndAdvance(letter: string): void {
    const legal = new Set(legalBanLetters(this.state.settings.banMode));
    const choice = legal.has(letter.toLowerCase())
      ? letter.toLowerCase()
      : this.randomBanLetter();
    this.state.bannedLetter = choice;
    for (const p of this.state.players) p.bay.forEach((b) => (b.isNew = false));
    this.state.era += 1;
    this.setPhase("Countdown");
    this.countdownRemaining = this.state.settings.preRoundCountdownSeconds;
    this.events.emit("countdownTick", Math.ceil(this.countdownRemaining));
  }

  randomBanLetter(): string {
    const legal = legalBanLetters(this.state.settings.banMode);
    return legal[Math.floor(this.rng() * legal.length)];
  }

  // ── End ────────────────────────────────────────────────────────────────────
  private gameOver(): void {
    const standings = [...this.state.players].sort((a, b) => b.score - a.score);
    this.state.winnerId = standings[0]?.id ?? null;
    this.setPhase("GameOver");
    this.events.emit("gameOver", { winnerId: this.state.winnerId, standings });
  }

  /** Utility for the UI: is `letter` a vowel (for picker grouping). */
  static isVowel = isVowel;

  /** Standings sorted high→low (for live leaderboard). */
  standings(): PlayerState[] {
    return [...this.state.players].sort((a, b) => b.score - a.score);
  }

  /** Bay cards as resolved ModifierCard objects (UI convenience). */
  bayCards(playerId: string): BayCard[] {
    return this.state.players.find((p) => p.id === playerId)?.bay ?? [];
  }
}
