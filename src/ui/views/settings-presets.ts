/*
 * The preset bar at the top of the settings panel — one chip per preset, plus the Custom chip.
 *
 * A free function taking the lobby's own `apply`, for the same reason renderPickerSettings and
 * renderRarityWeights are: both lobbies render an identical bar, and a copy in each is how the
 * two panels drift apart.
 *
 * The active chip is DERIVED from the draft on every render via `detectPreset`, never stored.
 * That is the whole design: there is no preset field to persist, to sanitize, to put on the wire
 * or to forget to clear — so the bar cannot claim "Quick Match" while the settings say otherwise,
 * it survives a reload for free, and a multiplayer guest lights the owner's chip straight off the
 * replicated settings.
 *
 * Copy lives here rather than in game/presets.ts, matching how SETTING_HINTS holds the lobby's
 * explanatory copy while the settings themselves live in the engine.
 */

import { html, type TemplateResult } from "lit";
import { detectPreset, PresetId, SETTINGS_PRESETS } from "../../game/presets";
import type { AlphaChainSettings } from "../../game/types";
import { SETTING_GROUP_HINTS } from "./settings-hints";

/** Chip labels. An exhaustive Record, so a preset added without a label is a compile error —
 *  the same guarantee SETTING_HINTS gives for settings rows. */
export const PRESET_LABELS: Record<PresetId, string> = {
  [PresetId.Normal]: "Normal",
  [PresetId.OldSchool]: "Old-School",
  [PresetId.QuickMatch]: "Quick Match",
  [PresetId.Marathon]: "Marathon",
  [PresetId.CardStorm]: "Card Storm",
  [PresetId.SuddenDeath]: "Sudden Death",
};

/** The line under the bar describing whichever preset is active. Exhaustive for the same
 *  reason as PRESET_LABELS. */
export const PRESET_BLURBS: Record<PresetId, string> = {
  [PresetId.Normal]: "The standard match. Four eras, a nine-tile rack, and a 25-second clock.",
  [PresetId.OldSchool]:
    "The original typing race. No rack and no offers — think of the word yourself and type it against the clock.",
  [PresetId.QuickMatch]:
    "About ten minutes. Two short eras and a faster clock, with engine cards dealt up front so your engine is worth something before it all ends.",
  [PresetId.Marathon]:
    "The long game. Eight eras deals you far more cards than your bay can ever hold, so the match is really about what you cut.",
  [PresetId.CardStorm]:
    "Engines first. Five cards an era, a wide bay to put them in, and rarity flattened so Rares and Legendaries actually turn up.",
  [PresetId.SuddenDeath]:
    "One timeout and you are out. Short clock, thin rack, the full 386,000-word list, and no banned letter ever comes back.",
};

/** Shown when the settings match no preset. */
const CUSTOM_BLURB = "Your own mix. Pick a preset above to start from something else.";

/**
 * The preset bar. `apply` is the lobby's own mutator, so persistence and — in the multiplayer
 * lobby — the owner-only settings push happen through the path a stepper already uses.
 *
 * `readOnly` disables every chip for a guest, matching every other control in the panel. The
 * active chip still lights, so a guest can see which preset the owner chose.
 */
export const renderSettingsPresets = (
  draft: AlphaChainSettings,
  apply: (id: PresetId) => void,
  readOnly = false,
): TemplateResult => {
  const active = detectPreset(draft);
  return html`
    <div class="set-presets">
      <p class="set-head">Presets</p>
      <p class="set-groupdesc">${SETTING_GROUP_HINTS.presets}</p>
      <div class="seg" role="group" aria-label="Settings presets">
        ${SETTINGS_PRESETS.map(
          (p) => html`
            <button
              class="seg-btn ${active === p.id ? "is-on" : ""}"
              ?disabled=${readOnly}
              aria-pressed=${active === p.id}
              @click=${() => apply(p.id)}
            >
              ${PRESET_LABELS[p.id]}
            </button>
          `,
        )}
        <!-- State, not a control: there is nothing to apply, because Custom IS whatever the
             rows currently say. Deliberately NOT a <button>: one with aria-disabled but no
             disabled attribute is still focusable and still clickable, so it took a tab stop and
             did nothing — and kept taking it for a guest while every real control was disabled.
             A span with role="status" stays in the accessibility tree, which is the point: a
             screen-reader user needs to hear that a preset stopped being active just as much as a
             sighted one needs to see it. -->
        <span class="seg-btn ${active === null ? "is-on" : ""}" role="status">custom</span>
      </div>
      <p class="set-desc">${active === null ? CUSTOM_BLURB : PRESET_BLURBS[active]}</p>
    </div>
  `;
};
