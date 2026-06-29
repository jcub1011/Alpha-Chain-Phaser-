import { createLogger } from "../log";
import type { AlphaChainSettings, BanMode, BanRepeatRule, BotDifficulty } from "./types";

const log = createLogger("settings");

/** Engine bay slots a player starts with (ported from AlphaChainGameState.cs); also the
 *  default for the configurable `modifierSlotsStart` setting. */
export const MODIFIER_SLOTS_START = 3;

/** Defaults ported from AlphaChainSettings.cs, plus single-player bot options. */
export const DEFAULT_SETTINGS: AlphaChainSettings = {
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
const SETTINGS_VERSION = 3;

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
    const result = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AlphaChainSettings)[]) {
      if (SETTINGS_VALIDATORS[key](stored[key])) (result[key] as unknown) = stored[key];
    }
    log.debug("settings loaded from localStorage");
    return result;
  } catch (err) {
    log.warn(`settings load failed; using defaults: ${String(err)}`);
    return { ...DEFAULT_SETTINGS };
  }
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
  banMode: (v) => BAN_MODES.includes(v as BanMode),
  banRepeatRule: (v) => BAN_REPEAT_RULES.includes(v as BanRepeatRule),
  dealEngineCardsFirstEra: isBool,
  botDifficulty: (v) => BOT_DIFFICULTIES.includes(v as BotDifficulty),
  shotClockSeconds: inRange(MIN_SHOT_CLOCK_SECONDS, 120),
  intermissionCardSelectSeconds: inRange(5, 180),
  sniperBanSeconds: inRange(5, 120),
  preRoundCountdownSeconds: inRange(0, 30),
  eraInterval: inRange(1, 20),
  eraCount: inRange(1, 20),
  survivalMode: isBool,
  modifiersDealtPerEra: inRange(0, 10),
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
      ? new Set([history[history.length - 1]])
      : new Set(history.map((l) => l.toLowerCase()));
  const available = legal.filter((c) => !excluded.has(c));
  // Pool exhausted: reset the exclusion set rather than leave nothing to ban.
  return available.length > 0 ? available : legal;
}
