/*
 * Settings presets — curated starting points for the lobby's match rules.
 *
 * A preset is a DIFF from `DEFAULT_SETTINGS`, not a full settings object: a setting added
 * later automatically lands in every preset at its default instead of needing six edits (and
 * six chances to forget one). `normal` is the empty diff.
 *
 * A preset writes and watches only the MATCH RULES. The five host preferences in
 * PRESET_EXCLUDED_KEYS — how many bots you want, how hard they play, whether you sit out,
 * whether tutorials show, how fast the score replay runs — are yours, not the match's:
 * applying a preset leaves them alone, and changing one does not make the settings "Custom".
 * The lobby renders those five as their own band, so the boundary the host SEES is the
 * boundary the preset RESPECTS; presets.test.ts pins that the two agree.
 *
 * Nothing here is persisted. The active preset is DERIVED from the settings on every render
 * (see `detectPreset`), so it cannot desync from them, survives a reload for free, and a
 * multiplayer guest gets the owner's active preset off the replicated settings with no extra
 * wire traffic.
 */

import { DEFAULT_SETTINGS } from "./settings";
import { DictionaryTier, GameMode } from "./types";
import type { AlphaChainSettings } from "./types";

/** The host's own preferences: never written by a preset, never watched by `detectPreset`.
 *  A Record rather than an array so membership is a lookup, and so a key that stops existing
 *  is a compile error here. */
export const PRESET_EXCLUDED_KEYS = {
  botCount: true,
  botDifficulty: true,
  hostPlays: true,
  enableTutorials: true,
  engineAnimationSeconds: true,
} as const;

/** A setting that belongs to the host rather than to the match. */
export type HostPreferenceKey = keyof typeof PRESET_EXCLUDED_KEYS;

/** A setting a preset owns — everything that isn't a host preference. */
export type PresetKey = Exclude<keyof AlphaChainSettings, HostPreferenceKey>;

/** The match-rule keys, DERIVED from `DEFAULT_SETTINGS` by subtracting the excluded set rather
 *  than listed out — the same reasoning as RARITY_WEIGHT_KEYS in settings.ts. A setting added
 *  later joins the presets automatically instead of being silently left out of all six. */
export const PRESET_KEYS: readonly PresetKey[] = (
  Object.keys(DEFAULT_SETTINGS) as (keyof AlphaChainSettings)[]
).filter((k): k is PresetKey => !(k in PRESET_EXCLUDED_KEYS));

/** Preset identity. A const object rather than a bare string union, matching GameMode /
 *  CardRarity / CardId: the id is compared in both lobbies and in the preset bar, and a typo in
 *  a bare `=== "quickmatch"` is silently false rather than a compile error. */
export const PresetId = {
  Normal: "normal",
  OldSchool: "oldSchool",
  QuickMatch: "quickMatch",
  Marathon: "marathon",
  CardStorm: "cardStorm",
  SuddenDeath: "suddenDeath",
} as const;
export type PresetId = (typeof PresetId)[keyof typeof PresetId];

/** A preset's diff from `DEFAULT_SETTINGS`. Only match rules — the type forbids a preset from
 *  reaching into the host's preferences. */
export type PresetOverrides = Partial<Pick<AlphaChainSettings, PresetKey>>;

/**
 * The presets, in bar order. `normal` MUST stay first: `detectPreset` returns the first match,
 * so a settings object equal to two presets resolves to the earlier one, and stock defaults
 * should read as Normal rather than as whichever preset happens to be listed next.
 *
 * Every override below is a value that actually changes play. Notably absent: `modifierSlotsMax`
 * in Marathon and Card Storm, whose growth curves top out at 10 and 11 slots and never reach the
 * stock 12 cap — raising it there would be a number that looks like a knob and does nothing.
 */
export const SETTINGS_PRESETS: readonly { id: PresetId; overrides: PresetOverrides }[] = [
  { id: PresetId.Normal, overrides: {} },

  // The original typing race. Just the mode: every other default in this port was ported FROM
  // the .NET original (see DEFAULT_SETTINGS), so Classic + the defaults IS what the old game
  // shipped. The Preference Cards drop out on their own — the dealer filters the pool by mode.
  { id: PresetId.OldSchool, overrides: { gameMode: GameMode.Classic } },

  // ~10 minutes. 2 eras means only 2 card deals, so engines have to arrive early and wide or
  // the engine-builder half of the game never happens before the match ends: cards are dealt
  // before era 1 and slots start at 4 instead of 3.
  {
    id: PresetId.QuickMatch,
    overrides: {
      eraCount: 2,
      eraInterval: 3,
      pickerShotClockSeconds: 20,
      shotClockSeconds: 15,
      dealEngineCardsFirstEra: true,
      modifierSlotsStart: 4,
      intermissionCardSelectSeconds: 30,
      preRoundCountdownSeconds: 3,
      sniperBanSeconds: 10,
    },
  },

  // A long build: 8 deals x 3 cards = 24 cards per player, against 10 slots by the last era
  // (3 + 1/era). Over half of what you are dealt has to be cut, which is the point — the match
  // is mostly curation, not accumulation. A longer optimize phase to actually do it in.
  {
    id: PresetId.Marathon,
    overrides: {
      eraCount: 8,
      eraInterval: 4,
      dealEngineCardsFirstEra: true,
      intermissionCardSelectSeconds: 60,
    },
  },

  // Engine-builder power fantasy: 20 cards across 4 eras into 11 slots, so nearly everything
  // you are dealt fits. The flattened rarity weights are the real change — at the stock
  // 10/5/2/1 ramp a specific Legendary is a tenth as likely as a specific Common, and most
  // matches simply never show you one.
  {
    id: PresetId.CardStorm,
    overrides: {
      modifiersDealtPerEra: 5,
      dealEngineCardsFirstEra: true,
      modifierSlotsStart: 5,
      slotIncreaseAmount: 2,
      intermissionCardSelectSeconds: 75,
      rarityWeightCommon: 6,
      rarityWeightUncommon: 6,
      rarityWeightRare: 5,
      rarityWeightLegendary: 4,
    },
  },

  // Cutthroat. Survival makes a single timeout fatal, so every other dial here is pointed at
  // making the clock hurt: less time, a thinner rack, the full 386k list instead of the common
  // one, and a banned letter that can never come back around to a letter you have already
  // adapted to.
  {
    id: PresetId.SuddenDeath,
    overrides: {
      survivalMode: true,
      pickerShotClockSeconds: 15,
      shotClockSeconds: 12,
      rackSize: 7,
      offerDictionary: DictionaryTier.Full,
      banRepeatRule: "NoRepeat",
      sniperBanSeconds: 10,
      preRoundCountdownSeconds: 3,
      eraCount: 3,
      intermissionCardSelectSeconds: 30,
    },
  },
];

/** The match rules a preset asks for: the preset-key slice of the defaults, overridden by its
 *  diff. Never includes a host preference — see PRESET_EXCLUDED_KEYS. */
export function presetSettings(id: PresetId): Pick<AlphaChainSettings, PresetKey> {
  const base = {} as Record<PresetKey, unknown>;
  for (const k of PRESET_KEYS) base[k] = DEFAULT_SETTINGS[k];
  const preset = SETTINGS_PRESETS.find((p) => p.id === id);
  return {
    ...(base as Pick<AlphaChainSettings, PresetKey>),
    ...preset?.overrides,
  };
}

/** `current` with the preset's match rules applied. The host's preferences survive by
 *  construction: `presetSettings` has no key to overwrite them with. */
export function applyPreset(current: AlphaChainSettings, id: PresetId): AlphaChainSettings {
  return { ...current, ...presetSettings(id) };
}

/** Which preset `s` currently IS, or null for Custom. Compares only the match rules, so a host
 *  who changes their bot count or turns tutorials off keeps whichever preset they picked. */
export function detectPreset(s: AlphaChainSettings): PresetId | null {
  for (const preset of SETTINGS_PRESETS) {
    const want = presetSettings(preset.id);
    if (PRESET_KEYS.every((k) => s[k] === want[k])) return preset.id;
  }
  return null;
}
