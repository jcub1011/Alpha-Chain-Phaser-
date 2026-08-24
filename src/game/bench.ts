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
import { dictionaryWordPool } from "./picker/wordPool";
import { MatchController, type PlayerSeed } from "./match";
import { orderPreservingRng } from "./rng";
import { DEFAULT_SETTINGS, legalBanLetters } from "./settings";
import { GameMode } from "./types";
import type { PlayerState, Submission, SubmitResult } from "./types";

/** Eras / rounds-per-era large enough that a bench session never advances out of
 *  the first era (no intermission, no game-over). */
const BENCH_ERAS = 999;

/** mulberry32 on a fixed seed: varied, but the same every session. */
function benchOfferRng(): () => number {
  let a = 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BenchScenario {
  private readonly isWord: (w: string) => boolean;
  /** The live throwaway match. Rebuilt by reset(); always defined after ctor. */
  controller!: MatchController;
  /** Which mode the bench is exercising. Rebuilds the match on change. */
  private mode: GameMode = GameMode.Classic;
  private playerCount = 2;

  constructor(private readonly dict: Dictionary) {
    this.isWord = (w) => this.dict.has(w);
    this.reset(2);
  }

  /** Build a fresh match with `playerCount` (2–8) empty bays, parked in Round. */
  reset(playerCount: number): void {
    const n = Math.max(2, Math.min(8, Math.floor(playerCount) || 2));
    this.playerCount = n;
    const seeds: PlayerSeed[] = Array.from({ length: n }, (_, i) => ({
      id: `P${i}`,
      name: `Player ${i + 1}`,
      isBot: false,
    }));
    const settings = {
      ...DEFAULT_SETTINGS,
      // Pin the mode explicitly. DEFAULT_SETTINGS now selects Picker, so spreading it and
      // injecting no word pool used to make every bench session log "picker mode requested but
      // no wordPool was injected" and silently fall back to Classic.
      gameMode: this.mode,
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
      // The same lexicon the bench validates against, so an Offer here behaves as it does in a
      // real match. orderPreservingRng makes the draw reproducible between sessions.
      wordPool: dictionaryWordPool(this.dict),
      // A well-distributed stream for the Offer specifically. orderPreservingRng above is a
      // constant, which pins turn order (P0 opens) but would make every Offer a run of
      // alphabetically-extreme words — useless for inspecting what the generator really produces.
      // Seeded, so a bench session is still reproducible.
      offerRng: benchOfferRng(),
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
  get gameMode(): GameMode {
    return this.mode;
  }
  /** Picker: this turn's Offer (empty in Classic). */
  get offer(): readonly string[] {
    return this.state.offer;
  }
  /** Word Builder: this turn's Tile Rack (empty in Classic). */
  get rack() {
    return this.state.rack;
  }
  get canRedraw(): boolean {
    return this.state.offerRedrawAvailable || this.state.rackRedrawAvailable;
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
    // Allow negative scores so the bench can exercise the negative-scoring feature;
    // `|| 0` only guards against a NaN input.
    if (p) p.score = Math.floor(score) || 0;
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

  // ── Picker ───────────────────────────────────────────────────────────────────
  /** Switch mode. Rebuilds the match, because the Offer is drawn when a turn arms and the
   *  clock/dealer both read the mode. */
  setMode(mode: GameMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset(this.playerCount);
  }

  /** Picker: commit an offered word for the player whose turn it is. Mirrors `submit`, including
   *  staging the clock first so clock-reading cards see the value the tester dialled in. */
  commitOffer(word: string, remainingSeconds: number): SubmitResult {
    this.state.clockRemaining = Math.max(0, remainingSeconds);
    return this.controller.commitSelection(this.currentPlayerId, word);
  }

  /** Picker: spend Winnower's redraw for the current player, if they hold one. */
  redraw(): boolean {
    return this.controller.redrawOffer(this.currentPlayerId);
  }

  /** Re-arm the current turn so a bay edit is reflected in a freshly drawn Offer. Editing the bay
   *  alone cannot do it: the Offer is generated when the turn arms, so a Preference Card added
   *  from the palette would otherwise not visibly shape anything until the next turn. */
  redrawForBayChange(): void {
    this.controller.benchRearmTurn();
  }
}
