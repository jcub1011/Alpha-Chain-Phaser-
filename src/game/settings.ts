import { createLogger } from "../log";
import type { AlphaChainSettings, BanMode, BotDifficulty } from "./types";

const log = createLogger("settings");

/** Defaults ported from AlphaChainSettings.cs, plus single-player bot options. */
export const DEFAULT_SETTINGS: AlphaChainSettings = {
  banMode: "All",
  shotClockSeconds: 20,
  intermissionCardSelectSeconds: 45,
  sniperBanSeconds: 15,
  preRoundCountdownSeconds: 4,
  eraInterval: 4,
  eraCount: 4,
  survivalMode: false,
  modifiersDealtPerEra: 3,
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
const SETTINGS_VERSION = 1;

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
export const MODIFIER_SLOTS_START = 3;

/** Flat points a player loses when their shot clock expires, before any per-card
 *  `timeoutFold` reactions (glass-cannon drains, Insurance's refund) fold in. */
export const BASE_TIMEOUT_PENALTY = 10;

export const VOWELS = new Set(["a", "e", "i", "o", "u"]);
export const isVowel = (c: string): boolean => VOWELS.has(c.toLowerCase());

const BAN_MODES: readonly BanMode[] = ["All", "VowelsOnly", "ConsonantsOnly"];
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
  botDifficulty: (v) => BOT_DIFFICULTIES.includes(v as BotDifficulty),
  shotClockSeconds: inRange(MIN_SHOT_CLOCK_SECONDS, 120),
  intermissionCardSelectSeconds: inRange(5, 180),
  sniperBanSeconds: inRange(5, 120),
  preRoundCountdownSeconds: inRange(0, 30),
  eraInterval: inRange(1, 20),
  eraCount: inRange(1, 20),
  survivalMode: isBool,
  modifiersDealtPerEra: inRange(0, 10),
  engineAnimationSeconds: inRange(0, 10),
  enableTutorials: isBool,
  hostPlays: isBool,
  botCount: inRange(1, 5),
};

/** Letters legal to ban under a given mode. */
export function legalBanLetters(mode: AlphaChainSettings["banMode"]): string[] {
  const all = "abcdefghijklmnopqrstuvwxyz".split("");
  if (mode === "VowelsOnly") return all.filter((c) => VOWELS.has(c));
  if (mode === "ConsonantsOnly") return all.filter((c) => !VOWELS.has(c));
  return all;
}
