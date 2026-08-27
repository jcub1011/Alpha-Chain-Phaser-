// @vitest-environment happy-dom
//
// What the settings panel actually contains, per lobby and per mode.
//
// Both lobbies used to hand-render ~20 identical rows each; they now render from
// settings-sections.ts. These pin the full row list so that move — and any later edit to it —
// cannot silently drop a setting: a missing row leaves the host unable to configure something
// that is still very much in DEFAULT_SETTINGS and still very much affects the match, and nothing
// else in the suite would notice.
//
// Labels, not keys, because a label is what the host actually has to find.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../game/settings";
import { GameMode } from "../../game/types";
import type { AlphaChainSettings } from "../../game/types";
import type { ServerController } from "../../net/serverController";
import "./ac-lobby";
import "./ac-net-lobby";
import type { AcLobby } from "./ac-lobby";
import type { AcNetLobby } from "./ac-net-lobby";

/** The rules every lobby shows in Word Builder mode, in render order. */
const BUILDER_RULES = [
  "Game Mode",
  "Rack Size",
  "Word List",
  "Pick Timer",
  "Highlight Banned Letter",
  "Eras",
  "Rounds Per Era",
  "Countdown",
  "Survival Mode",
  "Letter Ban Mode",
  "Letter Ban Repeats",
  "Letter Ban Time",
  "Cards Per Era",
  "Start With Engine Cards",
  "Engine Management Time",
  "Common",
  "Uncommon",
  "Rare",
  "Legendary",
  "Starting Slots",
  "Slots Increase Every",
  "Slots Per Increase",
  "Max Slots",
];

/** Classic swaps the four Word Builder rows for its own shot clock, in the same section. */
const CLASSIC_RULES = BUILDER_RULES.flatMap((l) =>
  l === "Game Mode"
    ? [l, "Shot Clock"]
    : ["Rack Size", "Word List", "Pick Timer", "Highlight Banned Letter"].includes(l)
      ? []
      : [l],
);

const SOLO_PREFS = ["Opponents", "Difficulty", "Tutorials", "Engine Animation Duration"];
const NET_PREFS = ["Host Plays", "Tutorials", "Engine Animation Duration"];

/** Every settings-row label in the panel, in document order. Scoped to `.net-settings` so the
 *  multiplayer roster's own "Players" readout — which is not a setting — stays out of it. */
function labels(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".net-settings .set-label")].map(
    (n) => n.textContent?.trim() ?? "",
  );
}

function stubController(): ServerController {
  return {
    isOwner: true,
    ownerId: "p1",
    roster: [{ id: "p1", displayName: "One" }],
    lobbySettings: { ...DEFAULT_SETTINGS },
    onLobbyChange: () => () => undefined,
    setLobbySettings: () => undefined,
  } as unknown as ServerController;
}

async function mountSolo(settings: AlphaChainSettings): Promise<AcLobby> {
  const el = document.createElement("ac-lobby") as AcLobby;
  el.settings = settings;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

async function mountNet(settings: AlphaChainSettings): Promise<AcNetLobby> {
  const el = document.createElement("ac-net-lobby") as AcNetLobby;
  el.controller = stubController();
  el.settings = settings;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const builder: AlphaChainSettings = { ...DEFAULT_SETTINGS, gameMode: GameMode.Picker };
const classic: AlphaChainSettings = { ...DEFAULT_SETTINGS, gameMode: GameMode.Classic };

describe("settings panel rows", () => {
  beforeEach(() => (document.body.innerHTML = ""));

  it("solo lobby shows its preferences then every Word Builder rule", async () => {
    expect(labels(await mountSolo(builder))).toEqual([...SOLO_PREFS, ...BUILDER_RULES]);
  });

  it("solo lobby swaps in the Classic shot clock", async () => {
    expect(labels(await mountSolo(classic))).toEqual([...SOLO_PREFS, ...CLASSIC_RULES]);
  });

  it("multiplayer lobby shows the same rules, with its own preferences", async () => {
    expect(labels(await mountNet(builder))).toEqual([...NET_PREFS, ...BUILDER_RULES]);
  });

  it("multiplayer lobby swaps in the Classic shot clock", async () => {
    expect(labels(await mountNet(classic))).toEqual([...NET_PREFS, ...CLASSIC_RULES]);
  });

  it("shows the match rules identically in both lobbies", async () => {
    // The reason the sections were extracted at all: the two lists had already drifted in
    // order and content. Comparing them directly is what stops that happening again.
    const solo = labels(await mountSolo(builder)).filter((l) => !SOLO_PREFS.includes(l));
    document.body.innerHTML = "";
    const net = labels(await mountNet(builder)).filter((l) => !NET_PREFS.includes(l));
    expect(solo).toEqual(net);
  });

  it("names each row only once", async () => {
    const ls = labels(await mountSolo(builder));
    expect(ls).toEqual([...new Set(ls)]);
  });

  it("puts each band under its own heading", async () => {
    const el = await mountSolo(builder);
    const heads = [...el.querySelectorAll(".set-head")].map((n) => n.textContent?.trim());
    expect(heads).toEqual(["Presets", "Host Preferences", "Match Rules"]);
    const subs = [...el.querySelectorAll(".set-subhead")].map((n) => n.textContent?.trim());
    expect(subs).toEqual([
      "Mode & Words",
      "Match Length",
      "Banned Letters",
      "Engine Cards",
      "Rarity Weights",
      "Engine Bay Slots",
    ]);
  });
});
