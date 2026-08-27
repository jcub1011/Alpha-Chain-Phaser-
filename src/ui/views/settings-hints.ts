/*
 * The explanatory copy under every host-configurable setting in both lobbies.
 * Centralized here so the solo and multiplayer lists never drift out of sync.
 *
 * Two kinds:
 *
 *   SETTING_HINTS       one line per setting, rendered under that row's label.
 *   SETTING_GROUP_HINTS one line per SECTION, rendered once under the section
 *                       heading. For a run of settings that share a single
 *                       mechanic, the section carries the explanation and the
 *                       rows carry only their names.
 *
 * The rarity weights are why the second kind exists: four rows each repeating
 * "how often X is offered, relative to the other tiers — not a percentage"
 * meant the same sentence four times on screen, and the only thing that
 * actually differed per row was the tier name already in the label. They are
 * Exclude-d from SETTING_HINTS below rather than left unused, so the exhaustive
 * Record still forces a hint for every setting that does need its own.
 */

import type { AlphaChainSettings, RarityWeightKey } from "../../game/types";

/** Settings whose explanation lives on their section instead of their row. */
type GroupedSetting = RarityWeightKey;

/** Section id -> the one explanation shared by every setting in that section. */
export const SETTING_GROUP_HINTS = {
  presets:
    "Start from a ready-made match, then change anything you like. Editing any match rule switches this to Custom.",
  hostPreferences:
    "Yours, not the match's — how you like to play rather than how the game is scored. No preset ever changes these.",
  modeAndWords: "How a word gets into the chain, and which words are available to put there.",
  matchLength: "How long a match runs, and what can end it early.",
  bannedLetters:
    "At each intermission the player in last place bans a letter for everyone next era. These decide what they may pick and how long they get to pick it.",
  engineCards: "How many modifier cards you are dealt, when, and how long you get to arrange them.",
  engineBaySlots:
    "How many cards your engine bay can hold, and how that grows as the match runs on. Anything past the limit has to be cut.",
  rarityWeights:
    "How often each tier is offered, relative to the others — these are weights, not percentages. Set a tier to 0 to drop it from the deal entirely.",
} as const;

export const SETTING_HINTS: Record<Exclude<keyof AlphaChainSettings, GroupedSetting>, string> = {
  gameMode: "Word Builder: assemble words from a dealt tile rack. Classic: type words freely.",
  rackSize: "How many tiles are dealt to your rack each turn. 9 is standard; the extremes are playable but rough.",
  offerDictionary:
    "Common: ~9,000 everyday words, easier to read at a glance. Full: all 386,000, far more obscure.",
  pickerShotClockSeconds: "Seconds to build and submit a word from your tile rack.",
  highlightBannedLetters:
    "Highlight the era's banned letter on your tiles. Off keeps the nasty surprise.",
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
