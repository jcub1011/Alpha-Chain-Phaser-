/*
 * BenchScenario — the headless driver behind the "Testing Bay" (ports the Blazor
 * AlphaChainBenchScenario). It runs a real, throwaway MatchController so that
 * every card behaviour can be exercised end-to-end — succession, the Zero-Point
 * Tax, Tax-Collector steals, Magnifying-Glass off-turn effects, time-reactive
 * cards — rather than scoring a single bay in isolation. The match is configured
 * to never intermission or end (tutorials off, eras stretched) and is parked in
 * the Round phase with empty bays the caller fills explicitly.
 *
 * Pure game logic: no Phaser / Lit imports. The Lit view (<ac-sandbox>) renders
 * from the accessors here and calls the editors after each interaction.
 */

import type { Dictionary } from "./dictionary";
import { MatchController, type PlayerSeed } from "./match";
import { orderPreservingRng } from "./rng";
import { DEFAULT_SETTINGS, legalBanLetters } from "./settings";
import type { PlayerState, Submission, SubmitResult } from "./types";

/** Eras / rounds-per-era large enough that a bench session never advances out of
 *  the first era (no intermission, no game-over). */
const BENCH_ERAS = 999;

export class BenchScenario {
  private readonly isWord: (w: string) => boolean;
  /** The live throwaway match. Rebuilt by reset(); always defined after ctor. */
  controller!: MatchController;

  constructor(private readonly dict: Dictionary) {
    this.isWord = (w) => this.dict.has(w);
    this.reset(2);
  }

  /** Build a fresh match with `playerCount` (2–8) empty bays, parked in Round. */
  reset(playerCount: number): void {
    const n = Math.max(2, Math.min(8, Math.floor(playerCount) || 2));
    const seeds: PlayerSeed[] = Array.from({ length: n }, (_, i) => ({
      id: `P${i}`,
      name: `Player ${i + 1}`,
      isBot: false,
    }));
    const settings = {
      ...DEFAULT_SETTINGS,
      enableTutorials: false,
      survivalMode: false,
      preRoundCountdownSeconds: 1,
      eraInterval: BENCH_ERAS,
      eraCount: BENCH_ERAS,
    };
    // The bench keeps seed order (P0 opens) so scenarios are reproducible — it
    // routes through the same per-era shuffle as a real match but with a no-op RNG.
    this.controller = new MatchController(seeds, settings, {
      isWord: this.isWord,
      rng: orderPreservingRng,
    });
    this.controller.start();
    this.controller.tick(settings.preRoundCountdownSeconds + 1); // burn countdown → Round
    // No opening deal on the bench: cards are added explicitly from the palette.
    for (const p of this.controller.state.players) p.bay = [];
  }

  // ── Accessors the view renders from ──────────────────────────────────────────
  get state() {
    return this.controller.state;
  }
  get phase() {
    return this.state.phase;
  }
  get players(): PlayerState[] {
    return this.state.players;
  }
  get currentPlayerId(): string {
    return this.controller.current?.id ?? "";
  }
  get currentPlayerIndex(): number {
    return this.state.currentPlayerIndex;
  }
  get bannedLetter(): string {
    return this.state.bannedLetter;
  }
  get requiredLetter(): string {
    return this.state.requiredLetter;
  }
  get history(): Submission[] {
    return this.state.history;
  }
  /** The most recent accepted submission (its breakdown / bounty / effects). */
  get latest(): Submission | undefined {
    return this.state.history[this.state.history.length - 1];
  }

  bayOf(playerId: string): string[] {
    return this.players.find((p) => p.id === playerId)?.bay.map((b) => b.id) ?? [];
  }

  // ── Editors ──────────────────────────────────────────────────────────────────
  setBannedLetter(letter: string | null): void {
    const c = (letter ?? "").trim().toLowerCase().slice(0, 1);
    const legal = new Set(legalBanLetters(this.state.settings.banMode));
    this.state.bannedLetter = c && legal.has(c) ? c : "";
  }

  setScore(playerId: string, score: number): void {
    const p = this.players.find((x) => x.id === playerId);
    if (p) p.score = Math.max(0, Math.floor(score) || 0);
  }

  setBay(playerId: string, ids: string[]): void {
    this.controller.benchSetBay(playerId, ids);
  }

  addCard(playerId: string, cardId: string): void {
    this.setBay(playerId, [...this.bayOf(playerId), cardId]);
  }

  removeAt(playerId: string, index: number): void {
    this.setBay(
      playerId,
      this.bayOf(playerId).filter((_, i) => i !== index),
    );
  }

  moveCard(playerId: string, index: number, delta: number): void {
    const ids = this.bayOf(playerId);
    const target = index + delta;
    if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    this.setBay(playerId, ids);
  }

  /** Submit `word` for the current player, staging the shot clock at
   *  `remainingSeconds` (so time-reactive cards like Chrono Syphon resolve as
   *  they would at that point on the clock). Returns the raw SubmitResult so the
   *  view can surface a rejection reason. */
  submit(word: string, remainingSeconds: number): SubmitResult {
    const id = this.currentPlayerId;
    if (!id) return { accepted: false };
    this.state.clockRemaining = Math.max(0, remainingSeconds);
    return this.controller.submitWord(id, word);
  }

  skip(): void {
    this.controller.benchSkipTurn();
  }
}
