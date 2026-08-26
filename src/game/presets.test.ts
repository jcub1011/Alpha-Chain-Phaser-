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

import { html } from "lit";
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
import { GameMode } from "./types";
import type { SettingControls } from "../ui/views/setting-controls";
import { HOST_PREFERENCE_KEYS, renderMatchRules } from "../ui/views/settings-sections";
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

  it("gives every match rule a row in the panel, and every row a match rule", () => {
    /* The missing half of the boundary, and the one that actually bit.
     *
     * The case above pins that every EXCLUDED key is reachable. Nothing pinned the converse — that
     * every key a preset OWNS is reachable too — so `offerCount` and `builderShotClockSeconds` both
     * sat in DEFAULT_SETTINGS, both got written by presets, and neither had a control in either
     * lobby after the Offer-size stepper became "Rack Size". A host could not see them, could not
     * change them, and the engine went on reading them: `offerCount` sized an Offer nobody could
     * look at, and `builderShotClockSeconds` fed bots a clock the match never armed.
     *
     * Observed by RENDERING the real band and recording which keys its rows write, rather than by
     * comparing against a hand-kept list — a second list is just a second thing to drift. */
    const reachable = new Set<string>();
    for (const gameMode of [GameMode.Picker, GameMode.Classic]) {
      const callbacks: (() => void)[] = [];
      const stub = html`<i></i>`;
      const probe: SettingControls = {
        step: (key) => void reachable.add(key as string),
        set: (key) => void reachable.add(key as string),
        stepper: (_label, _value, onMinus, onPlus) => {
          callbacks.push(onMinus, onPlus);
          return stub;
        },
        // Every option, not just the current one: a segmented row whose handler switches on the
        // value could otherwise write a different key per option.
        segmented: ((
          _label: string,
          _current: string,
          options: { value: string }[],
          onPick: (v: string) => void,
        ) => {
          for (const o of options) callbacks.push(() => onPick(o.value));
          return stub;
        }) as SettingControls["segmented"],
        toggle: (_label, _on, set) => {
          callbacks.push(() => set(true));
          return stub;
        },
      };
      // lit evaluates a template's interpolations eagerly, so the rows are built — and their
      // handlers captured — by this call alone. No DOM required.
      renderMatchRules({ ...DEFAULT_SETTINGS, gameMode }, probe);
      for (const cb of callbacks) cb();
    }

    // Both modes' rows together, because the mode rows are an either/or.
    expect(PRESET_KEYS.filter((k) => !reachable.has(k))).toEqual([]);
    expect([...reachable].filter((k) => !PRESET_KEYS.includes(k as never))).toEqual([]);
  });
});
