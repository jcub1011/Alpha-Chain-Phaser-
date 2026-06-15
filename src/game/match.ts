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
import type { ModifierCard } from "./cards/card";
import {
  BanLetterService,
  EngineEffects,
  RoomServices,
} from "./cards/roomServices";
import { Emitter } from "./emitter";
import {
  armedClockSeconds,
  bayOwnTaxPolicy,
  bayViolatesLegality,
  bayWriteOffBonus,
  baySuccessionExempt,
  fireBayHook,
  makeBayEvaluator,
  scoreWord,
  type BayEvaluator,
} from "./scoring";
import {
  legalBanLetters,
  MIN_SHOT_CLOCK_SECONDS,
  MODIFIER_SLOTS_START,
  isVowel,
} from "./settings";
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

/** Tutorial dwell durations in seconds (port of TutorialState.DurationFor). */
const TUTORIAL_DWELL: Record<TutorialKind, number> = {
  shiritori: 12,
  engine: 14,
  tax: 12,
};

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
  /** Tutorial phase / intermission sub-phase changed (drives a host snapshot). */
  subPhaseChanged: { intermissionPhase: IntermissionPhase; currentTutorial: TutorialKind | null };
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
  /** Leader the Bounty Hunter watches; fixed at each round's start (not live). */
  private roundLeaderId = "";
  readonly state: MatchState;

  /** Card-contributed, player-keyed room state (shield, guards, bans, penalties). */
  readonly services: RoomServices;
  /** Routes automated attacks (time shave / drain / hijack) through interceptors. */
  readonly effects: EngineEffects;
  /** Live clock controller a card hook can refill (The Prism on a typo). */
  private readonly clockController = {
    refillToFull: (): void => {
      this.state.clockRemaining = this.state.clockTotal;
      this.events.emit("clockTick", this.state.clockRemaining);
    },
  };

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
      intermissionPhase: null,
      currentTutorial: null,
      subTimerRemaining: 0,
      subTimerTotal: 0,
      shownTutorials: [],
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
      cardsOf: (p) =>
        p.bay
          .map((b) => getCard(b.id))
          .filter((c): c is ModifierCard => c !== undefined),
      activePlayers: () => this.turnOrderedActive(),
      leaderId: () => this.roundLeaderId,
      armedClockOf: (p) => armedClockSeconds(this.state.settings.shotClockSeconds, p.bay),
    });
  }

  /** Active players in turn order (index-aligned with how turns advance). */
  private turnOrderedActive(): PlayerState[] {
    return this.state.players.filter((p) => !p.eliminated);
  }

  /** The current leader's id (highest score; earliest turn order breaks ties). */
  computeLeaderId(): string {
    const active = this.turnOrderedActive();
    let lead = active[0];
    for (const p of active) if (p.score > lead.score) lead = p;
    return lead?.id ?? "";
  }

  /** Build the shared bay evaluator + hook context for `player` scoring `word`. */
  private bayEval(player: PlayerState, word: string, taxed: boolean): BayEvaluator {
    return makeBayEvaluator(word, player.bay, {
      prevWordLength: this.prevWordLength,
      clockRemaining: this.state.clockRemaining,
      clockTotal: this.state.clockTotal,
      taxed,
      baseClockSeconds: this.state.settings.shotClockSeconds,
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
    return p.bay.some((b) => getCard(b.id)?.hidesInput?.(this.bayEval(p, "", false).ctxFor(0)) ?? false);
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
    // The Shiritori tutorial (if enabled) plays once before the very first round.
    if (this.shouldShowTutorial("shiritori")) this.enterTutorialPhase("shiritori");
    else this.beginCountdown();
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
      if (s.subTimerRemaining <= 0) this.advanceTutorialPhase();
    } else if (s.phase === "Countdown") {
      const prev = Math.ceil(this.countdownRemaining);
      this.countdownRemaining -= dt;
      const now = Math.ceil(Math.max(0, this.countdownRemaining));
      if (now !== prev) this.events.emit("countdownTick", now);
      if (this.countdownRemaining <= 0) this.beginEra(s.era === 1);
    } else if (s.phase === "Round") {
      s.clockRemaining = Math.max(0, s.clockRemaining - dt);
      this.events.emit("clockTick", s.clockRemaining);
      if (s.clockRemaining <= 0) this.timeoutCurrent();
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

  private armSubTimer(seconds: number): void {
    this.state.subTimerTotal = seconds;
    this.state.subTimerRemaining = seconds;
  }

  /** Enter the top-level Shiritori tutorial phase (before the first countdown). */
  private enterTutorialPhase(kind: TutorialKind): void {
    this.state.currentTutorial = kind;
    this.markTutorialShown(kind);
    this.armSubTimer(TUTORIAL_DWELL[kind]);
    this.setPhase("Tutorial");
  }

  private advanceTutorialPhase(): void {
    this.state.currentTutorial = null;
    this.beginCountdown();
  }

  /** Skip the current tutorial (Shiritori phase or an intermission tutorial). */
  skipTutorial(): void {
    if (this.state.phase === "Tutorial") this.advanceTutorialPhase();
    else if (this.state.phase === "Intermission" && this.state.intermissionPhase === "tutorial")
      this.advanceIntermissionTutorial();
  }

  /** Fast-forward the optimize sub-phase (solo convenience; host shared display). */
  skipOptimize(): void {
    if (this.state.phase === "Intermission" && this.state.intermissionPhase === "optimize")
      this.completeOptimize();
  }

  private beginEra(first: boolean): void {
    this.setPhase("Round");
    // A "round" is one full cycle of all players (GDD §4); the era runs for
    // `eraInterval` such rounds. roundInEra is 1-based and starts at the first
    // round of the era; the player who the wrap left active opens each new era.
    this.state.roundInEra = 1;
    this.state.round++;
    if (first) {
      this.state.currentPlayerIndex = 0;
      this.state.requiredLetter = "";
    }
    this.roundLeaderId = this.computeLeaderId();
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
    // Per-turn room state re-arms (currently a no-op seam; A5 uses it).
    this.services.fireTurnStarted(p);
    let armed = armedClockSeconds(this.state.settings.shotClockSeconds, p.bay);
    // Flak Cannon queued a shave onto this player's next clock.
    const penalty = this.services.timePenalty.consumeFor(p.id);
    if (penalty > 0) armed = Math.max(MIN_SHOT_CLOCK_SECONDS, armed - penalty);
    this.state.clockTotal = armed;
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
    const wrapped = this.advanceIndex();
    if (wrapped) {
      this.state.round++;
      // The era ends once `eraInterval` full rounds have been completed.
      if (this.state.roundInEra >= this.state.settings.eraInterval) {
        if (this.state.era >= this.state.settings.eraCount) this.gameOver();
        else this.enterIntermission();
        return;
      }
      this.state.roundInEra++;
      // New round → re-mark the leader the Bounty Hunter watches.
      this.roundLeaderId = this.computeLeaderId();
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

  submitWord(playerId: string, rawWord: string): SubmitResult {
    const s = this.state;
    if (s.phase !== "Round" || playerId !== this.current.id) {
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

    // 6. Dictionary — a typo fires the owner's Prism (clock refill), turn unchanged.
    if (!this.isWord(word)) {
      fireBayHook(this.bayEval(player, word, false), "onValidationFailed");
      return reject("not-a-word");
    }

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

    // 8. Score, then the two owner-side tax rules (IRS Agent flat override +
    //    bounty suppression, then Tax Write-Off's first-letter salvage on top).
    const scoreOpts = {
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      baseClockSeconds: s.settings.shotClockSeconds,
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
      const bonus = bayWriteOffBonus(evCheck, (w) =>
        scoreWord(w, player.bay, { ...scoreOpts, taxed: false }).finalScore,
      );
      if (bonus > 0) finalScore += bonus;
      breakdown.finalScore = finalScore;
    }

    // 9. Consume the one-shot hijack ban (read above) + the era's Wildcard charge.
    this.services.hijackBan.consumeFor(player.id);
    if (usedWildcard) this.services.wildcardGuard.tryConsume(player.id);

    // 10–11. Record + credit, then advance the chain's required letter.
    player.score += finalScore;
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
    this.endTurn();
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

  private timeoutCurrent(): void {
    const p = this.current;
    if (this.state.settings.survivalMode) p.eliminated = true;
    // Required letter is unchanged: the next player still faces it.
    this.events.emit("timeout", { playerId: p.id });
    this.endTurn();
  }

  // ── Intermission ─────────────────────────────────────────────────────────────
  // Host-authoritative sub-phase walk (timers live here, not in the UI):
  //   [tutorial(engine) — era 1] → optimize → [tutorial(tax) — era 1] → sniperBan
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
    this.beginIntermissionStage();
  }

  /** Announce a sub-phase change so the host re-broadcasts the new state. */
  private setIntermissionPhase(phase: IntermissionPhase, tutorial: TutorialKind | null): void {
    this.state.intermissionPhase = phase;
    this.state.currentTutorial = tutorial;
    this.events.emit("subPhaseChanged", { intermissionPhase: phase, currentTutorial: tutorial });
  }

  /** First sub-phase of an intermission: the Engine tutorial (era 1) or optimize. */
  private beginIntermissionStage(): void {
    if (this.shouldShowTutorial("engine")) this.enterIntermissionTutorial("engine");
    else this.beginOptimize();
  }

  private enterIntermissionTutorial(kind: TutorialKind): void {
    this.markTutorialShown(kind);
    this.armSubTimer(TUTORIAL_DWELL[kind]);
    this.setIntermissionPhase("tutorial", kind);
  }

  private advanceIntermissionTutorial(): void {
    // Engine plays before optimize; Tax plays after it (just before the ban).
    const kind = this.state.currentTutorial;
    if (kind === "engine") this.beginOptimize();
    else this.beginSniperBan();
  }

  private beginOptimize(): void {
    this.armSubTimer(this.state.settings.intermissionCardSelectSeconds);
    this.setIntermissionPhase("optimize", null);
  }

  /** Optimize timer elapsed (or was skipped): trim overflow, then ban (via Tax). */
  private completeOptimize(): void {
    for (const p of this.state.players) this.autoTrimBay(p.id);
    if (this.shouldShowTutorial("tax")) this.enterIntermissionTutorial("tax");
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
    const owned = new Set(player.bay.map((b) => b.id));
    const pool = DEALABLE_CARD_IDS.filter((id) => !owned.has(id));
    const dealt: string[] = [];
    for (let i = 0; i < count && pool.length > 0; i++) {
      const idx = Math.floor(this.rng() * pool.length);
      const [id] = pool.splice(idx, 1);
      dealt.push(id);
      player.bay.push({ id, isNew: true });
      // A fresh Titanium Mirror resets the player's shield to ×1.0 (GDD §3.7).
      if (id === "TitaniumMirror") this.services.shield.grantFresh(player.id);
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
    const legal = legalBanLetters(this.state.settings.banMode);
    return legal[Math.floor(this.rng() * legal.length)];
  }

  /** Re-arm a player's per-era room state (Prism/Wildcard guards, card/hijack
   *  bans) and fire each card's OnEraStart. Shared by era boundaries and the
   *  testing bench's bay edits. */
  private armPlayerForEra(p: PlayerState): void {
    this.services.fireEraStarted(p);
    fireBayHook(this.bayEval(p, "", false), "onEraStart");
  }

  // ── Bench / testing (Testing Bay only — never reached in real play) ──────────
  /** Replace a player's bay with an arbitrary, uncapped set of cards, then re-arm
   *  their per-era state so every card is functional (the bench builds bays
   *  outside the deal flow that normally grants shields / arms guards). */
  benchSetBay(playerId: string, orderedIds: string[]): void {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    p.bay = orderedIds.filter((id) => getCard(id)).map((id) => ({ id }));
    // A fresh Titanium Mirror grants its ×1.0 shield (normally done on deal).
    for (const b of p.bay) if (b.id === "TitaniumMirror") this.services.shield.grantFresh(p.id);
    this.armPlayerForEra(p);
  }

  /** Advance to the next player without scoring (bench "skip turn"). */
  benchSkipTurn(): void {
    if (this.state.phase === "Round") this.endTurn();
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
