/*
 * The row primitives a lobby lends to a shared settings section, and the bundle it passes them in.
 *
 * These types used to live split across rarity-weights.ts (SettingStepper) and picker-settings.ts
 * (SettingSegmented, SettingToggle). They are collected here because settings-sections.ts imports
 * BOTH of those modules, so the shared bundle could not live in either without a cycle.
 *
 * Why the primitives are lent rather than defined once here: <ac-lobby> and <ac-net-lobby> render
 * the same rows, but the multiplayer copy disables every control for a guest. Each lobby passes
 * its OWN stepper/segmented/toggle, so a shared section inherits that guest read-only behaviour
 * for free instead of having to know about ownership at all.
 */

import type { TemplateResult } from "lit";
import type { AlphaChainSettings } from "../../game/types";

/** A lobby's stepper renderer: label, readout, and the two ± handlers. */
export type SettingStepper = (
  label: string,
  value: string,
  onMinus: () => void,
  onPlus: () => void,
  hint?: string,
) => TemplateResult;

/** A lobby's segmented-control renderer, over a fixed set of options. */
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

/**
 * Everything a shared section needs from its host lobby, in one object.
 *
 * Bundled rather than passed as five positional arguments — which is what renderPickerSettings
 * did — because with five same-shaped function parameters a transposed pair still compiles, and
 * a section that later needs a sixth primitive would otherwise churn every call site.
 */
export interface SettingControls {
  /** Apply a delta to a numeric setting, clamped to [min, max]. */
  step: <K extends keyof AlphaChainSettings>(
    key: K,
    delta: number,
    min: number,
    max: number,
  ) => void;
  /** Set an enum/boolean setting outright. */
  set: <K extends keyof AlphaChainSettings>(key: K, value: AlphaChainSettings[K]) => void;
  stepper: SettingStepper;
  segmented: SettingSegmented;
  toggle: SettingToggle;
}
