/*
 * One-line explanations for every host-configurable setting, shown as a hover
 * tooltip (the `title` attribute) on each setting row in both lobbies. Centralized
 * here so the solo and multiplayer lobbies never drift out of sync.
 */

import type { AlphaChainSettings } from "../../game/types";

export const SETTING_HINTS: Record<keyof AlphaChainSettings, string> = {
  botCount: "How many AI opponents you play against.",
  botDifficulty: "How well the bots play — their word quality and reaction speed.",
  banMode: "Which letters are eligible to be the era's banned letter.",
  banRepeatRule:
    "Whether a previously-banned letter can be chosen again — allow repeats, never two eras in a row, or never twice (the pool resets if every letter has been used).",
  dealEngineCardsFirstEra:
    "Deal an opening hand and run an optimize phase before era 1, instead of starting with empty engines.",
  shotClockSeconds: "Seconds each player has to submit a word before timing out.",
  eraCount: "How many eras the match lasts.",
  eraInterval: "How many full rounds (one cycle of all players) make up an era.",
  modifiersDealtPerEra: "How many new modifier cards each player is dealt each intermission.",
  intermissionCardSelectSeconds: "Seconds to arrange your engine during the optimize phase.",
  sniperBanSeconds: "Seconds the last-place player has to pick a letter to ban.",
  preRoundCountdownSeconds: "Length of the countdown shown before each era begins.",
  engineAnimationSeconds: "How long the score-replay animation runs per resolved word.",
  survivalMode: "A single shot-clock timeout eliminates you from the match.",
  enableTutorials: "Show the how-to-play tutorial overlays at their cue points.",
  hostPlays: "Whether the host joins as a player or sits out as a shared display.",
};
