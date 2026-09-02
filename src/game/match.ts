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

import { cardIdentity, dealableCardIds, getCard } from "./cards/library";
import { DEFAULT_MAX_INSTANCES } from "./cards/card";
import { BanLetterService, EngineEffects, RoomServices } from "./cards/roomServices";
import { createLogger } from "../log";
import { nextLiveIndex } from "./turnOrder";
import { Emitter } from "./emitter";
import { buildPoolIndex, type PoolIndex } from "./picker/offer";
import {
  bubblePreferences,
  isInertPreference,
  type PreferenceContext,
} from "./picker/preference";
import {
  canConstructWordFromTiles,
  effectiveRackSize,
  generateRack,
  letterSupportsRack,
  subWordFinder,
  type RackShaping,
  type ScanBudget,
} from "./builder/rack";
import type { WordPool } from "./picker/wordPool";
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
  rarityDealWeights,
  isVowel,
} from "./settings";
import { byScoreDesc, emptyMatchState, GameMode } from "./types";
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
  offer: 14,
  pickerTimeout: 12,
  engine: 14,
  cards: 13,
  tax: 13,
  sniper: 12,
};

/** Tutorial pages shown in sequence at each cue point (in order). Pre-game pages run
 *  during the top-level Tutorial phase; the optimize/ban groups run as intermission
 *  sub-phases before the era-1 optimize and sniper ban respectively. */
/* Pre-game pages, per mode. This list is the ONE tutorial map that is not exhaustive over
 * TutorialKind, so nothing here is a compile error — and getting it wrong is invisible: a
 * first-run player in the DEFAULT mode would simply be taught the wrong game. Classic's pair is
 * left byte-identical. */
const PREGAME_TUTORIALS: Record<GameMode, readonly TutorialKind[]> = {
  [GameMode.Classic]: ["shiritori", "timeout"],
  [GameMode.Picker]: ["offer", "pickerTimeout"],
};
const OPTIMIZE_TUTORIALS: readonly TutorialKind[] = ["engine", "cards"];
const BAN_TUTORIALS: readonly TutorialKind[] = ["tax", "sniper"];

/** Extra dwell (seconds) added to the engine animation when an era ends on a
 *  submission, so every player sees the final word's score replay finish before
 *  the phase changes. Covers the taxed finale (~0.92s) on top of the walk. */
const ROUND_SETTLE_BUFFER = 1.0;

/** Word Builder: how many buildable words the no-show auto-pick gathers before picking one.
 *
 *  A cap, not a budget: the pick needs ONE word, and `subWordFinder` scans a whole starting-letter
 *  bucket per call. Uncapped on a free required letter it walks every letter of the pool — a
 *  full-dictionary sweep (386k words under Sudden Death's Full tier) on the expiry tick, inside the
 *  server's Jint sandbox where there is no JIT. Matches the cap the bench getter already uses. */
const NO_SHOW_CANDIDATE_CAP = 24;

/** Pool candidates the no-show auto-pick may examine, shared across every letter it tries.
 *
 *  NO_SHOW_CANDIDATE_CAP bounds what the scan RETURNS, which is no bound at all on a rack that
 *  returns nothing: the free-letter branch walks all 26 start letters, so an unbuildable rack cost
 *  a full-pool sweep — 8,920 words on the Reduced list, 386,633 on the Full one — on the
 *  shot-clock expiry tick, inside a 250ms Jint call whose overrun kills the lobby. Measured at
 *  26,258 pool crossings in one tick before this cap.
 *
 *  Binding out returns null, which resolves the turn as the "—" no-show with the chain letter
 *  unmoved. That is the same outcome an honest exhaustive scan reaches on a rack that spells
 *  nothing, and it is an existing, tested path. */
const NO_SHOW_SCAN_BUDGET = 2500;

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
  /** Picker: a SEPARATE stream for Offer generation, defaulting to `rng`.
   *
   *  Offer generation makes a rejection-dependent number of draws, so sharing one stream with
   *  `dealCards` means an Offer shifts which cards a later era deals. Harmless in production
   *  (kb.rng is absent, so it is Math.random) but it matters wherever the main rng is deliberately
   *  degenerate: the Testing Bay pins turn order with `orderPreservingRng`, a CONSTANT, which
   *  would otherwise make every Offer a run of alphabetically-extreme words and misrepresent the
   *  mode it exists to test. */
  offerRng?: () => number;
  /** Picker: the pool the Offer is drawn from (`kb.words` server-side, the client `Dictionary`
   *  solo). Optional so Classic-only callers and the existing tests need no change; a Picker
   *  match constructed without one logs once and falls back to Classic rather than throwing,
   *  because a wiring mistake must never hang a lobby. */
  wordPool?: WordPool;
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
  /** Picker: the word the current player has selected but not yet committed, streamed in via
   *  setSelection so a shot-clock expiry can commit it. Transient, exactly like currentDraft —
   *  nothing requires publishing an opponent's in-progress selection, and keeping it off
   *  MatchState keeps the authority in broadcast mode with no extra wire state.
   *
   *  Stores the WORD, not the Offer index: an index would silently commit a different word if
   *  the Offer were ever regenerated mid-turn (M3's Winnower), whereas a stale word simply fails
   *  the offer-membership check. `null` means no selection — which is what makes a clock expiry a
   *  no-show rather than a slow pick. */
  private currentSelection: string | null = null;
  /** Picker: this turn's Offer ignored the Succession letter, because the player spent their
   *  Wildcard charge on it. Lets commitSelection waive the succession check for exactly this
   *  turn without the charge having to survive until the commit. */
  private offerIgnoresSuccession = false;
  /** Picker: a no-show elimination to apply at the top of endTurn.
   *
   *  Deferred rather than applied inline because Survival must see the elimination BEFORE
   *  endTurn's active-count check (which runs inside submitWord), yet a Prism rescue means the
   *  commit may not reach endTurn at all. A flag is cleared by the next armCurrentTurn, so the
   *  rescue path discards it automatically instead of needing a mutate-then-revert. */
  private pendingNoShowElimination: string | null = null;
  /** Picker: the Offer pool and a lazily-built index over it. The index memoizes immutable pool
   *  facts (letter ranges, per-letter totals), so it is built once per match and reused — Classic
   *  builds neither. */
  private readonly wordPool?: WordPool;
  /** The stream Offer generation draws from; `rng` unless a caller separated them. */
  private readonly offerRng: () => number;
  private poolIndex?: PoolIndex;
  /** Whether `warmPoolIndex` has already run for this match. */
  private poolIndexWarmed = false;
  private warnedMissingPool = false;
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
    this.wordPool = deps.wordPool;
    this.offerRng = deps.offerRng ?? this.rng;
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
    // Defaults come from emptyMatchState, which its own doc names as the single place every new
    // MatchState field is defaulted — this constructor used to duplicate all 21 fields, so the
    // two could silently drift and the guest mirror would disagree with the authority. Only
    // `players` differs here (seeded from the roster).
    this.state = { ...emptyMatchState(settings), players };
    this.services = new RoomServices(
      new BanLetterService(
        this.rng,
        () => this.state.settings.banMode,
        () => this.state.bannedLetter,
      ),
    );
    this.effects = new EngineEffects(this.services, {
      activePlayers: () => this.turnOrderedActive(),
      armedClockOf: (p) => armedClockSeconds(this.baseClockSeconds, p.bay, this.effectiveMode),
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
      mode: this.effectiveMode,
      prevWordLength: this.prevWordLength,
      clockRemaining: this.state.clockRemaining,
      clockTotal: this.state.clockTotal,
      taxed,
      baseClockSeconds: this.baseClockSeconds,
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
    return p.bay.some((b) => getCard(b.id, this.effectiveMode)?.hidesInput?.() ?? false);
  }

  // ── Accessors ──────────────────────────────────────────────────────────────
  get current(): PlayerState {
    return this.state.players[this.state.currentPlayerIndex];
  }

  /** Whether this match runs Picker (word selection) rather than Classic (typed entry).
   *
   *  Requires a pool: Picker without one cannot generate an Offer, and silently playing an
   *  unplayable match is worse than falling back. The warning fires once so a wiring mistake is
   *  visible without flooding the log every turn. */
  private get isPicker(): boolean {
    if (this.state.settings.gameMode !== GameMode.Picker) return false;
    if (this.wordPool) return true;
    if (!this.warnedMissingPool) {
      this.warnedMissingPool = true;
      log.error("picker mode requested but no wordPool was injected — falling back to classic");
    }
    return false;
  }

  /** The match's base shot clock, mode-aware. Every reader of the clock for SCORING purposes must
   *  go through this rather than `settings.shotClockSeconds`, because `baseClockSeconds` feeds
   *  every clock-scaling card's fraction (Panic Button, Speedracer, The Vault, Redline, Chrono
   *  Syphon) — a site that reads the raw setting mis-scores silently instead of failing.
   *
   *  Keyed on `isPicker`, NOT on the raw setting: a match that asked for Picker but fell back to
   *  Classic for want of a word pool must fall back to Classic's clock too, or it would arm the
   *  pick timer for a typing match. */
  get baseClockSeconds(): number {
    return this.isPicker
      ? this.state.settings.pickerShotClockSeconds
      : this.state.settings.shotClockSeconds;
  }

  /**
   * The mode whose CARD VALUES this match scores with — pass it to `getCard` / `ScoreOptions.mode`
   * / `armedClockSeconds` rather than reading `settings.gameMode` for anything a card's numbers
   * depend on.
   *
   * Keyed on `isPicker`, NOT the raw setting — the same reasoning as `baseClockSeconds`, and for
   * the same underlying reason: Picker's card values exist to compensate for Picker's clock
   * economy, so they must follow the clock they compensate. A match that asked for Picker but fell
   * back for want of a word pool types its words and levies a real timeout penalty through
   * `timeoutCurrent`, so handing it Picker's re-costed cards would pair Classic's timeout drain
   * with Picker's compensating buff — strictly worse than either mode.
   *
   * Deliberately NOT used by `dealCards`, which keys on the replicated `settings.gameMode` so the
   * deal depends only on replicated state; see the comment there.
   */
  get effectiveMode(): GameMode {
    return this.isPicker ? GameMode.Picker : GameMode.Classic;
  }

  /** The pre-game tutorial pages for the mode this match will ACTUALLY play.
   *
   *  Keyed on `isPicker`, not the raw setting — the same reasoning as `baseClockSeconds`. A match
   *  that asked for Picker but fell back to Classic for want of a word pool will present typed
   *  entry, so teaching the player to tap Offer Cards that will never appear is worse than either
   *  mode's tutorial.
   *
   *  Note this differs from `dealCards`, which deliberately keys on the replicated
   *  `settings.gameMode`: the deal must depend only on replicated state, whereas the tutorial run
   *  is host-authoritative and reaches guests as snapshots — they never evaluate this. */
  private get pregameTutorials(): readonly TutorialKind[] {
    return PREGAME_TUTORIALS[this.isPicker ? GameMode.Picker : GameMode.Classic];
  }

  get wordPoolInstance(): WordPool | undefined {
    return this.wordPool;
  }

  /** Word Builder: whether THIS turn's rack was drawn free of the Succession letter — a spent
   *  Wildcard charge, or a letter whose words were exhausted.
   *
   *  Anything asking what the rack can build must consult this rather than `state.requiredLetter`,
   *  which is deliberately left standing on a free draw (the chain still advances from it). Filter
   *  by a letter the rack was built WITHOUT and the only honest answer is "nothing buildable". */
  get successionWaivedThisTurn(): boolean {
    return this.offerIgnoresSuccession;
  }

  /** The Offer index, built on first use so Classic pays nothing. */
  get offerIndex(): PoolIndex {
    return (this.poolIndex ??= buildPoolIndex(this.wordPool!));
  }

  /** Pay the index's one-time cost on a Countdown tick instead of on the tick that arms the era.
   *
   *  `startLetters()` is the index's most expensive query — it settles all 26 letters — and until
   *  it was warmed it landed on the tick that also runs `beginEra` -> `armCurrentTurn` ->
   *  `generateRack`, which is already the most expensive tick of the match and the one the server's
   *  250ms Jint timeout killed. Countdown ticks do nothing else and there are
   *  `preRoundCountdownSeconds` x tickHz of them (80 at the defaults), so the work goes there.
   *
   *  Pure memo population: PoolIndex consumes no rng and holds no match state, so this moves WHEN
   *  the cost is paid and can never move an outcome. */
  private warmPoolIndex(): void {
    if (this.poolIndexWarmed || !this.isPicker || !this.wordPool) return;
    this.poolIndexWarmed = true;
    this.offerIndex.startLetters();
  }

  /**
   * The next turn's required letter, given the letter the accepted word ended on.
   *
   * Two reasons the chain gets waived (`""` = free choice), both of which exist to stop a turn
   * being unplayable through no fault of the player:
   *
   *  1. The letter is the banned letter — the original rule: you cannot be required to open on a
   *     letter the Prism punishes.
   *  2. Word Builder only: the word pool cannot support a rack for that letter. `subWordFinder`
   *     returns only words STARTING with the required letter, so landing on `x` — one word in the
   *     shipped Reduced list — hands the next player a rack whose sole buildable word is the Golden
   *     Seed. See `letterSupportsRack`.
   *
   * Classic is deliberately exempt from (2): there the player types freely, so a thin letter is a
   * difficulty spike rather than a dead end, and waiving Succession would change Classic's rules.
   */
  private nextRequiredLetter(last: string): string {
    if (this.state.bannedLetter && last === this.state.bannedLetter) return "";
    if (this.isPicker && !letterSupportsRack(this.offerIndex, last, this.successorRackSize())) {
      return "";
    }
    return last;
  }

  /** The rack size the player who INHERITS this letter will actually hold: the base setting plus
   *  their own bay's slot delta (Wide Net +2, Tunnel Vision -2). That delta is exactly the
   *  sensitivity `letterSupportsRack` measures — a letter that supports a 9-tile rack can still
   *  dead-end a 7-tile one — so measuring the base setting asks about a rack nobody gets.
   *
   *  Called from `submitWord`, before `endTurn` advances the order, so the peek is exact within a
   *  round. Should the turn instead wrap into a new era, `beginEra` resets `requiredLetter` to ""
   *  and whatever this produced is discarded — the peek is never load-bearing across an era. */
  private successorRackSize(): number {
    const successor = this.state.players[this.peekNextIndex(this.state.currentPlayerIndex).index];
    return effectiveRackSize(
      this.state.settings.rackSize,
      successor ? this.rackShapingFor(successor).slotDelta : 0,
    );
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
    const first = this.nextTutorialIn(this.pregameTutorials);
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
      this.warmPoolIndex();
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
    const next = this.nextTutorialIn(this.pregameTutorials);
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

  /** Where the turn order goes next WITHOUT moving it: the next non-eliminated seat after
   *  `index`, and whether reaching it wraps the round. `advanceIndex` is this plus the
   *  assignment; `nextRequiredLetter` peeks so it can size the successor's rack. */
  private peekNextIndex(index: number): { index: number; wrapped: boolean } {
    return nextLiveIndex(this.state.players, index);
  }

  /** Advance to the next active player; returns true if the turn order wrapped
   *  (i.e. every player has now had a turn this round). */
  private advanceIndex(): boolean {
    const { index, wrapped } = this.peekNextIndex(this.state.currentPlayerIndex);
    this.state.currentPlayerIndex = index;
    return wrapped;
  }

  /** Arm the shot clock for the current player and announce the turn. Does not
   *  advance the turn order or touch the round counters. */
  private armCurrentTurn(): void {
    const p = this.current;
    this.currentDraft = ""; // each turn starts with a blank draft (no stale carry-over)
    this.currentSelection = null;
    this.offerIgnoresSuccession = false;
    this.pendingNoShowElimination = null; // a rescued turn discards its armed no-show
    this.state.rack = [];
    this.state.rackRedrawAvailable = false;
    // Per-turn room state re-arms (currently a no-op seam; A5 uses it).
    this.services.fireTurnStarted(p);
    // Word Builder: draw the Tile Rack BEFORE the clock is armed and turnArmed is emitted.
    if (this.isPicker) this.generateRackForTurn(p);
    let armed = armedClockSeconds(this.baseClockSeconds, p.bay, this.effectiveMode);
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

  /**
   * Word Builder: generate this turn's Tile Rack into `state.rack`.
   *
   * The Wildcard is reframed here exactly as it was for the Offer. In Classic it lets one word per
   * era ignore Succession, checked at submit; in Word Builder it draws the whole rack free of the
   * required letter, so the charge is spent at generation. Only worth spending when a letter is
   * actually imposed — an era opener is already free, so burning the charge there would waste it —
   * and only consumed once the free draw actually produced a rack, so a failed generation never
   * eats it.
   */
  private generateRackForTurn(p: PlayerState): void {
    if (!this.wordPool) return;
    const shaping = this.rackShapingFor(p);
    // `offerIgnoresSuccession` is the RECEIPT for a charge already spent this turn, and the reason
    // availability cannot simply be re-derived: the Winnower redraw calls this again mid-turn, by
    // which point `baySuccessionExempt` is false because the guard was consumed on the first draw.
    // Re-deriving there charged the player 30% of their clock and handed back a rack strictly MORE
    // constrained than the free one they had just discarded, with the Wildcard already gone.
    const alreadyFree = this.offerIgnoresSuccession;
    const wildcardAvailable =
      alreadyFree ||
      (this.state.requiredLetter !== "" && baySuccessionExempt(this.bayEval(p, "", false)));

    const draw = (requiredLetter: string) =>
      generateRack({
        pool: this.wordPool!,
        index: this.offerIndex,
        requiredLetter,
        usedWords: this.state.usedWords,
        rackSize: this.state.settings.rackSize,
        shaping,
        bannedLetters: this.preferenceContextFor(p).bannedLetters,
        rng: this.offerRng,
      });

    let result = draw(wildcardAvailable ? "" : this.state.requiredLetter);
    if (wildcardAvailable && result.seedWord !== "") {
      if (!alreadyFree) this.services.wildcardGuard.tryConsume(p.id); // never charged twice
      this.offerIgnoresSuccession = true;
    }

    // No seed at all: every word starting with the required letter has been played. Redraw from the
    // whole pool and clear the letter to match, rather than arming the turn with the degenerate
    // three-tile fallback rack — which would be a guaranteed timeout.
    if (result.seedWord === "" && this.state.requiredLetter !== "") {
      log.warn(`builder: required letter "${this.state.requiredLetter}" is exhausted — freeing it`);
      result = draw("");
      this.state.requiredLetter = "";
      this.offerIgnoresSuccession = true;
    }

    this.state.rack = result.tiles;
    this.state.rackRedrawAvailable = this.canRedrawRack(p.id);
    if (result.seedWord === "") log.error("builder: rack generation produced no seed");
    // A guarantee the rack could not honour is skipped in silence by design — a Preference Card may
    // never shrink the draw — but silent to the PLAYER is not the same as invisible to us. It means
    // either a rack too small to spare a slot or a Sentinel ban that outranked the card.
    if (result.unmetGuarantees.length > 0) {
      log.warn(
        `builder: unmet rack guarantees [${result.unmetGuarantees.join(", ")}] ` +
          `at ${result.tiles.length} tiles`,
      );
    }
  }

  /**
   * Word Builder rack shaping derived from active Preference Cards in the player's bay.
   */
  private rackShapingFor(p: PlayerState): RackShaping {
    const prefCtx = this.preferenceContextFor(p);
    let minSeedLength: number | undefined;
    let highVowelRatio: boolean | undefined;
    let guaranteeRare: boolean | undefined;
    let excludeBannedLetters: boolean | undefined;
    let slotDelta = 0;

    for (const b of p.bay) {
      const pref = cardIdentity(b.id)?.preference;
      if (!pref) continue;
      if (pref.countDelta) slotDelta += pref.countDelta;
      if (pref.minSeedLength) minSeedLength = Math.max(minSeedLength ?? 0, pref.minSeedLength);
      if (pref.highVowelRatio) highVowelRatio = true;
      if (pref.guaranteeRare) guaranteeRare = true;
      if (pref.excludeBannedLetters && prefCtx.bannedLetters.length > 0) excludeBannedLetters = true;
    }

    return {
      minSeedLength,
      highVowelRatio,
      guaranteeRare,
      excludeBannedLetters,
      slotDelta,
    };
  }

  /** The letters that would tax `p` right now — Sentinel's definition of an unsafe word.
   *  Mirrors submitWord's own tax check: the era ban unless exempt, plus personal and hijack bans. */
  private preferenceContextFor(p: PlayerState): PreferenceContext {
    const letters = new Set<string>();
    if (this.state.bannedLetter && !this.isExempt(p)) letters.add(this.state.bannedLetter);
    for (const b of this.services.cardBan.bansFor(p.id)) letters.add(b);
    const hijack = this.services.hijackBan.peek(p.id);
    if (hijack) letters.add(hijack);
    return { bannedLetters: [...letters] };
  }

  private endTurn(fromSubmission = false): void {
    // A Picker no-show elimination, applied before the Survival count below reads it.
    if (this.pendingNoShowElimination) {
      const id = this.pendingNoShowElimination;
      this.pendingNoShowElimination = null;
      const q = this.state.players.find((x) => x.id === id);
      if (q) q.eliminated = true;
    }
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
      cardName: cardIdentity(b.cardId)?.name ?? "",
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

    // 3b. Word Builder verification, keyed on the ACTIVE SURFACE rather than unioning both. When a
    //     rack is up it is the only thing the player can see, so the Offer must not be consulted:
    //     accepting `inOffer` there let a tampered client commit hidden Offer words it was dealt no
    //     tiles for — typically the long, high-scoring ones.
    if (this.isPicker && this.state.rack.length > 0) {
      if (!canConstructWordFromTiles(word, this.state.rack)) return reject("not-constructible");
    }

    // 4. Succession — a held Wildcard exempts the owner once per era. The bypass
    //    is only recorded here; it's consumed once the word is fully accepted, so
    //    a duplicate/typo rejection below never burns the era's charge.
    //    In Picker the picker satisfies Succession, not the player, so the only case where a
    //    committed word can mismatch is a Wildcard Offer — whose charge was already spent at
    //    generation, making baySuccessionExempt false by then. `offerIgnoresSuccession` records
    //    that this turn's Offer was drawn free, so the check is waived for exactly this turn.
    let usedWildcard = false;
    if (s.requiredLetter && word[0] !== s.requiredLetter && !this.offerIgnoresSuccession) {
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
      mode: this.effectiveMode,
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      baseClockSeconds: this.baseClockSeconds,
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
    s.requiredLetter = this.nextRequiredLetter(last);

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

  /**
   * Word Builder: Winnower — redraw the whole Tile Rack, once per turn, for 30% of the ARMED clock.
   *
   * Priced off `clockTotal` rather than what is left, so the cost is the same whether you redraw
   * instantly or after agonising: it buys a fresh rack, not a fresh clock. The charge is a
   * TurnGuard reset by `fireTurnStarted`, so it re-arms for whoever is up rather than per era.
   *
   * Returns whether a redraw actually happened, so the caller can tell a spent charge from a
   * missing card without reading room state.
   */
  redrawRack(playerId: string): boolean {
    const s = this.state;
    if (!this.isPicker || s.phase !== "Round" || this.roundSettleRemaining > 0) return false;
    if (playerId !== this.current.id) return false;
    const p = this.current;
    const cost = p.bay.reduce(
      (max, b) => Math.max(max, cardIdentity(b.id)?.preference?.redraw?.clockCostFraction ?? 0),
      0,
    );
    if (cost <= 0) return false; // no Winnower in the bay
    if (!this.services.winnowerGuard.tryConsume(p.id)) return false; // already redrawn this turn

    // Charge first, so a redraw that then produces a thin rack still costs what it said it would.
    s.clockRemaining = Math.max(0, s.clockRemaining - cost * s.clockTotal);
    // The previous rack's buildable words are NOT marked used — they were never played, and burning
    // them would quietly shrink the pool every time anyone redrew.
    this.currentSelection = null;
    this.currentDraft = "";
    this.generateRackForTurn(p);
    this.events.emit("clockTick", s.clockRemaining);
    this.events.emit("turnArmed", {
      playerIndex: s.currentPlayerIndex,
      requiredLetter: s.requiredLetter,
      clockTotal: s.clockTotal,
    });
    return true;
  }

  /** Whether `playerId` could redraw right now — Winnower button's enabled state. */
  canRedrawRack(playerId: string): boolean {
    if (!this.isPicker || this.state.phase !== "Round") return false;
    if (playerId !== this.current.id) return false;
    const p = this.current;
    const hasWinnower = p.bay.some(
      (b) => (cardIdentity(b.id)?.preference?.redraw?.clockCostFraction ?? 0) > 0,
    );
    return hasWinnower && this.services.winnowerGuard.isAvailable(p.id);
  }

  /** Picker / Word Builder: record the current player's selected or staged word. */
  setSelection(playerId: string, word: string): void {
    if (this.state.phase !== "Round" || playerId !== this.current.id) return;
    const chosen = word.trim().toLowerCase();
    // An empty word is a CLEAR, not a no-op: <ac-word-builder>'s clearStaging and the network's
    // `clearStaging` intent both stream "" to mean "I unstaged everything". Without this branch
    // canConstructWordFromTiles refuses the empty target below and the stale selection survives
    // the rest of the turn — which in Survival is the difference between a no-show and not.
    if (!chosen) {
      this.currentSelection = null;
      return;
    }
    const inRack = this.state.rack.length > 0 && canConstructWordFromTiles(chosen, this.state.rack);
    if (!inRack) return;
    this.currentSelection = chosen;
  }

  /**
   * Picker / Word Builder: commit a selection or staged word.
   */
  commitSelection(playerId: string, word?: string): SubmitResult {
    const s = this.state;
    if (s.phase !== "Round" || this.roundSettleRemaining > 0 || playerId !== this.current.id) {
      return { accepted: false };
    }
    if (!this.isPicker) return { accepted: false };
    const chosen = (word ?? this.currentSelection ?? "").trim().toLowerCase();
    // Nothing selected yet: not an error, and deliberately eventless — a stray commit must not
    // make the authority broadcast.
    if (!chosen) return { accepted: false };
    if (!(s.rack.length > 0 && canConstructWordFromTiles(chosen, s.rack))) {
      this.events.emit("rejected", { playerId, reason: "not-constructible" });
      return { accepted: false, reason: "not-constructible" };
    }
    return this.submitWord(playerId, chosen);
  }

  /** Offer each of a player's resolved cards its once-per-era clock rescue (Prism);
   *  returns true if one fired (consumed its charge and refilled the clock). */
  private tryClockRescue(player: PlayerState): boolean {
    const ev = this.bayEval(player, "", false);
    return ev.resolved.some((c, i) => c?.rescueClock?.(ev.ctxFor(i)) ?? false);
  }

  private timeoutCurrent(): void {
    // Picker's clock means something different, so it gets its own path and Classic's stays
    // byte-identical below.
    if (this.isPicker) return this.pickerTimeoutCurrent();
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
      // Classic by construction — `timeoutCurrent` returns early on isPicker, so this path is
      // unreachable in Picker — but named rather than assumed, so it is not the odd one out.
      mode: this.effectiveMode,
      prevWordLength: this.prevWordLength,
      clockRemaining: s.clockRemaining,
      clockTotal: s.clockTotal,
      taxed: false,
      baseClockSeconds: this.baseClockSeconds,
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

  /**
   * Word Builder: a random word THIS turn's rack can actually build, for the no-show commit.
   *
   * Three things this has to get right, and the bare `subWordFinder` call it replaces got none of
   * them — it only ever ran once the Offer path was retired, which is what exposed all three:
   *
   *  1. `usedWords`. The candidate has to survive `submitWord`, which rejects an already-played
   *     word — and the rejection lands on a player who merely timed out, flashing "Already used"
   *     at them and resolving the turn as the dead "—" submission with the chain letter unmoved.
   *     The odds of drawing a played word rise with every word in the match.
   *  2. The WAIVED letter. On a Wildcard turn the rack is drawn free of `state.requiredLetter`
   *     while the letter itself stands, so filtering by it hunts for a letter the rack was
   *     deliberately built without. See `successionWaivedThisTurn`.
   *  3. A bounded scan — `NO_SHOW_CANDIDATE_CAP`. The cap alone would bias the pick: with a free
   *     letter `subWordFinder` walks `startLetters()` in order, so the first N hits are all "a"
   *     words and every free-letter no-show would commit one. The letters are therefore visited in
   *     a RANDOM order and the first that yields anything wins — the same shape as the bot's own
   *     candidate gathering (`botCandidateTiers`, bots.ts).
   *  4. A bounded COST — `NO_SHOW_SCAN_BUDGET`. `maxResults` bounds what the scan returns, which
   *     is no bound at all on the case that actually hurts: a rack whose words are nearly all
   *     played walks every letter to the end and finds nothing. subWordFinder now skips buckets no
   *     tile can start, which is most of them, but the budget is what makes the ceiling a number
   *     rather than a hope.
   */
  private randomBuildableWord(): string | null {
    const s = this.state;
    if (s.rack.length === 0 || !this.wordPool) return null;
    const letters =
      this.offerIgnoresSuccession || s.requiredLetter === ""
        ? shuffle(this.offerIndex.startLetters(), this.rng)
        : [s.requiredLetter];
    // One budget threaded across every letter, so the random visit order still decides WHICH
    // letters get looked at while the total work stays bounded. subWordFinder writes the budget
    // back at its single exit, so the remainder carries correctly from one letter to the next.
    const budget: ScanBudget = { remaining: NO_SHOW_SCAN_BUDGET };
    for (const letter of letters) {
      const candidates = subWordFinder(s.rack, this.wordPool, this.offerIndex, letter, {
        usedWords: s.usedWords,
        maxResults: NO_SHOW_CANDIDATE_CAP,
        budget,
      });
      if (candidates.length > 0) return candidates[Math.floor(this.rng() * candidates.length)];
      if (budget.remaining <= 0) return null;
    }
    return null;
  }

  /**
   * Picker: the shot clock expired. Commit the current selection; with none selected, commit one
   * at random so the chain continues.
   */
  private pickerTimeoutCurrent(): void {
    const s = this.state;
    const p = this.current;

    // No tryClockRescue here, deliberately. Classic offers a held Prism a refill INSTEAD of the
    // penalty; Picker has no penalty to be rescued from, and refilling a turn that always resolves
    // would let a Prism owner stall the table. The Prism's banned-letter half still fires below,
    // via submitWord — which is its primary mode in Picker anyway.

    // Try what the player actually staged, exactly as Classic's timeoutCurrent tries the draft.
    // Showing up means producing a word the engine ACCEPTS — NOT merely holding a non-null
    // selection: the Word Builder streams one on every tile tap (ac-word-builder.streamStaging),
    // so a two-tile fragment that spells nothing would otherwise read as a real pick and spare a
    // Survival player who plainly timed out. Anything short of an accepted word falls through to
    // the no-show below.
    const staged = this.currentSelection;
    if (staged) {
      const res = this.submitWord(p.id, staged);
      if (res.accepted) return; // a real commit, not a timeout — submitWord already ran endTurn
      // The commit tripped the Prism on a banned letter: word rejected, clock refilled, turn
      // continues — "you picked the poisoned one, here is your Offer back". endTurn was never
      // reached, so the armed no-show is discarded by the next armCurrentTurn.
      if (res.reason === "prism-saved") return;
      // Rejected (a fragment, a used word, a Succession break) — an ordinary path, not an error.
      // The turn resolves as a no-show below, exactly as if nothing had been staged at all.
    }

    // Past here the player produced nothing committable: this IS a no-show. Armed BEFORE the
    // random pick, which routes through submitWord → endTurn and applies the deferred flag there.
    if (s.settings.survivalMode) this.pendingNoShowElimination = p.id;

    // Commit something on their behalf so the chain continues rather than dying on a blank turn.
    // RACK FIRST, mirroring the bot's own precedence in LocalController: the word has to be one the
    // player could actually have built from the tiles in front of them. Committing from the Offer
    // instead would credit them a word they never saw and could not have reached, and the tutorial
    // promises "a word is built for you".
    const chosen = this.randomBuildableWord();

    if (chosen !== null) {
      const res = this.submitWord(p.id, chosen);
      if (res.reason === "prism-saved") return;
      if (res.accepted) return; // submitWord already ran endTurn
      // Should be unreachable: `randomBuildableWord` satisfies Succession, uniqueness and the
      // dictionary by construction, and a TAXED word is still accepted (scoring 0), not rejected.
      log.error(`picker: commit unexpectedly rejected (${res.reason ?? "no reason"})`);
    }

    // Nothing committable — a rack that builds nothing, or the unreachable rejection above.
    // Resolve the turn anyway so it cannot hang. Score and penalty are both 0; the required
    // letter is unchanged.
    const submission: Submission = {
      playerId: p.id,
      displayName: p.name,
      accentIndex: p.accentIndex,
      era: s.era,
      word: "—",
      score: 0,
      taxed: false,
      taxBounty: 0,
      // An empty breakdown, built directly rather than through scoreTimeout — which is never
      // called on this path, since calling it is exactly what would apply a penalty.
      breakdown: { word: "—", seed: 0, steps: [], finalBeforeTax: 0, taxed: false, finalScore: 0 },
      timedOut: true,
    };
    this.events.emit("timeout", { playerId: p.id, penalty: 0 });
    this.events.emit("submission", { submission, bounties: [] });
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
    // Drop the rack so it isn't still in the snapshot during the intermission. armCurrentTurn
    // clears it too, but that only runs on the way back into a Round — and the settle window
    // between deliberately keeps it, so the tiles stay on screen while the score replay finishes.
    this.state.rack = [];
    this.state.rackRedrawAvailable = false;
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
    // Nobody holds a card, so there is nothing to arrange or discard: skip the sub-phase
    // instead of holding everyone on an empty bay for intermissionCardSelectSeconds. Reached
    // when modifiersDealtPerEra is 0, and when the host's enabled rarity tiers are exhausted
    // and dealCards had an empty pool (see dealPoolCapacity). Decided from replicated state
    // (players[].bay) and consuming no rng, so host and guests agree and dealing can't desync.
    if (this.state.players.every((p) => p.bay.length === 0)) {
      this.completeOptimize();
      return;
    }
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
      if (p.bay.length > p.slots) p.bay = this.trimToCapacity(p.bay, p.slots);
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
    // Host-configurable per-tier weights, resolved once: pure, and the pool filter below
    // must not vary mid-batch. Read from state.settings (the replicated field) — never
    // from module state or loadSettings(), which are host-local and would diverge.
    const tierWeight = rarityDealWeights(this.state.settings);
    // The mode's dealable ids, resolved once for the same reason. Keyed on the REPLICATED
    // `settings.gameMode`, deliberately NOT on `this.isPicker` — isPicker is false when no wordPool
    // was injected, so a host missing that dependency would deal from a different pool than its
    // guests' mirrors expect. The deal must depend only on replicated state.
    const modeIds = dealableCardIds(this.state.settings.gameMode);
    for (let i = 0; i < count; i++) {
      // A card is dealable to this player only while they hold fewer than its
      // maxInstances (default 3), and only while its rarity tier carries weight — a
      // tier the host zeroed leaves the pool outright rather than being merely
      // unlikely, so "weight 0" reliably means "never dealt" (it also can't sneak in
      // via the float-drift fallback below). Recompute each draw so a cap reached
      // mid-batch (e.g. a card dealt twice this era) drops it from later draws too.
      // An empty pool stops dealing early: every card capped for this player, or every
      // tier zeroed (the host's "deal nothing" configuration).
      const pool = modeIds.filter((id) => {
        const card = cardIdentity(id);
        if (!card || tierWeight[card.rarity] <= 0) return false;
        const max = card.maxInstances ?? DEFAULT_MAX_INSTANCES;
        const owned = player.bay.filter((b) => b.id === id).length;
        return owned < max;
      });
      if (pool.length === 0) break;
      // Weighted pick: rarer cards carry a smaller deal weight, so by default (10/5/2/1)
      // a Legendary surfaces ~10× less often than a Common. Exactly ONE rng() call per
      // card, so the deal is a pure function of the seed and the draw count: the authority
      // deals once server-side and clients only mirror the result, so this is what keeps a
      // replayed or resumed match reproducing the same bays. Every pooled card has
      // weight >= 1, so totalWeight > 0 here and the last-slot fallback
      // covers only floating-point drift, where the accumulated weights never quite
      // drop `r` below zero.
      const weights = pool.map((id) => tierWeight[cardIdentity(id)!.rarity]);
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      let r = this.rng() * totalWeight;
      let id = pool[pool.length - 1];
      for (let k = 0; k < pool.length; k++) {
        r -= weights[k];
        if (r < 0) {
          id = pool[k];
          break;
        }
      }
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
    const engine: BayCard[] = [];
    for (const uid of engineUids) {
      const b = take(uid, false);
      if (b) engine.push(b);
    }
    // Preference Cards auto-bubble to the leftmost engine slots. A player cannot place one in the
    // middle of their scoring chain — see bubblePreferences for why (a hand-placed one would
    // silently swallow a Magnifying Glass). Applied to the ENGINE only: order in the discard bin is
    // meaningless, and reordering it would just make the bin jump around under the player's cursor.
    const next: BayCard[] = bubblePreferences(engine, (b) => isInertPreference(cardIdentity(b.id)));
    for (const uid of discardUids) {
      const b = take(uid, true);
      if (b) next.push(b);
    }
    // Defensive: keep any owned card the caller omitted (never silently lost).
    for (const b of p.bay) if (!seen.has(b.uid!)) next.push({ ...b, discarded: false });
    p.bay = next;
  }

  /**
   * Trim a bay down to capacity, keeping a WORKING ENGINE.
   *
   * Only reachable on the AFK path — a player who actually optimizes never exceeds capacity. The
   * old rule was "keep the first `slots`", which was fine until Preference Cards started bubbling
   * to the front: an idle player would then have kept nothing but shape filters and scored almost
   * nothing, having never touched the screen. So scoring cards are kept first, and any slots left
   * over go to Preference Cards, which are re-bubbled to the left of the result.
   */
  private trimToCapacity(bay: readonly BayCard[], slots: number): BayCard[] {
    const isPref = (b: BayCard): boolean => isInertPreference(cardIdentity(b.id));
    const scoring = bay.filter((b) => !isPref(b)).slice(0, slots);
    const preference = bay.filter(isPref).slice(0, Math.max(0, slots - scoring.length));
    return [...preference, ...scoring];
  }

  /** Testing Bay: re-arm the current turn in place, so a bay edit is reflected in a freshly drawn
   *  Offer. Not reachable in a real match — the Offer is drawn once when a turn arms, and redrawing
   *  it mid-turn is otherwise Winnower's paid-for privilege. */
  benchRearmTurn(): void {
    if (this.state.phase !== "Round") return;
    this.armCurrentTurn();
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
    // Bubble here too: the sandbox bypasses setPlayerBay entirely, and a Testing Bay that let you
    // place a Preference Card mid-chain would be testing an arrangement the real game forbids.
    p.bay = bubblePreferences(
      orderedIds.filter((id) => cardIdentity(id)).map((id) => ({ id, uid: this.nextBayUid() })),
      (b) => isInertPreference(cardIdentity(b.id)),
    );
    this.armPlayerForEra(p);
  }

  /** Advance to the next player without scoring (bench "skip turn"). */
  benchSkipTurn(): void {
    if (this.state.phase === "Round") this.endTurn();
  }

  // ── End ────────────────────────────────────────────────────────────────────
  private gameOver(): void {
    this.state.endedAt = this.now();
    this.state.rack = [];
    this.state.rackRedrawAvailable = false;
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
