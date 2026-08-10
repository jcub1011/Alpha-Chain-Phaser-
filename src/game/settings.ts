import { createLogger } from "../log";
import { CardRarity, DictionaryTier, GameMode } from "./types";
import type {
  AlphaChainSettings,
  BanMode,
  BanRepeatRule,
  BotDifficulty,
  RarityWeightKey,
} from "./types";

const log = createLogger("settings");

/** Engine bay slots a player starts with (ported from AlphaChainGameState.cs); also the
 *  default for the configurable `modifierSlotsStart` setting. */
export const MODIFIER_SLOTS_START = 3;

/** Baseline relative deal weight per rarity — the defaults for the host-configurable
 *  `rarityWeight*` settings. Higher = offered more often; a specific Common is 10× as
 *  likely per draw as a specific Legendary. Lives here rather than beside the card model
 *  because `cards/card.ts` imports from this module, so the reverse import would cycle. */
export const DEFAULT_RARITY_DEAL_WEIGHT: Record<CardRarity, number> = {
  [CardRarity.Common]: 10,
  [CardRarity.Uncommon]: 5,
  [CardRarity.Rare]: 2,
  [CardRarity.Legendary]: 1,
};

/** Upper bound on a single tier's deal weight. Shared by the persistence validator and
 *  both lobbies' steppers so the editable range and the accepted range can't drift. */
export const MAX_RARITY_DEAL_WEIGHT = 20;

/** Which setting carries each tier's deal weight — the ONLY place the tier↔key relation is
 *  written. `rarityDealWeights` and the lobbies' stepper rows both derive from it, so the
 *  pairing can't be transposed in one and not the other. Keyed by CardRarity, so a new tier
 *  is a compile error here (and, transitively, a lobby row that can't be forgotten). */
export const RARITY_WEIGHT_KEYS: Record<CardRarity, RarityWeightKey> = {
  [CardRarity.Common]: "rarityWeightCommon",
  [CardRarity.Uncommon]: "rarityWeightUncommon",
  [CardRarity.Rare]: "rarityWeightRare",
  [CardRarity.Legendary]: "rarityWeightLegendary",
};

/** Defaults ported from AlphaChainSettings.cs, plus single-player bot options. */
export const DEFAULT_SETTINGS: AlphaChainSettings = {
  // Picker is the default mode, not an alternate — it is what a new player meets first.
  gameMode: GameMode.Picker,
  offerCount: 5,
  offerDictionary: DictionaryTier.Reduced,
  // A genuine playtest question, not a design decision: too generous and turns drag, which is
  // fatal in a party game; too tight and Picker becomes a reading-speed race. 25s is the starting
  // guess, deliberately a lone tunable constant.
  pickerShotClockSeconds: 25,
  highlightBannedLetters: false,
  banMode: "All",
  banRepeatRule: "NoConsecutive",
  dealEngineCardsFirstEra: false,
  shotClockSeconds: 20,
  intermissionCardSelectSeconds: 45,
  sniperBanSeconds: 15,
  preRoundCountdownSeconds: 4,
  eraInterval: 4,
  eraCount: 4,
  survivalMode: false,
  modifiersDealtPerEra: 3,
  rarityWeightCommon: DEFAULT_RARITY_DEAL_WEIGHT[CardRarity.Common],
  rarityWeightUncommon: DEFAULT_RARITY_DEAL_WEIGHT[CardRarity.Uncommon],
  rarityWeightRare: DEFAULT_RARITY_DEAL_WEIGHT[CardRarity.Rare],
  rarityWeightLegendary: DEFAULT_RARITY_DEAL_WEIGHT[CardRarity.Legendary],
  modifierSlotsStart: MODIFIER_SLOTS_START,
  slotIncreaseEveryNEras: 1,
  slotIncreaseAmount: 1,
  modifierSlotsMax: 12,
  engineAnimationSeconds: 1.0,
  enableTutorials: true,
  hostPlays: true,
  botCount: 2,
  botDifficulty: "medium",
};

/** localStorage key under which the last-used settings are persisted. */
const STORAGE_KEY = "alphachain.settings";

/** Bump when a setting's valid range/enum changes so stale persisted blobs (which
 *  may now hold out-of-range values) are discarded rather than silently loaded. */
const SETTINGS_VERSION = 4;

/**
 * Load persisted settings, merged over defaults with per-field validation.
 * The persisted blob is discarded wholesale if its schema `version` doesn't match.
 * Otherwise each key is accepted only if it passes its validator (enum membership,
 * finite-and-in-range numbers, correct boolean type) — anything corrupt, edited, or
 * legacy keeps the default. Missing keys fall back to defaults (forward-compatible
 * when new settings are added). Any parse error or absent localStorage yields a
 * fresh copy of the defaults.
 */
export function loadSettings(): AlphaChainSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw) as Record<string, unknown>;
    if (stored.version !== SETTINGS_VERSION) {
      log.warn(`settings schema mismatch (stored=${String(stored.version)}); using defaults`);
      return { ...DEFAULT_SETTINGS };
    }
    log.debug("settings loaded from localStorage");
    return sanitizeSettings(stored);
  } catch (err) {
    log.warn(`settings load failed; using defaults: ${String(err)}`);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * A complete, in-range settings object from an untrusted blob: every key is taken from `raw`
 * only if it passes its validator, and otherwise keeps the default. Missing keys therefore
 * fall back rather than arriving as `undefined` — which matters because `undefined` survives
 * arithmetic and comparisons silently (`undefined <= 0` is false, `x + undefined` is NaN).
 *
 * Used for BOTH untrusted sources: the persisted localStorage blob (via loadSettings) and the
 * settings a client sends over the wire — the owner's startMatch / setSettings intents, which
 * may predate a setting this build expects. The server authority validates those before
 * adopting them, since they become the running match's rules (see src/server/authority.ts).
 *
 * Note it REJECTS an out-of-range value back to the default rather than clamping it, so a
 * caller can't smuggle an extreme through by relying on a clamp.
 */
export function sanitizeSettings(raw: unknown): AlphaChainSettings {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AlphaChainSettings)[]) {
    if (SETTINGS_VALIDATORS[key](stored[key])) (result[key] as unknown) = stored[key];
  }
  return result;
}

/** Persist settings (best-effort — swallows private-mode / quota errors). */
export function saveSettings(settings: AlphaChainSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...settings }));
    log.debug("settings saved");
  } catch (err) {
    // Persistence is best-effort; log and ignore storage failures.
    log.warn(`settings save failed (private mode / quota?): ${String(err)}`);
  }
}

/** Engine constants (ported from AlphaChainGameState.cs). */
export const MIN_SHOT_CLOCK_SECONDS = 3;
export const MAX_WORD_SCORE = 10000;

/** Flat points a player loses when their shot clock expires, before any per-card
 *  `timeoutFold` reactions (glass-cannon drains, Insurance's refund) fold in. */
export const BASE_TIMEOUT_PENALTY = 10;

/** Host-side leeway after the shot clock hits 0 before a turn times out, so a
 *  buzzer-time submit has time to traverse the network. Networked host only. */
export const SUBMIT_GRACE_SECONDS = 1;

export const VOWELS = new Set(["a", "e", "i", "o", "u"]);
export const isVowel = (c: string): boolean => VOWELS.has(c.toLowerCase());

const BAN_MODES: readonly BanMode[] = ["All", "VowelsOnly", "ConsonantsOnly"];
const BAN_REPEAT_RULES: readonly BanRepeatRule[] = ["AllowRepeat", "NoConsecutive", "NoRepeat"];
const BOT_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "medium", "hard"];
const GAME_MODES: readonly GameMode[] = Object.values(GameMode);
const DICTIONARY_TIERS: readonly DictionaryTier[] = Object.values(DictionaryTier);

/** Offer size bounds. The upper bound is a layout guarantee, not a taste call: GDD §2.1 requires
 *  every Offer Card be visible without scrolling, and past 8 that stops holding on a phone. */
export const MIN_OFFER_COUNT = 3;
export const MAX_OFFER_COUNT = 8;

/** Upper bound for `eraCount` / `eraInterval`, shared by the persistence validators and both
 *  lobbies' steppers so the editable range and the accepted range cannot drift apart. */
export const MAX_ERA_STEPPER = 50;

/** The match's base shot clock for the active mode.
 *
 *  MUST be used everywhere the clock is read for MATHS rather than display. `baseClockSeconds`
 *  feeds every clock-scaling card's fraction (Panic Button, Speedracer, The Vault, Redline,
 *  Chrono Syphon), so a site that keeps reading `shotClockSeconds` while Picker arms
 *  `pickerShotClockSeconds` mis-scores silently instead of failing. */
export function baseShotClockSeconds(s: AlphaChainSettings): number {
  return s.gameMode === GameMode.Picker ? s.pickerShotClockSeconds : s.shotClockSeconds;
}

/** A finite number within [min, max]. Rejects NaN/±Infinity (which are `typeof
 *  "number"`) and out-of-range values that the lobby's step-clamp never sees on load. */
const inRange =
  (min: number, max: number) =>
  (v: unknown): boolean =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isBool = (v: unknown): boolean => typeof v === "boolean";

/** Per-field validator for persisted settings. Ranges mirror the lobby limits; a
 *  value that fails keeps the default (see loadSettings). */
const SETTINGS_VALIDATORS: { [K in keyof AlphaChainSettings]: (v: unknown) => boolean } = {
  gameMode: (v) => GAME_MODES.includes(v as GameMode),
  offerCount: inRange(MIN_OFFER_COUNT, MAX_OFFER_COUNT),
  offerDictionary: (v) => DICTIONARY_TIERS.includes(v as DictionaryTier),
  pickerShotClockSeconds: inRange(5, 60),
  highlightBannedLetters: isBool,
  banMode: (v) => BAN_MODES.includes(v as BanMode),
  banRepeatRule: (v) => BAN_REPEAT_RULES.includes(v as BanRepeatRule),
  dealEngineCardsFirstEra: isBool,
  botDifficulty: (v) => BOT_DIFFICULTIES.includes(v as BotDifficulty),
  shotClockSeconds: inRange(MIN_SHOT_CLOCK_SECONDS, 120),
  intermissionCardSelectSeconds: inRange(5, 180),
  sniperBanSeconds: inRange(5, 120),
  preRoundCountdownSeconds: inRange(0, 30),
  // 50, matching both lobbies' steppers. These read 1-20 until now, which silently broke every
  // long match: a host who set 30 eras had it saved, reset to the default on the next reload, and
  // sanitized away server-side — with no warning anywhere, because rejection is by design silent.
  eraInterval: inRange(1, MAX_ERA_STEPPER),
  eraCount: inRange(1, MAX_ERA_STEPPER),
  survivalMode: isBool,
  modifiersDealtPerEra: inRange(0, 10),
  // 0 is a legal, meaningful value: it disables the tier (see rarityDealWeights).
  rarityWeightCommon: inRange(0, MAX_RARITY_DEAL_WEIGHT),
  rarityWeightUncommon: inRange(0, MAX_RARITY_DEAL_WEIGHT),
  rarityWeightRare: inRange(0, MAX_RARITY_DEAL_WEIGHT),
  rarityWeightLegendary: inRange(0, MAX_RARITY_DEAL_WEIGHT),
  modifierSlotsStart: inRange(1, 20),
  slotIncreaseEveryNEras: inRange(0, 20),
  slotIncreaseAmount: inRange(1, 10),
  modifierSlotsMax: inRange(1, 20),
  engineAnimationSeconds: inRange(0, 10),
  enableTutorials: isBool,
  hostPlays: isBool,
  botCount: inRange(1, 5),
};

/**
 * Engine bay slot count at a given 1-based card-era index (the Nth card-bearing optimize:
 * the first deal is 1, the next intermission 2, and so on). Slots start at `modifierSlotsStart`
 * and grow by `slotIncreaseAmount` every `slotIncreaseEveryNEras` eras, capped at
 * `modifierSlotsMax`. `slotIncreaseEveryNEras === 0` disables growth (stays at the start value).
 */
export function modifierSlotsForCardEra(s: AlphaChainSettings, cardEra: number): number {
  const increases =
    s.slotIncreaseEveryNEras > 0 ? Math.floor((cardEra - 1) / s.slotIncreaseEveryNEras) : 0;
  return Math.min(s.modifierSlotsMax, s.modifierSlotsStart + s.slotIncreaseAmount * increases);
}

/**
 * The dealer's per-tier weights for a given settings object — the single read path for
 * the host-configurable rarity economy (see the `rarityWeight*` settings). Weights are
 * relative, and a tier at 0 is excluded from the deal pool outright rather than merely
 * being unlikely; see MatchController.dealCards.
 */
export function rarityDealWeights(s: AlphaChainSettings): Record<CardRarity, number> {
  const weights = {} as Record<CardRarity, number>;
  for (const tier of Object.values(CardRarity)) weights[tier] = s[RARITY_WEIGHT_KEYS[tier]];
  return weights;
}

/**
 * How many cards each player will be ASKED for across a whole match — what the dealer tries
 * to hand out, not what it can actually supply (compare `dealPoolCapacity`, which is the
 * ceiling the enabled tiers can cover).
 *
 * One deal per era-end intermission, and the final era ends the match instead — so `eraCount
 * - 1` deals — plus the pre-era-1 setup deal when `dealEngineCardsFirstEra` is on, which
 * brings it back to `eraCount` (see MatchController.enterSetupIntermission / enterIntermission).
 */
export function totalCardsDealtPerPlayer(s: AlphaChainSettings): number {
  const deals = s.dealEngineCardsFirstEra ? s.eraCount : s.eraCount - 1;
  return Math.max(0, deals) * s.modifiersDealtPerEra;
}

/** Letters legal to ban under a given mode. */
export function legalBanLetters(mode: AlphaChainSettings["banMode"]): string[] {
  const all = "abcdefghijklmnopqrstuvwxyz".split("");
  if (mode === "VowelsOnly") return all.filter((c) => VOWELS.has(c));
  if (mode === "ConsonantsOnly") return all.filter((c) => !VOWELS.has(c));
  return all;
}

/**
 * Letters a player may pick this era under the ban-repeat rule, given the letters
 * banned in past eras (`history`, most-recent last). `AllowRepeat` never excludes;
 * `NoConsecutive` excludes only the last entry; `NoRepeat` excludes every entry.
 * If excluding would leave no legal letter (the pool is exhausted — only reachable
 * under `NoRepeat` across many eras), the exclusion set is reset and the full legal
 * pool is returned. The authority mirrors this reset on `bannedLetterHistory` when
 * it detects exhaustion (see applySniperBanAndAdvance).
 */
export function availableBanLetters(
  mode: AlphaChainSettings["banMode"],
  rule: BanRepeatRule,
  history: readonly string[],
): string[] {
  const legal = legalBanLetters(mode);
  if (rule === "AllowRepeat" || history.length === 0) return legal;
  const excluded =
    rule === "NoConsecutive"
      ? new Set([history[history.length - 1].toLowerCase()])
      : new Set(history.map((l) => l.toLowerCase()));
  const available = legal.filter((c) => !excluded.has(c));
  // Pool exhausted: reset the exclusion set rather than leave nothing to ban.
  return available.length > 0 ? available : legal;
}
