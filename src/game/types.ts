/*
 * Pure game-logic types for Alpha Chain. No Phaser imports here — this module
 * (and everything else under src/game) must stay engine-agnostic so it can be
 * unit-tested and, later, run host-authoritative over the KnockBox network.
 */

/** Which letters may be chosen as the era's banned letter. */
export type BanMode = "All" | "VowelsOnly" | "ConsonantsOnly";

export type CardFamily = "letter" | "clock" | "economy" | "utility" | "neutral";

/** How a card folds into the running score. */
export type CardOp = "additive" | "multiplicative" | "fx";

/** Host-configurable match settings (ported from AlphaChainSettings.cs). */
export interface AlphaChainSettings {
  banMode: BanMode;
  shotClockSeconds: number; // 5–60
  intermissionCardSelectSeconds: number; // 10–180
  sniperBanSeconds: number; // 5–120
  preRoundCountdownSeconds: number; // 3–15
  eraInterval: number; // rounds per era
  eraCount: number; // eras per match
  survivalMode: boolean;
  modifiersDealtPerEra: number;
  engineAnimationSeconds: number; // score-replay duration
  botCount: number; // 1–5 (local single-player only)
  botDifficulty: BotDifficulty;
}

export type BotDifficulty = "easy" | "medium" | "hard";

export type GamePhase =
  | "Setup"
  | "Countdown"
  | "Round"
  | "Intermission"
  | "GameOver";

/** A single card occupying a slot in a player's Engine Bay. */
export interface BayCard {
  /** Stable ModifierId (matches the SVG symbol id in cards.svg). */
  id: string;
  /** Set true the era a card was dealt, for the "NEW" highlight. */
  isNew?: boolean;
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

export interface Submission {
  playerId: string;
  displayName: string;
  accentIndex: number;
  word: string;
  score: number;
  taxed: boolean;
  taxBounty: number;
  breakdown: ScoreBreakdown;
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
  /** Words used this whole match (lowercased), forbidden to repeat. */
  usedWords: Set<string>;
  history: Submission[];
  /** Seconds remaining on the active shot clock. */
  clockRemaining: number;
  /** Total seconds the active clock was armed with (for ring fraction). */
  clockTotal: number;
  settings: AlphaChainSettings;
  winnerId: string | null;
}

/** Result of attempting to validate + score a word. */
export interface SubmitResult {
  accepted: boolean;
  reason?:
    | "not-a-word"
    | "already-used"
    | "wrong-start-letter"
    | "too-short";
  submission?: Submission;
}
