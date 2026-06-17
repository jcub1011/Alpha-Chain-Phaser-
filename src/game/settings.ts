import { createLogger } from "../log";
import type { AlphaChainSettings } from "./types";

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

/**
 * Load persisted settings, merged over defaults with per-key type validation.
 * Unknown keys are dropped, missing keys fall back to defaults (forward-compatible
 * when new settings are added), and corrupt/legacy values are ignored. Any parse
 * error or absent localStorage yields a fresh copy of the defaults.
 */
export function loadSettings(): AlphaChainSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const result = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AlphaChainSettings)[]) {
      const value = stored[key];
      if (typeof value === typeof DEFAULT_SETTINGS[key]) {
        (result[key] as unknown) = value;
      }
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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

export const VOWELS = new Set(["a", "e", "i", "o", "u"]);
export const isVowel = (c: string): boolean => VOWELS.has(c.toLowerCase());

/** Letters legal to ban under a given mode. */
export function legalBanLetters(mode: AlphaChainSettings["banMode"]): string[] {
  const all = "abcdefghijklmnopqrstuvwxyz".split("");
  if (mode === "VowelsOnly") return all.filter((c) => VOWELS.has(c));
  if (mode === "ConsonantsOnly") return all.filter((c) => !VOWELS.has(c));
  return all;
}
