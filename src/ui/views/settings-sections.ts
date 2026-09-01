/*
 * The lobby settings panel, in sections — the single definition of what rows exist, what order
 * they come in, and which band each belongs to.
 *
 * Both lobbies used to hand-render this list, and had already drifted: different order, Tutorials
 * in a different place, the Classic shot clock several rows away from the Word Builder rows it
 * substitutes for. Everything below is rendered from here instead, so a row added or moved lands
 * in both lobbies at once. What legitimately differs between them is the HOST PREFERENCES band
 * (bots are solo-only, host-plays is multiplayer-only) and nothing else — hence the flags on
 * `renderHostPreferences` and no flags at all on `renderMatchRules`.
 *
 * Two bands, and the split is not cosmetic:
 *
 *   HOST PREFERENCES  the five keys in PRESET_EXCLUDED_KEYS — how YOU want to play. A preset
 *                     never writes these, and changing one never makes the settings "Custom".
 *   MATCH RULES       everything a preset owns, in six sub-sections.
 *
 * The band a row is drawn in and the scope a preset respects are therefore the same boundary,
 * stated in two places; presets.test.ts asserts the two agree, so the panel cannot start lying
 * about what a preset will do to it.
 *
 * Each lobby still lends its OWN row primitives (see SettingControls), so the multiplayer copy
 * keeps disabling every control for a guest without anything here knowing about ownership.
 */

import { html, nothing, type TemplateResult } from "lit";
import { MAX_ERA_STEPPER } from "../../game/settings";
import type { HostPreferenceKey } from "../../game/presets";
import { GameMode } from "../../game/types";
import type { AlphaChainSettings, BotDifficulty } from "../../game/types";
import { renderPickerSettings } from "./picker-settings";
import { renderRarityWeights } from "./rarity-weights";
import type { SettingControls } from "./setting-controls";
import { SETTING_GROUP_HINTS, SETTING_HINTS } from "./settings-hints";

const DIFFS: BotDifficulty[] = ["easy", "medium", "hard"];

/**
 * Which host-preference rows each lobby shows.
 *
 * Exported so presets.test.ts can pin that the union of the two is EXACTLY
 * PRESET_EXCLUDED_KEYS — every excluded key is visible in some lobby (so nothing a preset
 * refuses to touch is also unreachable by hand), and no match rule has been quietly filed
 * under "preferences" where a preset would then blow it away.
 */
export const HOST_PREFERENCE_KEYS: {
  solo: readonly HostPreferenceKey[];
  net: readonly HostPreferenceKey[];
} = {
  // No `hostPlays`: there is no shared display to sit out of when you are playing bots.
  solo: ["botCount", "botDifficulty", "enableTutorials", "engineAnimationSeconds"],
  // No bot rows: the multiplayer roster is real people.
  net: ["hostPlays", "enableTutorials", "engineAnimationSeconds"],
};

/** One sub-section of the MATCH RULES band: a collapsible dropdown with heading, explanation, and rows. */
const section = (
  title: string,
  hint: string,
  rows: (TemplateResult | typeof nothing)[],
): TemplateResult => html`
  <details class="set-group set-details">
    <summary class="set-summary">
      <span class="set-subhead">${title}</span>
      <span class="set-chevron" aria-hidden="true"></span>
    </summary>
    <div class="set-group-body">
      <p class="set-groupdesc">${hint}</p>
      <div class="set-rows">
        ${rows}
      </div>
    </div>
  </details>
`;

/**
 * The HOST PREFERENCES band. `opts` names the rows that only one lobby has; everything else is
 * common. Keep this in step with HOST_PREFERENCE_KEYS above — the test compares them.
 */
export const renderHostPreferences = (
  draft: AlphaChainSettings,
  c: SettingControls,
  opts: { bots?: boolean; hostPlays?: boolean },
): TemplateResult => html`
  <details class="set-group set-details">
    <summary class="set-summary set-summary--head">
      <span class="set-head">Host Preferences</span>
      <span class="set-chevron" aria-hidden="true"></span>
    </summary>
    <div class="set-group-body">
      <p class="set-groupdesc">${SETTING_GROUP_HINTS.hostPreferences}</p>
      <div class="set-rows">
        ${opts.bots
          ? html`
              ${c.stepper(
                "Opponents",
                String(draft.botCount),
                () => c.step("botCount", -1, 1, 5),
                () => c.step("botCount", 1, 1, 5),
                SETTING_HINTS.botCount,
              )}
              ${c.segmented<BotDifficulty>(
                "Difficulty",
                draft.botDifficulty,
                DIFFS.map((diff) => ({ value: diff, text: diff })),
                (v) => c.set("botDifficulty", v),
                SETTING_HINTS.botDifficulty,
              )}
            `
          : nothing}
        ${opts.hostPlays
          ? c.segmented(
              "Host Plays",
              draft.hostPlays ? "play" : "watch",
              [
                { value: "play", text: "yes" },
                { value: "watch", text: "spectate" },
              ],
              (v) => c.set("hostPlays", v === "play"),
              SETTING_HINTS.hostPlays,
            )
          : nothing}
        ${c.toggle(
          "Tutorials",
          draft.enableTutorials,
          (v) => c.set("enableTutorials", v),
          SETTING_HINTS.enableTutorials,
        )}
        ${c.stepper(
          "Engine Animation Duration",
          `${draft.engineAnimationSeconds.toFixed(1)}s`,
          () => c.step("engineAnimationSeconds", -0.5, 0.5, 10),
          () => c.step("engineAnimationSeconds", 0.5, 0.5, 10),
          SETTING_HINTS.engineAnimationSeconds,
        )}
      </div>
    </div>
  </details>
`;

/** The MATCH RULES band — everything a preset owns. */
export const renderMatchRules = (
  draft: AlphaChainSettings,
  c: SettingControls,
): TemplateResult => html`
  <p class="set-head">Match Rules</p>

  ${section("Mode & Words", SETTING_GROUP_HINTS.modeAndWords, [
    // Game Mode leads its section deliberately: the rows under it are the ones the mode
    // decides between, so it has to be read first for them to make sense.
    c.segmented<GameMode>(
      "Game Mode",
      draft.gameMode,
      [
        { value: GameMode.Picker, text: "word builder" },
        { value: GameMode.Classic, text: "classic" },
      ],
      (v) => c.set("gameMode", v),
      SETTING_HINTS.gameMode,
    ),
    // The two modes' rows are an either/or, and now sit together: Word Builder's rack and pick
    // timer, or Classic's shot clock. They were several rows apart in both lobbies, which read
    // as two competing clocks whenever you switched mode.
    renderPickerSettings(draft, c),
    draft.gameMode === GameMode.Classic
      ? c.stepper(
          "Shot Clock",
          `${draft.shotClockSeconds}s`,
          () => c.step("shotClockSeconds", -5, 5, 60),
          () => c.step("shotClockSeconds", 5, 5, 60),
          SETTING_HINTS.shotClockSeconds,
        )
      : nothing,
  ])}
  ${section("Match Length", SETTING_GROUP_HINTS.matchLength, [
    c.stepper(
      "Eras",
      String(draft.eraCount),
      () => c.step("eraCount", -1, 1, MAX_ERA_STEPPER),
      () => c.step("eraCount", 1, 1, MAX_ERA_STEPPER),
      SETTING_HINTS.eraCount,
    ),
    c.stepper(
      "Rounds Per Era",
      String(draft.eraInterval),
      () => c.step("eraInterval", -1, 1, MAX_ERA_STEPPER),
      () => c.step("eraInterval", 1, 1, MAX_ERA_STEPPER),
      SETTING_HINTS.eraInterval,
    ),
    c.stepper(
      "Countdown",
      `${draft.preRoundCountdownSeconds}s`,
      () => c.step("preRoundCountdownSeconds", -1, 3, 15),
      () => c.step("preRoundCountdownSeconds", 1, 3, 15),
      SETTING_HINTS.preRoundCountdownSeconds,
    ),
    // Survival sits under Match Length rather than with the other hazards because it is the
    // only setting other than Eras that decides when a player's match STOPS.
    c.toggle(
      "Survival Mode",
      draft.survivalMode,
      (v) => c.set("survivalMode", v),
      SETTING_HINTS.survivalMode,
    ),
  ])}
  ${section("Banned Letters", SETTING_GROUP_HINTS.bannedLetters, [
    c.segmented<AlphaChainSettings["banMode"]>(
      "Letter Ban Mode",
      draft.banMode,
      [
        { value: "All", text: "all" },
        { value: "VowelsOnly", text: "vowels" },
        { value: "ConsonantsOnly", text: "conson." },
      ],
      (v) => c.set("banMode", v),
      SETTING_HINTS.banMode,
    ),
    c.segmented<AlphaChainSettings["banRepeatRule"]>(
      "Letter Ban Repeats",
      draft.banRepeatRule,
      [
        { value: "AllowRepeat", text: "allow" },
        { value: "NoConsecutive", text: "no consec." },
        { value: "NoRepeat", text: "never" },
      ],
      (v) => c.set("banRepeatRule", v),
      SETTING_HINTS.banRepeatRule,
    ),
    c.stepper(
      "Letter Ban Time",
      `${draft.sniperBanSeconds}s`,
      () => c.step("sniperBanSeconds", -5, 5, 120),
      () => c.step("sniperBanSeconds", 5, 5, 120),
      SETTING_HINTS.sniperBanSeconds,
    ),
  ])}
  ${section("Engine Cards", SETTING_GROUP_HINTS.engineCards, [
    c.stepper(
      "Cards Per Era",
      String(draft.modifiersDealtPerEra),
      () => c.step("modifiersDealtPerEra", -1, 0, 10),
      () => c.step("modifiersDealtPerEra", 1, 0, 10),
      SETTING_HINTS.modifiersDealtPerEra,
    ),
    c.toggle(
      "Start With Engine Cards",
      draft.dealEngineCardsFirstEra,
      (v) => c.set("dealEngineCardsFirstEra", v),
      SETTING_HINTS.dealEngineCardsFirstEra,
    ),
    c.stepper(
      "Engine Management Time",
      `${draft.intermissionCardSelectSeconds}s`,
      () => c.step("intermissionCardSelectSeconds", -10, 10, 180),
      () => c.step("intermissionCardSelectSeconds", 10, 10, 180),
      SETTING_HINTS.intermissionCardSelectSeconds,
    ),
  ])}

  <!-- Already a self-contained .set-group with its own heading, shared explanation and
       capacity warning — it slots in as a peer of the sections above rather than nesting. -->
  ${renderRarityWeights(draft, c)}
  ${section("Engine Bay Slots", SETTING_GROUP_HINTS.engineBaySlots, [
    c.stepper(
      "Starting Slots",
      String(draft.modifierSlotsStart),
      () => c.step("modifierSlotsStart", -1, 1, 20),
      () => c.step("modifierSlotsStart", 1, 1, 20),
      SETTING_HINTS.modifierSlotsStart,
    ),
    c.stepper(
      "Slots Increase Every",
      draft.slotIncreaseEveryNEras === 0
        ? "Never"
        : `${draft.slotIncreaseEveryNEras} era${draft.slotIncreaseEveryNEras === 1 ? "" : "s"}`,
      () => c.step("slotIncreaseEveryNEras", -1, 0, 20),
      () => c.step("slotIncreaseEveryNEras", 1, 0, 20),
      SETTING_HINTS.slotIncreaseEveryNEras,
    ),
    c.stepper(
      "Slots Per Increase",
      String(draft.slotIncreaseAmount),
      () => c.step("slotIncreaseAmount", -1, 1, 10),
      () => c.step("slotIncreaseAmount", 1, 1, 10),
      SETTING_HINTS.slotIncreaseAmount,
    ),
    c.stepper(
      "Max Slots",
      String(draft.modifierSlotsMax),
      () => c.step("modifierSlotsMax", -1, 1, 20),
      () => c.step("modifierSlotsMax", 1, 1, 20),
      SETTING_HINTS.modifierSlotsMax,
    ),
  ])}
`;
