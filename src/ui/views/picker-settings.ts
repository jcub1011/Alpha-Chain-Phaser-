/*
 * The Picker-mode lobby rows — Offer size, word list, pick timer, banned-letter highlighting.
 *
 * A free function rather than a method on either lobby, for the same reason `renderRarityWeights`
 * is: <ac-lobby> and <ac-net-lobby> render an identical group, and a copy in each is exactly how
 * the solo and multiplayer settings lists drift apart. Each lobby passes its OWN row primitives,
 * so the multiplayer copy still inherits the guest read-only disabling for free.
 *
 * Renders NOTHING in Classic. These settings are meaningless there, and showing a "Pick Timer"
 * next to Classic's "Shot Clock" reads as two competing clocks.
 */

import { html, nothing, type TemplateResult } from "lit";
import { MAX_OFFER_COUNT, MIN_OFFER_COUNT } from "../../game/settings";
import type { AlphaChainSettings, DictionaryTier } from "../../game/types";
import type { SettingStepper } from "./rarity-weights";
import { SETTING_HINTS } from "./settings-hints";

/** A lobby's segmented-control renderer. Same rationale as `SettingStepper`. */
export type SettingSegmented = <T extends string>(
  label: string,
  current: T,
  options: { value: T; text: string }[],
  onPick: (v: T) => void,
  hint?: string,
) => TemplateResult;

/** A lobby's on/off renderer (both delegate to their own `segmented`, so guests stay disabled). */
export type SettingToggle = (
  label: string,
  on: boolean,
  set: (v: boolean) => void,
  hint?: string,
) => TemplateResult;

/** Clamp bounds for the Offer-size stepper. Shared with the persistence validator via
 *  settings.ts, so the editable range and the accepted range cannot drift — the bug the
 *  validator comment claims is avoided but `eraCount`/`eraInterval` actually have. */
export const OFFER_COUNT_BOUNDS = { min: MIN_OFFER_COUNT, max: MAX_OFFER_COUNT } as const;

/** Clamp bounds for the pick timer, matching `pickerShotClockSeconds`'s validator exactly. */
export const PICKER_CLOCK_BOUNDS = { min: 5, max: 60, step: 5 } as const;

/**
 * Render the Picker group for a lobby, or nothing in Classic.
 *
 * `step` and `set` are the lobby's own mutators (identical signatures in both), so persistence
 * and — in the multiplayer lobby — the owner-only settings push happen through the existing path.
 */
export const renderPickerSettings = (
  draft: AlphaChainSettings,
  step: <K extends keyof AlphaChainSettings>(
    key: K,
    delta: number,
    min: number,
    max: number,
  ) => void,
  set: <K extends keyof AlphaChainSettings>(key: K, value: AlphaChainSettings[K]) => void,
  stepper: SettingStepper,
  segmented: SettingSegmented,
  toggle: SettingToggle,
): TemplateResult | typeof nothing => {
  if (draft.gameMode !== "picker") return nothing;
  const { min, max } = OFFER_COUNT_BOUNDS;
  const clock = PICKER_CLOCK_BOUNDS;
  return html`
    ${stepper(
      "Words Offered",
      String(draft.offerCount),
      () => step("offerCount", -1, min, max),
      () => step("offerCount", 1, min, max),
      SETTING_HINTS.offerCount,
    )}
    ${segmented<DictionaryTier>(
      "Word List",
      draft.offerDictionary,
      [
        { value: "reduced", text: "common" },
        { value: "full", text: "full" },
      ],
      (v) => set("offerDictionary", v),
      SETTING_HINTS.offerDictionary,
    )}
    ${stepper(
      "Pick Timer",
      `${draft.pickerShotClockSeconds}s`,
      () => step("pickerShotClockSeconds", -clock.step, clock.min, clock.max),
      () => step("pickerShotClockSeconds", clock.step, clock.min, clock.max),
      SETTING_HINTS.pickerShotClockSeconds,
    )}
    ${toggle(
      "Highlight Banned Letter",
      draft.highlightBannedLetters,
      (v) => set("highlightBannedLetters", v),
      SETTING_HINTS.highlightBannedLetters,
    )}
  `;
};
