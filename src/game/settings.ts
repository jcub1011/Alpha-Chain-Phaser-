import type { AlphaChainSettings } from "./types";

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
