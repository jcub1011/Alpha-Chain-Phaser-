/*
 * The presets, and the boundary they share with the lobby's Host Preferences band.
 *
 * Two things here are load-bearing beyond the obvious round-trips. First, every preset value has
 * to survive `sanitizeSettings` unchanged: rejection is silent by design (see settings.ts), so an
 * out-of-range number in a preset would apply, look right in the lobby, and then be quietly reset
 * to the default the next time the settings were loaded or sent over the wire. Second, the set of
 * keys a preset refuses to touch and the set of rows the lobby files under "Host Preferences" are
 * the same boundary written in two files — if they drift, the panel starts lying about what a
 * preset will do to it.
 */

import { describe, expect, it } from "vitest";
import { dealPoolCapacity } from "./cards/library";
import {
  applyPreset,
  detectPreset,
  PRESET_EXCLUDED_KEYS,
  PRESET_KEYS,
  PresetId,
  presetSettings,
  SETTINGS_PRESETS,
} from "./presets";
import {
  DEFAULT_SETTINGS,
  rarityDealWeights,
  sanitizeSettings,
  totalCardsDealtPerPlayer,
} from "./settings";
import { HOST_PREFERENCE_KEYS } from "../ui/views/settings-sections";
import type { AlphaChainSettings } from "./types";

const ALL_IDS = SETTINGS_PRESETS.map((p) => p.id);

/** A full settings object as a preset would leave it, starting from the stock defaults. */
const applied = (id: PresetId): AlphaChainSettings => applyPreset(DEFAULT_SETTINGS, id);

describe("preset definitions", () => {
  it("covers every preset id exactly once, with normal first", () => {
    expect(ALL_IDS).toEqual([...new Set(ALL_IDS)]);
    expect(new Set(ALL_IDS)).toEqual(new Set(Object.values(PresetId)));
    // detectPreset returns the FIRST match, so normal must lead or stock defaults could
    // resolve to some other preset that happens to be equivalent.
    expect(ALL_IDS[0]).toBe(PresetId.Normal);
  });

  it.each(ALL_IDS)("%s holds only in-range values", (id) => {
    const s = applied(id);
    // sanitizeSettings REJECTS an out-of-range value back to the default rather than
    // clamping it, and says nothing while doing so — an unchanged round-trip is the only
    // evidence that every value here is actually acceptable to the validators.
    expect(sanitizeSettings(s)).toEqual(s);
  });

  it("normal is exactly the stock defaults", () => {
    expect(applied(PresetId.Normal)).toEqual(DEFAULT_SETTINGS);
  });

  it("presets are pairwise distinct across the match rules", () => {
    const fingerprints = ALL_IDS.map((id) => JSON.stringify(presetSettings(id)));
    expect(new Set(fingerprints).size).toBe(ALL_IDS.length);
  });

  it.each(ALL_IDS)("%s deals no more cards than its enabled tiers can supply", (id) => {
    const s = applied(id);
    // Mode-scoped on both sides, because the dealer filters the pool by mode. A preset that
    // asked for more cards than the pool holds would silently deal nothing in later
    // intermissions — the same condition the lobby warns about for hand-made settings.
    const capacity = dealPoolCapacity(rarityDealWeights(s), s.gameMode);
    expect(totalCardsDealtPerPlayer(s)).toBeLessThanOrEqual(capacity);
  });
});

describe("applyPreset / detectPreset", () => {
  it("detects the stock defaults as normal", () => {
    expect(detectPreset(DEFAULT_SETTINGS)).toBe(PresetId.Normal);
  });

  it.each(ALL_IDS)("round-trips %s", (id) => {
    expect(detectPreset(applied(id))).toBe(id);
  });

  it("reports Custom once any match rule is changed", () => {
    const s = { ...applied(PresetId.QuickMatch), eraCount: 7 };
    expect(detectPreset(s)).toBeNull();
  });

  it("keeps the preset when a host preference is changed", () => {
    // The whole point of the excluded set: your bot count and your tutorial setting are not
    // part of what "Card Storm" means, so changing them must not read as Custom.
    const s: AlphaChainSettings = {
      ...applied(PresetId.CardStorm),
      botCount: 5,
      botDifficulty: "hard",
      enableTutorials: false,
      hostPlays: false,
      engineAnimationSeconds: 3,
    };
    expect(detectPreset(s)).toBe(PresetId.CardStorm);
  });

  it("leaves host preferences untouched when applying a preset", () => {
    const mine: AlphaChainSettings = {
      ...DEFAULT_SETTINGS,
      botCount: 4,
      botDifficulty: "hard",
      enableTutorials: false,
      hostPlays: false,
      engineAnimationSeconds: 2.5,
    };
    const after = applyPreset(mine, PresetId.SuddenDeath);
    for (const key of Object.keys(PRESET_EXCLUDED_KEYS) as (keyof AlphaChainSettings)[]) {
      expect(after[key]).toEqual(mine[key]);
    }
    expect(after.survivalMode).toBe(true); // ...while the match rules did change
  });
});

describe("the host-preference boundary", () => {
  it("partitions every setting into exactly one of the two sets", () => {
    const excluded = Object.keys(PRESET_EXCLUDED_KEYS);
    expect([...PRESET_KEYS, ...excluded].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(PRESET_KEYS.filter((k) => excluded.includes(k))).toEqual([]);
  });

  it("shows every excluded key in some lobby, and no match rule among them", () => {
    // If these drift, either a setting a preset refuses to touch becomes unreachable by hand,
    // or a match rule gets filed under "Host Preferences" where a preset then overwrites it
    // behind a heading promising it would not.
    const shown = new Set([...HOST_PREFERENCE_KEYS.solo, ...HOST_PREFERENCE_KEYS.net]);
    expect([...shown].sort()).toEqual(Object.keys(PRESET_EXCLUDED_KEYS).sort());
    expect(PRESET_KEYS.filter((k) => shown.has(k as never))).toEqual([]);
  });
});
