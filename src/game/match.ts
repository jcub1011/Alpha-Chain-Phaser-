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
import { DEFAULT_MAX_INSTANCES } from "./cards/card";
import { BanLetterService, EngineEffects, RoomServices } from "./cards/roomServices";
import { createLogger } from "../log";
import { Emitter } from "./emitter";
import { shuffle } from "./rng";
import {
  armedClockSeconds,
  bayOwnTaxPolicy,
  bayViolatesLegality,
  bayWriteOffBonus,
  baySuccessionExempt,
  fireBayHook,
  makeBayEvaluator,
  scoreTimeout,
  scoreWord,
  type BayEvaluator,
} from "./scoring";
import {
  availableBanLetters,
  legalBanLetters,
  MIN_SHOT_CLOCK_SECONDS,
  modifierSlotsForCardEra,
  isVowel,
} from "./settings";
import { byScoreDesc } from "./types";
import type {
  AlphaChainSettings,
  BayCard,
  GamePhase,
  IntermissionPhase,
  MatchState,
  PlayerState,
  Submission,
  SubmitResult,
  TutorialKind,
  WordResolution,
} from "./types";

const log = createLogger("match");

/** Tutorial dwell durations in seconds (port of TutorialState.DurationFor). Each page
 *  leads with a demonstration animation; the dwell is the fallback if nobody readies. */
const TUTORIAL_DWELL: Record<TutorialKind, number> = {
  shiritori: 14,
  timeout: 12,
  engine: 14,
  cards: 13,
  tax: 13,
  sniper: 12,
};

/** Tutorial pages shown in sequence at each cue point (in order). Pre-game pages run
 *  during the top-level Tutorial phase; the optimize/ban groups run as intermission
 *  sub-phases before the era-1 optimize and sniper ban respectively. */
const PREGAME_TUTORIALS: readonly TutorialKind[] = ["shiritori", "timeout"];
const OPTIMIZE_TUTORIALS: readonly TutorialKind[] = ["engine", "cards"];
const BAN_TUTORIALS: readonly TutorialKind[] = ["tax", "sniper"];

/** Extra dwell (seconds) added to the engine animation when an era ends on a
 *  submission, so every player sees the final word's score replay finish before
 *  the phase changes. Covers the taxed finale (~0.92s) on top of the walk. */
const ROUND_SETTLE_BUFFER = 1.0;

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
  /** Host-side timeout grace (s); 0 = immediate (solo/tests). */
  submitGraceSeconds?: number;
  /** Wall-clock (epoch ms) for startedAt/endedAt stamps. Injectable so the server
   *  authority can pass kb.now() — the sandbox has no ambient `Date`. Defaults to
   *  Date.now for the browser (solo/host paths). */
  now?: () => number;
}

export interface MatchEvents {
  phaseChanged: GamePhase;
  /** Tutorial phase / intermission sub-phase changed (drives a host snapshot). */
  subPhaseChanged: { intermissionPhase: IntermissionPhase; currentTutorial: TutorialKind | null };
  countdownTick: number; // seconds remaining
  /** Tutorial / intermission sub-phase dwell remaining (per-frame; never broadcast). */
  subTimerTick: number;
  turnArmed: { playerIndex: number; requiredLetter: string; clockTotal: number };
  clockTick: number; // shot-clock seconds remaining
  submission: { submission: Submission; bounties: { playerId: string; amount: number }[] };
  rejected: { playerId: string; reason: NonNullable<SubmitResult["reason"]> };
  timeout: { playerId: string; penalty: number };
  intermission: { lastPlaceId: string; dealt: Record<string, string[]> };
  gameOver: { winnerId: string | null; standings: PlayerState[] };
}

export class MatchController {
  readonly events = new Emitter<MatchEvents>();
  private readonly rng: () => number;
  private readonly isWord: (w: string) => boolean;
  /** Wall-clock (epoch ms) for match timestamps; injectable (kb.now() server-side). */
  private readonly now: () => number;

  private countdownRemaining = 0;
  /** Era-end settle: while > 0 the phase is held in Round (clock frozen) so the
   *  last submission's score replay can finish before the era transition fires. */
  private roundSettleRemaining = 0;
  private pendingEraEnd: "intermission" | "gameOver" | null = null;
  private prevWordLength = 0;
  /** The current player's in-progress word, streamed in via setDraft, so a shot-clock
   *  timeout can auto-submit it. Transient (not part of MatchState; never serialized);
   *  reset on every turn arm. */
  private currentDraft = "";
  /** Host-side leeway (s) the turn lingers at clockRemaining 0 before timing out,
   *  so a buzzer-time submit still in flight over the network can land. 0 ⇒ the
   *  turn times out the instant the clock hits 0 (solo/tests). */
  private readonly submitGraceSeconds: number;
  /** Live countdown of the grace window once the clock has hit 0; re-seeded to
   *  submitGraceSeconds whenever the clock is (re-)armed or refilled. */
  private clockGraceRemaining = 0;
  readonly state: MatchState;

  /** Card-contributed, player-keyed room state (shield, guards, bans, penalties). */
  readonly services: RoomServices;
  /** Routes automated attacks (time shave / drain / hijack) through interceptors. */
  readonly effects: EngineEffects;
  /** Live clock controller a card hook can refill (The Prism on a typo). */
  private readonly clockController = {
    refillToFull: (): void => {
      this.state.clockRemaining = this.state.clockTotal;
      this.clockGraceRemaining = this.submitGraceSeconds; // refill restores a fresh grace window
      this.events.emit("clockTick", this.state.clockRemaining);
    },
  };

  constructor(seeds: PlayerSeed[], settings: AlphaChainSettings, deps: MatchDeps) {
    this.isWord = deps.isWord;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.submitGraceSeconds = deps.submitGraceSeconds ?? 0;
    const players: PlayerState[] = seeds.map((s, i) => ({
      id: s.id,
      name: s.name,
      isBot: s.isBot,
      accentIndex: i,
      score: 0,
      eliminated: false,
      bay: [],
      slots: modifierSlotsForCardEra(settings, 1),
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
      bannedLetterHistory: [],
      usedWords: new Set<string>(),
      history: [],
      clockRemaining: 0,
      clockTotal: 0,
      intermissionPhase: null,
      currentTutorial: null,
      subTimerRemaining: 0,
      subTimerTotal: 0,
      shownTutorials: [],
      tutorialReady: [],
      settings,
      winnerId: null,
    };
    this.services = new RoomServices(
      new BanLetterService(
        this.rng,
        () => this.state.settings.banMode,
        () => this.state.bannedLetter,
      ),
    );
    this.effects = new EngineEffects(this.services, {
      activePlayers: () => this.turnOrderedActive(),
      armedClockOf: (p) => armedClockSeconds(this.state.settings.shotClockSeconds, p.bay),
    });
    this.installLogging();
  }

  /**
   * Mirror the FSM's discrete events to the app log from one place, so the state
   * machine body stays uncluttered. Per-frame ticks (countdown/clock/subTimer)
   * are deliberately excluded to avoid flooding the log.
   */
  private installLogging(): void {
    const playerName = (id: string): string =>
      this.state.players.find((p) => p.id === id)?.name ?? id;

    this.events.on("phaseChanged", (phase) => log.info(`phase → ${phase} (era ${this.state.era})`));
    this.events.on("subPhaseChanged", ({ intermissionPhase, currentTutorial }) =>
      log.debug(
        `sub-phase → intermission=${intermissionPhase ?? "-"}, tutorial=${currentTutorial ?? "-"}`,
      ),
    );
    // Player names and submitted words are PII. They go to the local console as
    // detail args (which the logger never ships to the server); the lines that
    // reach the server log carry only opaque player ids. See log.ts.
    this.events.on("turnArmed", ({ playerIndex, requiredLetter, clockTotal }) => {
      const id = this.state.players[playerIndex]?.id ?? "?";
      log.info(
        `turn armed: ${id} letter="${requiredLetter || "*"}" clock=${clockTotal}s`,
        playerName(id),
      );
    });
    this.events.on("submission", ({ submission }) =>
      log.info(
        `submission: ${submission.playerId} → ${submission.score} pts`,
        playerName(submission.playerId),
        submission.word,
      ),
    );
    this.events.on("rejected", ({ playerId, reason }) =>
      log.warn(`rejected: ${playerId} (${reason})`, playerName(playerId)),
    );
    this.events.on("timeout", ({ playerId }) =>
      log.warn(`timeout: ${playerId}`, playerName(playerId)),
    );
    this.events.on("intermission", ({ lastPlaceId, dealt }) =>
      log.info(
        `intermission: last=${lastPlaceId} dealt ${Object.keys(dealt).length} bays`,
        playerName(lastPlaceId),
      ),
    );
    this.events.on("gameOver", ({ winnerId }) =>
      winnerId
        ? log.info(`game over: winner=${winnerId}`, playerName(winnerId))
        : log.info(`game over: winner=none`),
    );
  }

  /** Active players in turn order (index-aligned with how turns advance). */
  private turnOrderedActive(): PlayerState[] {
    return this.state.players.filter((p) => !p.eliminated);
  }

  /** Build the shared bay evaluator + hook context for `player` scoring `word`. */
  private bayEval(player: PlayerState, word: string, taxed: boolean): BayEvaluator {
    return makeBayEvaluator(word, player.bay, {
      prevWordLength: this.prevWordLength,
      clockRemaining: this.state.clockRemaining,
      clockTotal: this.state.clockTotal,
      taxed,
      baseClockSeconds: this.state.settings.shotClockSeconds,
      era: this.state.era,
      slots: player.slots,
      history: this.state.history,
      services: this.services,
      effects: this.effects,
      player,
      players: this.state.players,
      clock: this.clockController,
    });
  }

  /** Whether `playerId` should currently have their input hidden (Blindfold). */
  hidesInput(playerId: string): boolean {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return false;
    return p.bay.some((b) => getCard(b.id)?.hidesInput?.() ?? false);
  }

  // ── Accessors ──────────────────────────────────────────────────────────────
  get current(): PlayerState {
    return this.state.players[this.state.currentPlayerIndex];
  }

  /** Length of the previous accepted word (Booster/Blueprint scoring context).
   *  Read-only view for card-aware bots that score candidates through a bay. */
  get lastWordLength(): number {
    return this.prevWordLength;
  }

  /** Seconds left on the pre-round Countdown (private state), so the net layer
   *  can stamp its absolute expiry into snapshots. Only meaningful in Countdown. */
  get countdownSecondsRemaining(): number {
    return this.countdownRemaining;
  }

  private get activePlayers(): PlayerState[] {
    return this.state.players.filter((p) => !p.eliminated);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  start(): void {
    this.state.startedAt ??= this.now();
    // The pre-game tutorials (chain → timeout), if enabled, play before the first round.
    const first = this.nextTutorialIn(PREGAME_TUTORIALS);
    if (first) this.enterTutorialPhase(first);
    else this.beginFirstRoundOrSetup();
  }

  /** After the pre-game tutorial(s): when "deal engine cards on era 1" is on, run a
   *  setup intermission (deal an opening hand + optimize) before the first countdown;
   *  otherwise go straight to era 1 with empty bays. */
  private beginFirstRoundOrSetup(): void {
    if (this.state.settings.dealEngineCardsFirstEra) this.enterSetupIntermission();
    else this.beginCountdown();
  }

  /** Pre-era-1 setup: deal an opening hand and run the engine tutorial + optimize,
   *  WITHOUT the slot expansion or sniper ban a between-era intermission performs
   *  (completeOptimize routes back to the countdown while round === 0). */
  private enterSetupIntermission(): void {
    this.setPhase("Intermission");
    const dealt: Record<string, string[]> = {};
    for (const p of this.state.players) {
      dealt[p.id] = this.dealCards(p, this.state.settings.modifiersDealtPerEra);
    }
    this.events.emit("intermission", { lastPlaceId: this.computeLastPlaceId(), dealt });
    this.beginIntermissionStage();
  }

  private beginCountdown(): void {
    this.setPhase("Countdown");
    this.countdownRemaining = this.state.settings.preRoundCountdownSeconds;
    this.events.emit("countdownTick", Math.ceil(this.countdownRemaining));
  }

  /** Advance time. Called by the driver each frame with elapsed seconds. */
  tick(dt: number): void {
    if (dt <= 0) return;
    const s = this.state;
    if (s.phase === "Tutorial") {
      s.subTimerRemaining = Math.max(0, s.subTimerRemaining - dt);
      this.events.emit("subTimerTick", s.subTimerRemaining);
      if (s.subTimerRemaining <= 0) this.advanceTutorialPhase();
    } else if (s.phase === "Countdown") {
      const prev = Math.ceil(this.countdownRemaining);
      this.countdownRemaining -= dt;
      const now = Math.ceil(Math.max(0, this.countdownRemaining));
      if (now !== prev) this.events.emit("countdownTick", now);
      if (this.countdownRemaining <= 0) this.beginEra();
    } else if (s.phase === "Round") {
      // Era-end settle: hold in Round with the clock frozen until the replay dwell
      // elapses, then fire the deferred transition.
      if (this.roundSettleRemaining > 0) {
        this.roundSettleRemaining = Math.max(0, this.roundSettleRemaining - dt);
        if (this.roundSettleRemaining <= 0) this.resolveEraEnd();
        return;
      }
      const before = s.clockRemaining;
      s.clockRemaining = Math.max(0, before - dt);
      this.events.emit("clockTick", s.clockRemaining);
      if (s.clockRemaining <= 0) {
        if (this.clockGraceRemaining > 0) {
          // Hold the turn open for one grace window so a buzzer-time submit that is
          // still in flight over the network can land. grace=0 (solo/tests) skips this.
          // Only the slice of this tick that fell AFTER the clock hit zero eats grace;
          // a coarse catch-up tick must not burn the whole window before zero.
          const overshoot = Math.max(0, dt - before);
          this.clockGraceRemaining = Math.max(0, this.clockGraceRemaining - overshoot);
          if (this.clockGraceRemaining <= 0) this.timeoutCurrent();
        } else {
          this.timeoutCurrent();
        }
      }
    } else if (s.phase === "Intermission") {
      this.tickIntermission(dt);
    }
  }

  private setPhase(phase: GamePhase): void {
    this.state.phase = phase;
    this.events.emit("phaseChanged", phase);
  }

  // ── Tutorials (host-authoritative dwell; guests interpolate for display) ──────
  /** Whether `kind` is enabled and hasn't been shown yet this match. */
  private shouldShowTutorial(kind: TutorialKind): boolean {
    return this.state.settings.enableTutorials && !this.state.shownTutorials.includes(kind);
  }

  /** The first not-yet-shown tutorial in a cue-point group, or null if all are done. */
  private nextTutorialIn(group: readonly TutorialKind[]): TutorialKind | null {
    return group.find((k) => this.shouldShowTutorial(k)) ?? null;
  }

  private armSubTimer(seconds: number): void {
    this.state.subTimerTotal = seconds;
    this.state.subTimerRemaining = seconds;
  }

  /** Enter the top-level Shiritori tutorial phase (before the first countdown). */
  private enterTutorialPhase(kind: TutorialKind): void {
    this.state.currentTutorial = kind;
    this.state.tutorialReady = []; // fresh "I've read this" slate per page
    this.markTutorialShown(kind);
    this.armSubTimer(TUTORIAL_DWELL[kind]);
    this.setPhase("Tutorial");
  }

  private advanceTutorialPhase(): void {
    const next = this.nextTutorialIn(PREGAME_TUTORIALS);
    if (next) {
      this.enterTutorialPhase(next);
      return;
    }
    this.state.currentTutorial = null;
    this.beginFirstRoundOrSetup();
  }

  /** Skip the current tutorial (Shiritori phase or an intermission tutorial). */
  skipTutorial(): void {
    if (this.state.phase === "Tutorial") this.advanceTutorialPhase();
    else if (this.state.phase === "Intermission" && this.state.intermissionPhase === "tutorial")
      this.advanceIntermissionTutorial();
  }

  /** A player presses "I've Read This" on the current tutorial page. The page
   *  auto-advances once every active human is ready (host SKIP and the dwell timer
   *  remain overrides/fallbacks). Mirrors lockInOptimize; any player may call it. */
  markTutorialReady(playerId: string): void {
    if (!this.state.currentTutorial) return;
    const p = this.activePlayers.find((x) => x.id === playerId);
    if (!p || p.isBot) return;
    if (!this.state.tutorialReady.includes(playerId)) {
      this.state.tutorialReady = [...this.state.tutorialReady, playerId];
    }
    if (this.allHumansTutorialReady()) this.skipTutorial();
  }

  /** Whether every active human has pressed "I've Read This" on the current page. */
  private allHumansTutorialReady(): boolean {
    const humans = this.activePlayers.filter((p) => !p.isBot);
    return humans.length > 0 && humans.every((p) => this.state.tutorialReady.includes(p.id));
  }

  /** Fast-forward the optimize sub-phase (solo convenience; host shared display). */
  skipOptimize(): void {
    if (this.state.phase === "Intermission" && this.state.intermissionPhase === "optimize")
      this.completeOptimize();
  }

  private beginEra(): void {
    this.setPhase("Round");
    // A "round" is one full cycle of all players (GDD §4); the era runs for
    // `eraInterval` such rounds. roundInEra is 1-based and starts at the first
    // round of the era.
    this.state.roundInEra = 1;
    this.state.round++;
    // Every era opens on a wildcard (free) starting letter — never the carry-over
    // from the previous era's last word. Otherwise the sniper-ban picker could line
    // the opener up to be forced straight into the just-set ban's Zero-Point Tax.
    this.state.requiredLetter = "";
    // Reshuffle the turn order every era (including era 1) so a random player opens
    // — the opener gets the free starting letter, so a fixed order would hand the
    // same seat a recurring advantage. The opener is the first non-eliminated player
    // in the freshly shuffled order.
    // Cross-peer consistency comes from HOST AUTHORITY, not seed replication: only the
    // host runs beginEra and the shuffled order ships wholesale in the snapshot. `rng`
    // defaults to Math.random, so no RNG-derived logic may ever run on a guest mirror.
    this.state.players = shuffle(this.state.players, this.rng);
    const opener = this.state.players.findIndex((p) => !p.eliminated);
    this.state.currentPlayerIndex = opener < 0 ? 0 : opener;
    this.armCurrentTurn();
  }

  /** Advance to the next active player; returns true if the turn order wrapped
   *  (i.e. every player has now had a turn this round). */
  private advanceIndex(): boolean {
    const n = this.state.players.length;
    let wrapped = false;
    for (let i = 0; i < n; i++) {
      const next = (this.state.currentPlayerIndex + 1) % n;
      if (next <= this.state.currentPlayerIndex) wrapped = true;
      this.state.currentPlayerIndex = next;
      if (!this.state.players[next].eliminated) break;
    }
    return wrapped;
  }

  /** Arm the shot clock for the current player and announce the turn. Does not
   *  advance the turn order or touch the round counters. */
  private armCurrentTurn(): void {
    const p = this.current;
    this.currentDraft = ""; // each turn starts with a blank draft (no stale carry-over)
    // Per-turn room state re-arms (currently a no-op seam; A5 uses it).
    this.services.fireTurnStarted(p);
    let armed = armedClockSeconds(this.state.settings.shotClockSeconds, p.bay);
    // A time-penalty card (Blind Sniper) queued a shave onto this player's next clock.
    const penalty = this.services.timePenalty.consumeFor(p.id);
    if (penalty > 0) armed = Math.max(MIN_SHOT_CLOCK_SECONDS, armed - penalty);
    this.state.clockTotal = armed;
    this.state.clockRemaining = this.state.clockTotal;
    this.clockGraceRemaining = this.submitGraceSeconds; // fresh grace window for the armed turn
    this.events.emit("turnArmed", {
      playerIndex: this.state.currentPlayerIndex,
      requiredLetter: this.state.requiredLetter,
      clockTotal: this.state.clockTotal,
    });
  }

  private endTurn(fromSubmission = false): void {
    // Survival: stop the match when one player remains.
    if (this.state.settings.survivalMode && this.activePlayers.length <= 1) {
      this.gameOver();
      return;
    }
    const wrapped = this.advanceIndex();
    if (wrapped) {
      this.state.round++;
      // The era ends once `eraInterval` full rounds have been completed.
      if (this.state.roundInEra >= this.state.settings.eraInterval) {
        const eraEndsMatch = this.state.era >= this.state.settings.eraCount;
        // A submission-driven era end waits for the score replay to finish so
        // every player sees the final word resolve. A timeout has no replay to
        // watch, so it transitions immediately.
        if (fromSubmission) {
          this.roundSettleRemaining =
            this.state.settings.engineAnimationSeconds + ROUND_SETTLE_BUFFER;
          this.pendingEraEnd = eraEndsMatch ? "gameOver" : "intermission";
          return;
        }
        if (eraEndsMatch) this.gameOver();
        else this.enterIntermission();
        return;
      }
      this.state.roundInEra++;
    }
    this.armCurrentTurn();
  }

  // ── Turn resolution ──────────────────────────────────────────────────────────
  /** Whether the era banned letter is currently waived for `player`. Only the
   *  single current last-place player (the ban's picker) is exempt — not every
   *  player tied at the lowest score. Tracks live standings (GDD §2.2). */
  isExempt(player: PlayerState): boolean {
    return this.computeLastPlaceId() === player.id;
  }

  /** Personal banned letters in force for a player this era (Toll Booth / Roulette
   *  Wheel), each tagged with the card that rolled it. */
  personalBansFor(playerId: string): { letter: string; cardName: string }[] {
    return this.services.cardBan.entriesFor(playerId).map((b) => ({
      letter: b.letter,
      cardName: getCard(b.cardId)?.name ?? "",
    }));
  }

  submitWord(playerId: string, rawWord: string): SubmitResult {
    const s = this.state;
    if (s.phase !== "Round" || this.roundSettleRemaining > 0 || playerId !== this.current.id) {
      return { accepted: false };
    }
    const word = rawWord.trim().toLowerCase();
    const player = this.current;
    const reject = (reason: NonNullable<SubmitResult["reason"]>): SubmitResult => {
      this.events.emit("rejected", { playerId, reason });
      return { accepted: false, reason };
    };

    // Degenerate input (empty / non-alpha / single letter) is never a word.
    if (word.length < 2 || !/^[a-z]+$/.test(word)) return reject("not-a-word");

    // 4. Succession — a held Wildcard exempts the owner once per era. The bypass
    //    is only recorded here; it's consumed once the word is fully accepted, so
    //    a duplicate/typo rejection below never burns the era's charge.
    let usedWildcard = false;
    if (s.requiredLetter && word[0] !== s.requiredLetter) {
      if (!baySuccessionExempt(this.bayEval(player, word, false))) {
        return reject("wrong-start-letter");
      }
      usedWildcard = true;
    }

    // 5. Uniqueness.
    if (s.usedWords.has(word)) return reject("already-used");

    // 6. Dictionary — a non-word is simply rejected; the turn (and clock) carry on.
    if (!this.isWord(word)) return reject("not-a-word");

    // 7. Zero-Point Tax — era ban (unless last-place exempt), personal hijack ban,
    //    era-rolled card bans, or a card legality rule (Slow Burn's 6-letter floor).
    const exempt = this.isExempt(player);
    const eraBan = !exempt && s.bannedLetter ? s.bannedLetter : "";
    const hijack = this.services.hijackBan.peek(player.id) ?? "";
    const cardBans = this.services.cardBan.bansFor(player.id);
    const evCheck = this.bayEval(player, word, false);
    const taxed =
      (eraBan !== "" && word.includes(eraBan)) ||
      (hijack !== "" && word.includes(hijack)) ||
      cardBans.some((b) => word.includes(b)) ||
      bayViolatesLegality(evCheck);

    // The banned letter the word used (era → hijack → card ban); null when only a
    // legality rule taxed it. Backs Bait & Switch's "that exact letter".
    let offendingLetter: string | null = null;
    if (taxed) {
      if (eraBan !== "" && word.includes(eraBan)) offendingLetter = eraBan;
      else if (hijack !== "" && word.includes(hijack)) offendingLetter = hijack;
      else offendingLetter = cardBans.find((b) => word.includes(b)) ?? null;
    }

    // 7a. The Prism — once per era, a held charge bails the owner out of a banned-letter
    //     word: reject it and refill the clock so they can retype, instead of eating the
    //     Zero-Point Tax. Legality taxes (offendingLetter null) don't qualify.
    if (offendingLetter !== null && this.tryClockRescue(player)) return reject("prism-saved");

    // 8. Score, then the two owner-side tax rules (IRS Agent flat override +
    //    bounty suppression, then Tax Write-Off's first-letter salvage on top).
    const scoreOpts = {
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      baseClockSeconds: s.settings.shotClockSeconds,
      era: s.era,
      slots: player.slots,
      history: s.history,
    };
    const breakdown = scoreWord(word, player.bay, { ...scoreOpts, taxed });
    let finalScore = breakdown.finalScore;
    let suppressBounty = false;
    if (taxed) {
      const irs = bayOwnTaxPolicy(evCheck);
      if (irs) {
        finalScore = irs.score(breakdown.finalBeforeTax);
        suppressBounty = irs.suppress;
      }
      const bonus = bayWriteOffBonus(
        evCheck,
        (w) => scoreWord(w, player.bay, { ...scoreOpts, taxed: false }).finalScore,
      );
      if (bonus > 0) finalScore += bonus;
      breakdown.finalScore = finalScore;
    }

    // 9. Consume the one-shot hijack ban (read above) + the era's Wildcard charge.
    this.services.hijackBan.consumeFor(player.id);
    if (usedWildcard) this.services.wildcardGuard.tryConsume(player.id);

    // 10–11. Record + credit, then advance the chain's required letter.
    player.score += finalScore;
    // Crescendo: a clean word extends the streak; a taxed word breaks it. Updated
    // AFTER scoring so the current word folds on the prior (pre-increment) streak.
    if (taxed) this.services.crescendoStreak.reset(player.id);
    else this.services.crescendoStreak.increment(player.id);
    s.usedWords.add(word);
    this.prevWordLength = word.length;
    const last = word[word.length - 1];
    s.requiredLetter = s.bannedLetter && last === s.bannedLetter ? "" : last;

    // 11a–c. Fire the card lifecycle hooks: owner OnWordAccepted, every other
    //        active player's OnOpponentWordResolved (reactive economy), then the
    //        owner's OnTurnEnded (automated aggression — wired in A5).
    const resolution: WordResolution = {
      submitterId: player.id,
      word,
      taxed,
      wouldBeScore: breakdown.finalBeforeTax,
      earnedScore: finalScore,
      offendingLetter,
      siphonSuppressed: suppressBounty,
      remainingSeconds: Math.floor(s.clockRemaining),
    };
    this.fireReactions(player, word, taxed, resolution);
    const bounties = this.effects.takeSiphons();
    const notices = this.effects.takeNotices();

    const submission: Submission = {
      playerId: player.id,
      displayName: player.name,
      accentIndex: player.accentIndex,
      era: s.era,
      word,
      score: finalScore,
      taxed,
      taxBounty: bounties.reduce((a, b) => a + b.amount, 0),
      breakdown,
      siphonedBy: bounties.map((b) => b.playerId),
      effects: notices.length ? notices : undefined,
    };
    s.history.push(submission);

    this.events.emit("submission", { submission, bounties });
    this.endTurn(true);
    return { accepted: true, submission };
  }

  /** Fire the accepted-word lifecycle hooks in the canonical order (RoundState.FireReactions). */
  private fireReactions(
    owner: PlayerState,
    word: string,
    taxed: boolean,
    res: WordResolution,
  ): void {
    fireBayHook(this.bayEval(owner, word, taxed), "onWordAccepted", { resolution: res });
    for (const opp of this.state.players) {
      if (opp.id === owner.id || opp.eliminated) continue;
      fireBayHook(this.bayEval(opp, word, false), "onOpponentWordResolved", { resolution: res });
    }
    fireBayHook(this.bayEval(owner, word, taxed), "onTurnEnded", { resolution: res });
  }

  /** Record the current player's in-progress word so a shot-clock timeout can
   *  auto-submit it. The authoritative twin of the solo UI's clockTick auto-submit
   *  (ac-word-entry): over the network the display mirror can't outrace the real
   *  clock, so the host engine must own the auto-submit. Ignored unless it's
   *  `playerId`'s live turn. */
  setDraft(playerId: string, word: string): void {
    if (this.state.phase !== "Round" || playerId !== this.current.id) return;
    this.currentDraft = word;
  }

  /** Offer each of a player's resolved cards its once-per-era clock rescue (Prism);
   *  returns true if one fired (consumed its charge and refilled the clock). */
  private tryClockRescue(player: PlayerState): boolean {
    const ev = this.bayEval(player, "", false);
    return ev.resolved.some((c, i) => c?.rescueClock?.(ev.ctxFor(i)) ?? false);
  }

  private timeoutCurrent(): void {
    // Auto-submit the live player's drafted word if it stands on its own; a blank or
    // illegal draft falls through to a real timeout below.
    const draft = this.currentDraft.trim();
    if (draft) {
      const res = this.submitWord(this.current.id, draft);
      // Accepted on its own, or a banned-letter draft tripped the Prism during the
      // auto-submit (clock refilled): either way the turn continues, no timeout.
      if (res.accepted || res.reason === "prism-saved") return;
    }
    // Otherwise, give a held Prism its timeout save: refill to full instead of the penalty.
    if (this.tryClockRescue(this.current)) return;
    const s = this.state;
    const p = this.current;

    // A real timeout is scored like a word: a penalty walk (the flat base loss
    // plus each glass-cannon card's drain, and any Insurance refund) the engine
    // theater replays card-by-card. finalScore is the net signed delta.
    const breakdown = scoreTimeout(p.bay, {
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      taxed: false,
      baseClockSeconds: s.settings.shotClockSeconds,
      era: s.era,
      slots: p.slots,
      history: s.history,
      services: this.services,
      effects: this.effects,
      player: p,
      players: s.players,
      clock: this.clockController,
    });
    // Apply the (negative) net delta to the score. No floor at 0 — scores can
    // already go negative via drains (Bounty Hunter / The Leech), and clamping
    // here would hide the penalty whenever the player is at or below it.
    p.score += breakdown.finalScore;
    const penalty = -breakdown.finalScore;
    // A timeout is not a clean submission: it breaks the Crescendo run, same as a tax.
    this.services.crescendoStreak.reset(p.id);

    // A synthetic "timed-out" submission drives the same theater + leaderboard
    // reveal as a scored word. It is NOT pushed to history (no real word, so it
    // never feeds Scavenger / the word feed / the used-word set).
    const submission: Submission = {
      playerId: p.id,
      displayName: p.name,
      accentIndex: p.accentIndex,
      era: s.era,
      word: draft || "—",
      score: breakdown.finalScore,
      taxed: false,
      taxBounty: 0,
      breakdown,
      timedOut: true,
    };

    if (s.settings.survivalMode) p.eliminated = true;
    // Required letter is unchanged: the next player still faces it.
    this.events.emit("timeout", { playerId: p.id, penalty });
    this.events.emit("submission", { submission, bounties: [] });
    // There is now a replay to watch (the penalty walk), so settle like a real
    // submission — an era-ending timeout waits it out before transitioning.
    this.endTurn(true);
  }

  // ── Intermission ─────────────────────────────────────────────────────────────
  // Host-authoritative sub-phase walk (timers live here, not in the UI):
  //   [tutorial(engine) — era 1] → optimize → [tutorial(tax) — era 1] → sniperBan
  /** Whether the match is in the era-end settle window (phase still Round, clock
   *  frozen, input refused) waiting for the final replay to finish. */
  isSettling(): boolean {
    return this.roundSettleRemaining > 0;
  }

  /** Fire the era-end transition deferred by the settle window. */
  private resolveEraEnd(): void {
    const pending = this.pendingEraEnd;
    this.pendingEraEnd = null;
    if (pending === "gameOver") this.gameOver();
    else if (pending === "intermission") this.enterIntermission();
  }

  private enterIntermission(): void {
    this.setPhase("Intermission");
    // `state.era` is still the era that just ended (it advances later in
    // applySniperBanAndAdvance). The card-era index — which deal this is — depends on whether
    // a pre-era-1 setup deal happened: with dealEngineCardsFirstEra the setup deal was cardEra 1,
    // so end-of-era-E is E+1; without it, end-of-era-1 is itself the first deal (cardEra 1).
    const cardEra = this.state.settings.dealEngineCardsFirstEra
      ? this.state.era + 1
      : this.state.era;
    const dealt: Record<string, string[]> = {};
    for (const p of this.state.players) {
      const newIds = this.dealCards(p, this.state.settings.modifiersDealtPerEra);
      dealt[p.id] = newIds;
      p.slots = modifierSlotsForCardEra(this.state.settings, cardEra); // Expansion (capped)
    }
    const lastPlaceId = this.computeLastPlaceId();
    this.events.emit("intermission", { lastPlaceId, dealt });
    this.beginIntermissionStage();
  }

  /** Announce a sub-phase change so the host re-broadcasts the new state. */
  private setIntermissionPhase(phase: IntermissionPhase, tutorial: TutorialKind | null): void {
    this.state.intermissionPhase = phase;
    this.state.currentTutorial = tutorial;
    this.events.emit("subPhaseChanged", { intermissionPhase: phase, currentTutorial: tutorial });
  }

  /** First sub-phase of an intermission: the optimize-cue tutorials (engine → cards,
   *  era 1) then optimize. */
  private beginIntermissionStage(): void {
    const next = this.nextTutorialIn(OPTIMIZE_TUTORIALS);
    if (next) this.enterIntermissionTutorial(next);
    else this.beginOptimize();
  }

  private enterIntermissionTutorial(kind: TutorialKind): void {
    this.state.tutorialReady = []; // fresh "I've read this" slate per page
    this.markTutorialShown(kind);
    this.armSubTimer(TUTORIAL_DWELL[kind]);
    this.setIntermissionPhase("tutorial", kind);
  }

  private advanceIntermissionTutorial(): void {
    // The optimize-cue group (engine → cards) plays before optimize; the ban-cue group
    // (tax → sniper) plays after it, just before the sniper ban.
    const kind = this.state.currentTutorial;
    if (kind && OPTIMIZE_TUTORIALS.includes(kind)) {
      const next = this.nextTutorialIn(OPTIMIZE_TUTORIALS);
      if (next) this.enterIntermissionTutorial(next);
      else this.beginOptimize();
      return;
    }
    const next = this.nextTutorialIn(BAN_TUTORIALS);
    if (next) this.enterIntermissionTutorial(next);
    else this.beginSniperBan();
  }

  private beginOptimize(): void {
    // Fresh lock-in slate every optimize: nobody has committed their engine yet.
    for (const p of this.state.players) p.lockedIn = false;
    this.armSubTimer(this.state.settings.intermissionCardSelectSeconds);
    this.setIntermissionPhase("optimize", null);
  }

  /** A player commits their engine during optimize. The shared dwell ends only once
   *  every active human player has locked in (bots are auto-locked) — otherwise we
   *  wait for the rest, or for the timer fallback (tickIntermission → completeOptimize).
   *  Host-authoritative: each client's LOCK IN routes here as a lockInOptimize intent. */
  lockInOptimize(playerId: string): void {
    if (this.state.phase !== "Intermission" || this.state.intermissionPhase !== "optimize") return;
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p || p.eliminated) return;
    p.lockedIn = true;
    if (this.allHumansLockedIn()) this.completeOptimize();
  }

  /** Re-open a player's engine: clears the lock-in set by lockInOptimize so they can
   *  keep editing while others finish. Only meaningful before everyone has locked in
   *  (once all are locked, completeOptimize has already advanced the phase). Called
   *  with a playerId by the host (per-player); the controller-facing solo path passes
   *  none and clears the active humans' locks defensively. Never advances. */
  unlockOptimize(playerId?: string): void {
    if (this.state.phase !== "Intermission" || this.state.intermissionPhase !== "optimize") return;
    const targets = playerId
      ? this.state.players.filter((x) => x.id === playerId)
      : this.activePlayers.filter((p) => !p.isBot);
    for (const p of targets) p.lockedIn = false;
  }

  /** Whether every active human player has locked in their engine (bots don't optimize). */
  private allHumansLockedIn(): boolean {
    return this.activePlayers.filter((p) => !p.isBot).every((p) => p.lockedIn);
  }

  /** A player disconnected mid-match. Mark them eliminated so the turn order skips
   *  them (they stay in `players` for the leaderboard / score history), and if it is
   *  currently their live turn, skip it cleanly — advancing the turn with NO timeout
   *  penalty — instead of letting their shot clock run down. */
  dropPlayer(playerId: string): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p || p.eliminated) return;
    p.eliminated = true;
    if (
      this.state.phase === "Round" &&
      this.roundSettleRemaining <= 0 &&
      this.current.id === playerId &&
      this.activePlayers.length > 0 // someone remains to hand the turn to
    ) {
      // fromSubmission=false → a plain advance (advanceIndex skips the now-eliminated
      // player), no scoreTimeout, no penalty, no timeout theater.
      this.endTurn();
    }
    // A departed straggler mustn't strand the players who already locked in.
    this.recheckOptimizeCompletion();
  }

  /** Re-evaluate optimize completion without a new lock-in — used when a player leaves
   *  mid-optimize, so a now-eliminated straggler can't strand everyone who already locked in. */
  recheckOptimizeCompletion(): void {
    if (
      this.state.phase === "Intermission" &&
      this.state.intermissionPhase === "optimize" &&
      this.allHumansLockedIn()
    )
      this.completeOptimize();
  }

  /** Optimize timer elapsed (or was skipped): drop the discard bin, then ban (via Tax). */
  private completeOptimize(): void {
    // Remove cards the player parked in the discard bin, then defensively trim to
    // capacity. A player who never interacted has no `discarded` flags, so the
    // filter is a no-op and the bay simply trims to the first `slots` (the AFK
    // fallback). Bots set their discard split when the optimize sub-phase opens
    // (LocalController → planBotBay/setPlayerBay).
    for (const p of this.state.players) {
      p.bay = p.bay.filter((b) => !b.discarded);
      if (p.bay.length > p.slots) p.bay = p.bay.slice(0, p.slots);
      p.lockedIn = false; // optimize is over; clear the lock-in slate
    }
    // Pre-era-1 setup optimize (no round has been played yet): there's no last-place
    // player to ban, so skip the ban tutorials + sniper ban and start era 1. This path
    // bypasses the era-boundary reset in applySniperBanAndAdvance, so clear the dealt
    // cards' "new" flag here — otherwise they'd stay flagged through era 1 and (mis)default
    // into the discard bin at the era-1-end optimize (ac-intermission's `discarded ?? isNew`).
    if (this.state.round === 0) {
      for (const p of this.state.players) p.bay.forEach((b) => (b.isNew = false));
      this.beginCountdown();
      return;
    }
    const next = this.nextTutorialIn(BAN_TUTORIALS);
    if (next) this.enterIntermissionTutorial(next);
    else this.beginSniperBan();
  }

  private beginSniperBan(): void {
    this.armSubTimer(this.state.settings.sniperBanSeconds);
    this.setIntermissionPhase("sniperBan", null);
  }

  /** Drive the active intermission sub-phase's dwell/timer. */
  private tickIntermission(dt: number): void {
    const s = this.state;
    if (s.intermissionPhase === null) return;
    s.subTimerRemaining = Math.max(0, s.subTimerRemaining - dt);
    this.events.emit("subTimerTick", s.subTimerRemaining);
    if (s.subTimerRemaining > 0) return;
    switch (s.intermissionPhase) {
      case "tutorial":
        this.advanceIntermissionTutorial();
        break;
      case "optimize":
        this.completeOptimize();
        break;
      case "sniperBan":
        // The last-place player ran out of time — apply a random legal ban.
        this.applySniperBanAndAdvance(this.randomBanLetter());
        break;
    }
  }

  /** Record that a tutorial has been shown (so each fires at most once). */
  markTutorialShown(kind: TutorialKind): void {
    if (!this.state.shownTutorials.includes(kind)) this.state.shownTutorials.push(kind);
  }

  private dealCards(player: PlayerState, count: number): string[] {
    const dealt: string[] = [];
    for (let i = 0; i < count; i++) {
      // A card is dealable to this player only while they hold fewer than its
      // maxInstances (default 3). Recompute each draw so a cap reached mid-batch
      // (e.g. a card dealt twice this era) drops it from later draws too. If every
      // dealable card is capped for this player the pool is empty and dealing stops
      // early below.
      const pool = DEALABLE_CARD_IDS.filter((id) => {
        const max = getCard(id)?.maxInstances ?? DEFAULT_MAX_INSTANCES;
        const owned = player.bay.filter((b) => b.id === id).length;
        return owned < max;
      });
      if (pool.length === 0) break;
      const id = pool[Math.floor(this.rng() * pool.length)];
      dealt.push(id);
      player.bay.push({ id, uid: this.nextBayUid(), isNew: true });
    }
    return dealt;
  }

  /** Monotonic source of per-instance bay-card handles (see BayCard.uid). Lives
   *  only on the authoritative match; guests receive the resulting uids in the
   *  synced state, so they never generate their own. */
  private bayUidSeq = 0;
  private nextBayUid(): string {
    return `b${++this.bayUidSeq}`;
  }

  /** The current last-place active player (lowest score; first by turn order on ties). */
  computeLastPlaceId(): string {
    const active = this.activePlayers;
    let last = active[0];
    for (const p of active) if (p.score < last.score) last = p;
    // Defensive: never index into an empty active set.
    return last?.id ?? "";
  }

  /** Replace a player's bay with an explicit engine/discard split (the optimize UI).
   *  The bay stores engine cards first (discarded: false) then the discard bin
   *  (discarded: true); discarded cards are dropped once optimize completes
   *  (completeOptimize). The full set is kept until then so the player can freely
   *  move cards between the engine and the bin. */
  setPlayerBay(playerId: string, engineUids: string[], discardUids: string[]): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    // Key by the per-instance uid, not the card id, so duplicate cards stay
    // distinct. Backfill a uid for any card missing one (test-built bays).
    for (const b of p.bay) b.uid ??= this.nextBayUid();
    const owned = new Map(p.bay.map((b) => [b.uid!, b] as const));
    const seen = new Set<string>();
    const take = (uid: string, discarded: boolean): BayCard | null => {
      const b = owned.get(uid);
      if (!b || seen.has(uid)) return null;
      seen.add(uid);
      return { ...b, discarded };
    };
    const next: BayCard[] = [];
    for (const uid of engineUids) {
      const b = take(uid, false);
      if (b) next.push(b);
    }
    for (const uid of discardUids) {
      const b = take(uid, true);
      if (b) next.push(b);
    }
    // Defensive: keep any owned card the caller omitted (never silently lost).
    for (const b of p.bay) if (!seen.has(b.uid!)) next.push({ ...b, discarded: false });
    p.bay = next;
  }

  /** Bots/non-submitters: trim oldest (left) cards to fit the expanded capacity. */
  autoTrimBay(playerId: string): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    if (p.bay.length > p.slots) p.bay = p.bay.slice(p.bay.length - p.slots);
  }

  /** Apply the sniper ban then roll into the next era's countdown. The chosen letter
   *  is validated against the ban-repeat rule (an illegal/repeat pick — or a malicious
   *  guest intent — falls back to a random legal letter); the exclusion set is reset
   *  when every legal letter has already been banned (NoRepeat exhaustion). */
  applySniperBanAndAdvance(letter: string): void {
    const { banMode, banRepeatRule } = this.state.settings;
    // Exhaustion reset (only reachable under NoRepeat across many eras): once every
    // legal letter has been banned, clear the history so the pool reopens.
    if (banRepeatRule === "NoRepeat") {
      const banned = new Set(this.state.bannedLetterHistory.map((l) => l.toLowerCase()));
      if (legalBanLetters(banMode).every((c) => banned.has(c))) this.state.bannedLetterHistory = [];
    }
    const available = availableBanLetters(banMode, banRepeatRule, this.state.bannedLetterHistory);
    const allowed = new Set(available);
    const lower = letter.toLowerCase();
    const choice = allowed.has(lower)
      ? lower
      : available[Math.floor(this.rng() * available.length)];
    this.state.bannedLetter = choice;
    this.state.bannedLetterHistory = [...this.state.bannedLetterHistory, choice];
    for (const p of this.state.players) p.bay.forEach((b) => (b.isNew = false));
    this.state.era += 1;
    // Era boundary: reset the per-era guards (Prism/Wildcard re-arm, card/hijack
    // bans clear) BEFORE firing OnEraStart, so personal-ban cards roll fresh
    // letters for the new era (which dodge the just-set era ban).
    for (const p of this.state.players) this.armPlayerForEra(p);
    this.state.intermissionPhase = null;
    this.state.currentTutorial = null;
    this.state.subTimerRemaining = 0;
    this.state.subTimerTotal = 0;
    this.beginCountdown();
  }

  randomBanLetter(): string {
    const available = availableBanLetters(
      this.state.settings.banMode,
      this.state.settings.banRepeatRule,
      this.state.bannedLetterHistory,
    );
    return available[Math.floor(this.rng() * available.length)];
  }

  /** Re-arm a player's per-era room state (Prism/Wildcard guards, card/hijack
   *  bans) and fire each card's OnEraStart. Shared by era boundaries and the
   *  testing bench's bay edits. */
  private armPlayerForEra(p: PlayerState): void {
    this.services.fireEraStarted(p);
    fireBayHook(this.bayEval(p, "", false), "onEraStart");
    // Stamp the rolled bans onto the player so they ride the snapshot to guests
    // (the host itself reads the live CardBanService via personalBansFor). This is
    // the only point bans change — reset in fireEraStarted, rolled in onEraStart —
    // so each era overwrites cleanly with no stale carryover.
    p.personalBans = this.personalBansFor(p.id);
  }

  // ── Bench / testing (Testing Bay only — never reached in real play) ──────────
  /** Replace a player's bay with an arbitrary, uncapped set of cards, then re-arm
   *  their per-era state so every card is functional (the bench builds bays
   *  outside the deal flow that normally grants shields / arms guards). */
  benchSetBay(playerId: string, orderedIds: string[]): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    p.bay = orderedIds.filter((id) => getCard(id)).map((id) => ({ id, uid: this.nextBayUid() }));
    this.armPlayerForEra(p);
  }

  /** Advance to the next player without scoring (bench "skip turn"). */
  benchSkipTurn(): void {
    if (this.state.phase === "Round") this.endTurn();
  }

  // ── End ────────────────────────────────────────────────────────────────────
  private gameOver(): void {
    this.state.endedAt = this.now();
    const standings = [...this.state.players].sort(byScoreDesc);
    this.state.winnerId = standings[0]?.id ?? null;
    this.setPhase("GameOver");
    this.events.emit("gameOver", { winnerId: this.state.winnerId, standings });
  }

  /** Utility for the UI: is `letter` a vowel (for picker grouping). */
  static isVowel = isVowel;

  /** Standings sorted high→low (for live leaderboard). Explicit comparison rather
   *  than subtraction so a stray NaN score can't scramble the order. */
  standings(): PlayerState[] {
    return [...this.state.players].sort(byScoreDesc);
  }

  /** Bay cards as resolved ModifierCard objects (UI convenience). */
  bayCards(playerId: string): BayCard[] {
    return this.state.players.find((p) => p.id === playerId)?.bay ?? [];
  }
}
