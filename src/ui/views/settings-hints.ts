/*
 * One-line explanations for every host-configurable setting, shown as a hover
 * tooltip (the `title` attribute) on each setting row in both lobbies. Centralized
 * here so the solo and multiplayer lobbies never drift out of sync.
 */

import type { AlphaChainSettings } from "../../game/types";

export const SETTING_HINTS: Record<keyof AlphaChainSettings, string> = {
  botCount: "How many AI opponents you play against.",
  botDifficulty: "How well the bots play; their word quality and reaction speed.",
  banMode: "Which letters are eligible to be the era's banned letter.",
  banRepeatRule:
    "Allow Repeats | No Consecutive Bans | No Repeat Bans (resets when all letters are used).",
  dealEngineCardsFirstEra:
    "Start the game with engine cards instead of starting with empty engines.",
  shotClockSeconds: "Seconds each player has to submit a word before timing out.",
  eraCount: "How many eras are in a match.",
  eraInterval: "How many full rounds (one cycle of all players) are in an era.",
  modifiersDealtPerEra: "How many new modifier cards each player is dealt each intermission.",
  modifierSlotsStart: "How many engine bay slots you have when cards are first dealt.",
  slotIncreaseEveryNEras: "How often engine bay slots increase — every N eras, or never (0).",
  slotIncreaseAmount: "How many engine bay slots are added at each increase.",
  modifierSlotsMax: "The maximum engine bay slots can ever grow to.",
  intermissionCardSelectSeconds: "Seconds to arrange your engine during the optimize phase.",
  sniperBanSeconds: "Seconds the last-place player has to pick a letter to ban.",
  preRoundCountdownSeconds: "Length of the countdown shown before each era begins.",
  engineAnimationSeconds: "How long the score-replay animation runs per resolved word.",
  survivalMode: "A single shot-clock timeout eliminates you from the match.",
  enableTutorials: "Show the how-to-play tutorial overlays at their cue points.",
  hostPlays: "Whether the host joins as a player or sits out as a shared display.",
};
