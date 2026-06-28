/*
 * Pure game-logic types for Alpha Chain. No Phaser imports here — this module
 * (and everything else under src/game) must stay engine-agnostic so it can be
 * unit-tested and, later, run host-authoritative over the KnockBox network.
 */

/** Which letters may be chosen as the era's banned letter. */
export type BanMode = "All" | "VowelsOnly" | "ConsonantsOnly";

/** Whether a letter banned in a past era may be banned again.
 *  - AllowRepeat:    any legal letter, every era.
 *  - NoConsecutive:  the immediately-previous era's banned letter is off-limits.
 *  - NoRepeat:       a letter can never be banned twice (until the pool is exhausted). */
export type BanRepeatRule = "AllowRepeat" | "NoConsecutive" | "NoRepeat";

/** Single source of truth for a card's family. Values are byte-identical to the
 *  former string-literal union (they tint the family accent in the UI). */
export const CardFamily = {
  Letter: "letter",
  Clock: "clock",
  Economy: "economy",
  Utility: "utility",
  Neutral: "neutral",
} as const;
export type CardFamily = (typeof CardFamily)[keyof typeof CardFamily];

/** How a card folds into the running score. */
export const CardOp = {
  Additive: "additive",
  Multiplicative: "multiplicative",
  Fx: "fx",
} as const;
export type CardOp = (typeof CardOp)[keyof typeof CardOp];

/**
 * Single source of truth for the modifier-card ids. The string VALUES are
 * load-bearing and must stay byte-identical: they match the SVG symbol ids in
 * cards.svg (`<use href="#${id}">`) and travel over the wire as BayCard.id.
 * Reference cards by `CardId.X` instead of a bare literal so typos are caught
 * at compile time. Boundary types (BayCard.id, ScoreStep.cardId, getCard's
 * param) intentionally stay `string` so deserialized / sandbox ids flow freely.
 */
export const CardId = {
  TheAnchor: "TheAnchor",
  Vanilla: "Vanilla",
  ConsonantCrunch: "ConsonantCrunch",
  VocalVowels: "VocalVowels",
  BrickLayer: "BrickLayer",
  TheBlueprint: "TheBlueprint",
  LetterHoarder: "LetterHoarder",
  HighRoller: "HighRoller",
  BoosterPack: "BoosterPack",
  Scavenger: "Scavenger",
  VowelSurge: "VowelSurge",
  TheArchitect: "TheArchitect",
  Sesquipedalian: "Sesquipedalian",
  GutturalRoar: "GutturalRoar",
  PerfectLink: "PerfectLink",
  TryHard: "TryHard",
  DoubleDown: "DoubleDown",
  TheVault: "TheVault",
  Redline: "Redline",
  PanicButton: "PanicButton",
  SlowBurn: "SlowBurn",
  Speedracer: "Speedracer",
  Blindfold: "Blindfold",
  HeatSink: "HeatSink",
  Catalyst: "Catalyst",
  Forgery: "Forgery",
  MagnifyingGlass: "MagnifyingGlass",
  Wildcard: "Wildcard",
  Prism: "Prism",
  IrsAgent: "IrsAgent",
  TaxWriteOff: "TaxWriteOff",
  RouletteWheel: "RouletteWheel",
  TollBooth: "TollBooth",
  TaxCollector: "TaxCollector",
  ChronoSyphon: "ChronoSyphon",
  BaitAndSwitch: "BaitAndSwitch",
  // ── Rebalance additions (more viable archetypes vs. the speed build) ──
  TheLexicon: "TheLexicon",
  Stonemason: "Stonemason",
  LoanShark: "LoanShark",
  Numismatist: "Numismatist",
  TheSniper: "TheSniper",
  Insurance: "Insurance",
  TheFlywheel: "TheFlywheel",
  // ── New archetype cards (quality / consistency / engine-width) ──
  Tilesmith: "Tilesmith",
  Crescendo: "Crescendo",
  Bookends: "Bookends",
  Dividend: "Dividend",
} as const;
export type CardId = (typeof CardId)[keyof typeof CardId];

/** Host-configurable match settings (ported from AlphaChainSettings.cs). */
export interface AlphaChainSettings {
  banMode: BanMode;
  /** Whether a previously-banned letter may be chosen again (see BanRepeatRule). */
  banRepeatRule: BanRepeatRule;
  /** Deal modifier cards (and run an Optimize sub-phase) before era 1, instead of
   *  starting with empty bays. */
  dealEngineCardsFirstEra: boolean;
  shotClockSeconds: number; // 5–60
  intermissionCardSelectSeconds: number; // 10–180
  sniperBanSeconds: number; // 5–120
  preRoundCountdownSeconds: number; // 3–15
  eraInterval: number; // rounds per era
  eraCount: number; // eras per match
  survivalMode: boolean;
  modifiersDealtPerEra: number;
  engineAnimationSeconds: number; // score-replay duration
  /** Show the scripted Shiritori/Engine/Tax tutorials at their cue points. */
  enableTutorials: boolean;
  /** Host joins as a player (true) vs. a shared display / spectator (false). */
  hostPlays: boolean;
  botCount: number; // 1–5 (local single-player only)
  botDifficulty: BotDifficulty;
}

/** Sub-phase of the Intermission (mirrors the Blazor IntermissionSubPhase). */
export type IntermissionPhase = "deal" | "optimize" | "sniperBan" | "tutorial" | null;

/** A scripted tutorial overlay shown once at its cue point. Pages are grouped at
 *  three cue points: pre-game (shiritori → timeout), the era-1 optimize cue
 *  (engine → cards), and the era-1 ban cue (tax/sniper). */
export type TutorialKind = "shiritori" | "timeout" | "engine" | "cards" | "tax" | "sniper";

export type BotDifficulty = "easy" | "medium" | "hard";

export type GamePhase = "Setup" | "Tutorial" | "Countdown" | "Round" | "Intermission" | "GameOver";

/** A single card occupying a slot in a player's Engine Bay. */
export interface BayCard {
  /** Stable ModifierId (matches the SVG symbol id in cards.svg). NOT unique: a
   *  bay may hold several copies of the same card (duplicates are dealt). */
  id: string;
  /** Per-instance handle that IS unique within a bay, so the optimize UI and
   *  setPlayerBay can tell duplicate cards apart. Assigned by the host when a
   *  card enters a bay (deal / bench) and carried over the wire; absent only on
   *  test-constructed bays that never reach the reorder flow. */
  uid?: string;
  /** Set true the era a card was dealt, for the "NEW" highlight. */
  isNew?: boolean;
  /** True while the card sits in the optimize discard bin; the card is removed
   *  when the optimize sub-phase completes. Absent outside optimize. */
  discarded?: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  isBot: boolean;
  accentIndex: number;
  score: number;
  eliminated: boolean;
  /** Engine Bay, evaluated strictly left → right. */
  bay: BayCard[];
  /** Engine Bay slot capacity (starts at 3, +1 per intermission). */
  slots: number;
  /** True once the player has locked in their engine during the optimize sub-phase.
   *  Optimize completes when every active human player is locked in (or the timer
   *  elapses). Reset on entry to optimize and cleared when it completes. */
  lockedIn?: boolean;
  /** Personal banned letters in force this era (Toll Booth / Roulette Wheel), each
   *  tagged with its source card. Host-stamped at era arm so it rides the snapshot
   *  to guests; the host itself reads the live CardBanService. */
  personalBans?: { letter: string; cardName: string }[];
}

/** Compare two players for a high→low leaderboard. Explicit comparison rather than
 *  `b.score - a.score` so a stray NaN score can't scramble the order. */
export function byScoreDesc(a: PlayerState, b: PlayerState): number {
  return a.score > b.score ? -1 : a.score < b.score ? 1 : 0;
}

/** One entry in a per-card score trace. */
export interface ScoreStep {
  cardId: string;
  name: string;
  family: CardFamily;
  triggered: boolean;
  /** "+12", "×1.5", "FX", or "—". */
  valueText: string;
  runningScore: number;
}

/** Full breakdown the UI replays card-by-card. */
export interface ScoreBreakdown {
  word: string;
  seed: number; // word length
  steps: ScoreStep[];
  finalBeforeTax: number;
  taxed: boolean;
  finalScore: number;
}

/** A single automated-effect notice (for the "engine effect" overlay/replay). */
export interface EngineEffectNotice {
  /** Card / effect name that fired, e.g. "Flak Cannon". */
  source: string;
  /** Player the effect ultimately landed on. */
  targetId: string;
  /** Human-readable summary, e.g. "−2s shot clock". */
  text: string;
  /** Signed point delta for score-affecting effects (+gain / −loss); omitted for
   *  non-score effects (time shaves, letter bans). Drives the leaderboard pop. */
  amount?: number;
  /** True when a Titanium Mirror reflected the hit back at its caster. */
  reflected?: boolean;
}

export interface Submission {
  playerId: string;
  displayName: string;
  accentIndex: number;
  /** The era (1-based) this word was played in, for the sniper-ban "words this era"
   *  list. Era only advances after the ban, so current-era words share `state.era`. */
  era: number;
  word: string;
  score: number;
  taxed: boolean;
  taxBounty: number;
  breakdown: ScoreBreakdown;
  /** Automated effects that fired as this word resolved (UI overlay). */
  effects?: EngineEffectNotice[];
  /** Ids of players who siphoned points from this submission (tax/toll/chrono). */
  siphonedBy?: string[];
  /** True when this "submission" is a shot-clock timeout: there is no real word,
   *  `breakdown` is the penalty walk, and `score` is the (negative) net delta. The
   *  theater shows a "TIMED OUT" heading and ramps the readout down. */
  timedOut?: boolean;
}

/**
 * The resolved facts of an accepted word, passed to lifecycle hooks
 * (onWordAccepted / onOpponentWordResolved / onTurnEnded). Ports the C#
 * WordResolution thread between scoring and the reactive economy.
 */
export interface WordResolution {
  submitterId: string;
  word: string;
  taxed: boolean;
  /** Pre-tax score — the amount a Tax Collector siphons half of. */
  wouldBeScore: number;
  /** Points actually credited to the submitter (0 when taxed, unless salvaged). */
  earnedScore: number;
  /** The banned/personal letter that taxed the word, or null. */
  offendingLetter: string | null;
  /** True when an IRS Agent suppressed opponents' tax-collector bounties. */
  siphonSuppressed: boolean;
  /** Whole seconds left on the submitter's shot clock (Chrono Syphon). */
  remainingSeconds: number;
}

/** The live, observable state the presentation layer renders from. */
export interface MatchState {
  phase: GamePhase;
  era: number; // 1-based
  round: number; // 1-based, within the whole match
  roundInEra: number; // 1-based, resets each era
  players: PlayerState[];
  currentPlayerIndex: number;
  /** Required first letter for the next word ("" = free choice). */
  requiredLetter: string;
  bannedLetter: string; // "" before first sniper ban
  /** Every letter banned so far, in era order. Drives the ban-repeat rule
   *  (no-consecutive / no-repeat) and is cleared when the legal pool is exhausted. */
  bannedLetterHistory: string[];
  /** Words used this whole match (lowercased), forbidden to repeat. */
  usedWords: Set<string>;
  history: Submission[];
  /** Seconds remaining on the active shot clock. */
  clockRemaining: number;
  /** Total seconds the active clock was armed with (for ring fraction). */
  clockTotal: number;
  /** Current intermission sub-phase (null outside an intermission). */
  intermissionPhase: IntermissionPhase;
  /** Tutorial script on screen, for the "Tutorial" phase and the "tutorial"
   *  intermission sub-phase (null when no tutorial is showing). */
  currentTutorial: TutorialKind | null;
  /** Host-authoritative dwell remaining for the Tutorial phase / intermission
   *  sub-phases (optimize, tutorial, sniperBan). Guests interpolate for display. */
  subTimerRemaining: number;
  /** Total seconds the active sub-timer was armed with (for the progress ring). */
  subTimerTotal: number;
  /** Tutorials already shown this match (so each fires once). */
  shownTutorials: TutorialKind[];
  /** Ids of players who've pressed "I've Read This" on the current tutorial page.
   *  Reset each time a new page is shown; the page auto-advances once every active
   *  human is in this set. */
  tutorialReady: string[];
  settings: AlphaChainSettings;
  winnerId: string | null;
  /** Epoch ms the match started (first `start()`); undefined before then. */
  startedAt?: number;
  /** Epoch ms the match ended (GameOver); undefined until then. */
  endedAt?: number;
}

/** Result of attempting to validate + score a word. */
export interface SubmitResult {
  accepted: boolean;
  reason?: "not-a-word" | "already-used" | "wrong-start-letter" | "too-short" | "prism-saved";
  submission?: Submission;
}
