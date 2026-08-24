/*
 * The Word Builder lobby rows — rack size, word list, pick timer, banned-letter highlighting.
 *
 * A free function rather than a method on either lobby, for the same reason `renderRarityWeights`
 * is: <ac-lobby> and <ac-net-lobby> render an identical group, and a copy in each is exactly how
 * the solo and multiplayer settings lists drift apart. Each lobby passes its OWN row primitives
 * (see SettingControls), so the multiplayer copy still inherits the guest read-only disabling.
 *
 * Renders NOTHING in Classic. These settings are meaningless there, and showing a "Pick Timer"
 * next to Classic's "Shot Clock" reads as two competing clocks. The Classic side of that either/or
 * lives in settings-sections.ts, which renders whichever of the two the mode calls for.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
  MAX_BUILDER_RACK_SIZE,
  MAX_OFFER_COUNT,
  MIN_BUILDER_RACK_SIZE,
  MIN_OFFER_COUNT,
} from "../../game/settings";
import { DictionaryTier, GameMode } from "../../game/types";
import type { AlphaChainSettings } from "../../game/types";
import type { SettingControls } from "./setting-controls";
import { SETTING_HINTS } from "./settings-hints";

/** Clamp bounds for the Offer-size stepper. Shared with the persistence validator via
 *  settings.ts, so the editable range and the accepted range cannot drift — the bug the
 *  validator comment claims is avoided but `eraCount`/`eraInterval` actually have. */
export const OFFER_COUNT_BOUNDS = { min: MIN_OFFER_COUNT, max: MAX_OFFER_COUNT } as const;

export const RACK_SIZE_BOUNDS = { min: MIN_BUILDER_RACK_SIZE, max: MAX_BUILDER_RACK_SIZE } as const;

/** Clamp bounds for the pick timer, matching `pickerShotClockSeconds`'s validator exactly. */
export const PICKER_CLOCK_BOUNDS = { min: 5, max: 60, step: 5 } as const;

/**
 * Render the Word Builder group for a lobby, or nothing in Classic.
 *
 * `c.step` and `c.set` are the lobby's own mutators (identical signatures in both), so
 * persistence and — in the multiplayer lobby — the owner-only settings push happen through the
 * existing path.
 */
export const renderPickerSettings = (
  draft: AlphaChainSettings,
  c: SettingControls,
): TemplateResult | typeof nothing => {
  if (draft.gameMode !== GameMode.Picker) return nothing;
  const rackBounds = RACK_SIZE_BOUNDS;
  const clock = PICKER_CLOCK_BOUNDS;
  return html`
    ${c.stepper(
      "Rack Size",
      String(draft.rackSize),
      () => c.step("rackSize", -1, rackBounds.min, rackBounds.max),
      () => c.step("rackSize", 1, rackBounds.min, rackBounds.max),
      SETTING_HINTS.rackSize,
    )}
    ${c.segmented<DictionaryTier>(
      "Word List",
      draft.offerDictionary,
      [
        { value: DictionaryTier.Reduced, text: "common" },
        { value: DictionaryTier.Full, text: "full" },
      ],
      (v) => c.set("offerDictionary", v),
      SETTING_HINTS.offerDictionary,
    )}
    ${c.stepper(
      "Pick Timer",
      `${draft.pickerShotClockSeconds}s`,
      () => c.step("pickerShotClockSeconds", -clock.step, clock.min, clock.max),
      () => c.step("pickerShotClockSeconds", clock.step, clock.min, clock.max),
      SETTING_HINTS.pickerShotClockSeconds,
    )}
    ${c.toggle(
      "Highlight Banned Letter",
      draft.highlightBannedLetters,
      (v) => c.set("highlightBannedLetters", v),
      SETTING_HINTS.highlightBannedLetters,
    )}
  `;
};
