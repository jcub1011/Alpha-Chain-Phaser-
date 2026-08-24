// @vitest-environment happy-dom
//
// <ac-net-lobby>'s settings publish. The lobby is only read-only-correct for other
// players if the owner's working settings actually reach the authority, and ownership
// isn't known at mount — it arrives with the peer's `ready` frame, after the element's
// own push sites have already run. These pin the edge-triggered push that covers that
// gap, and the reason it must stay edge-triggered: a push loops back as a snapshot that
// re-fires the very callback doing the pushing.
import { describe, expect, it } from "vitest";
import { detectPreset, PresetId } from "../../game/presets";
import { DEFAULT_SETTINGS } from "../../game/settings";
import { PRESET_LABELS } from "./settings-presets";
import type { AlphaChainSettings } from "../../game/types";
import type { ServerController } from "../../net/serverController";
import "./ac-net-lobby";
import type { AcNetLobby } from "./ac-net-lobby";

/** The owner's persisted settings — deliberately unlike DEFAULT_SETTINGS, so a test can
 *  tell "the owner published their own choices" from "nobody published anything". Carries a
 *  non-default host preference too (see the preset case at the bottom). */
const PERSISTED: AlphaChainSettings = {
  ...DEFAULT_SETTINGS,
  eraCount: 5,
  shotClockSeconds: 42,
  hostPlays: false,
  enableTutorials: false,
};

/** The slice of ServerController the view reads, with the lobby-change callback exposed
 *  so a test can fire it the way applyServerState/onReady do. */
function stubController() {
  const pushes: AlphaChainSettings[] = [];
  let cb: (() => void) | undefined;
  const stub = {
    isOwner: false,
    ownerId: "p1" as string | null,
    roster: [
      { id: "p1", displayName: "One" },
      { id: "p2", displayName: "Two" },
    ],
    lobbySettings: { ...DEFAULT_SETTINGS } as AlphaChainSettings | undefined,
    onLobbyChange(fn: () => void) {
      cb = fn;
      return () => (cb = undefined);
    },
    setLobbySettings(s: AlphaChainSettings) {
      // Mirrors the real controller: non-owners are refused before anything is sent.
      if (!stub.isOwner) return;
      pushes.push(s);
    },
  };
  return { stub, pushes, fireLobbyChange: (): void => cb?.() };
}

async function mount(stub: ReturnType<typeof stubController>["stub"]): Promise<AcNetLobby> {
  const el = document.createElement("ac-net-lobby") as AcNetLobby;
  el.controller = stub as unknown as ServerController;
  el.settings = { ...PERSISTED };
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("<ac-net-lobby> settings publish", () => {
  it("publishes the owner's settings once ownership becomes known", async () => {
    const { stub, pushes, fireLobbyChange } = stubController();
    const el = await mount(stub);
    expect(pushes).toEqual([]); // `ready` hasn't landed — isOwner still false, nothing sent

    stub.isOwner = true; // the Ready frame arrives...
    fireLobbyChange(); // ...and ServerController.onReady calls notifyLobby

    expect(pushes.length).toBe(1);
    // The owner's OWN persisted settings, not the authority's stock defaults — the whole
    // point: other players render this copy.
    expect(pushes[0].eraCount).toBe(5);
    expect(pushes[0].shotClockSeconds).toBe(42);
    await el.updateComplete;
  });

  it("does not re-publish on later lobby changes (the push must not feed itself)", async () => {
    const { stub, pushes, fireLobbyChange } = stubController();
    await mount(stub);
    stub.isOwner = true;
    fireLobbyChange();
    expect(pushes.length).toBe(1);

    // Each push loops back as an authoritative snapshot → notifyLobby → this callback.
    // Level-triggering here would recurse forever; the ownership edge must swallow these.
    fireLobbyChange();
    fireLobbyChange();
    expect(pushes.length).toBe(1);
  });

  it("mirrors the owner's settings into a non-owner's read-only draft", async () => {
    const { stub, pushes, fireLobbyChange } = stubController();
    stub.lobbySettings = { ...DEFAULT_SETTINGS, eraCount: 3 };
    const el = await mount(stub); // stays a non-owner
    fireLobbyChange();
    await el.updateComplete;

    expect(pushes).toEqual([]); // non-owners never publish
    expect(el.querySelector(".set-readonly-note")).not.toBeNull();
    expect(el.querySelector(".lobby-start")).toBeNull(); // no START MATCH for a non-owner
  });

  it("publishes a preset's match rules while keeping the owner's own preferences", async () => {
    const { stub, pushes, fireLobbyChange } = stubController();
    const el = await mount(stub);
    stub.isOwner = true;
    fireLobbyChange();
    await el.updateComplete;

    const chip = [...el.querySelectorAll<HTMLButtonElement>(".set-presets .seg-btn")].find(
      (b) => b.textContent?.trim() === PRESET_LABELS[PresetId.QuickMatch],
    );
    expect(chip).toBeDefined();
    chip?.click();
    await el.updateComplete;

    const sent = pushes[pushes.length - 1];
    expect(sent.eraCount).toBe(2); // the preset's rules replaced the persisted eraCount: 5
    expect(sent.dealEngineCardsFirstEra).toBe(true);
    // ...but the host's own preferences are not the preset's to change.
    expect(sent.hostPlays).toBe(false);
    expect(sent.enableTutorials).toBe(false);
    expect(detectPreset(sent)).toBe(PresetId.QuickMatch);
  });

  it("reports Custom once the owner edits a rule away from a preset", async () => {
    const { stub, pushes, fireLobbyChange } = stubController();
    const el = await mount(stub);
    stub.isOwner = true;
    fireLobbyChange();
    await el.updateComplete;

    const chips = (): HTMLButtonElement[] => [
      ...el.querySelectorAll<HTMLButtonElement>(".set-presets .seg-btn"),
    ];
    chips()
      .find((b) => b.textContent?.trim() === PRESET_LABELS[PresetId.Marathon])
      ?.click();
    await el.updateComplete;
    expect(
      chips()
        .find((b) => b.classList.contains("is-on"))
        ?.textContent?.trim(),
    ).toBe(PRESET_LABELS[PresetId.Marathon]);

    // Nudge any match rule and the bar has to stop claiming Marathon.
    el.querySelector<HTMLButtonElement>('[aria-label="increase Eras"]')?.click();
    await el.updateComplete;
    expect(
      chips()
        .find((b) => b.classList.contains("is-on"))
        ?.textContent?.trim(),
    ).toBe("custom");
    expect(detectPreset(pushes[pushes.length - 1])).toBeNull();
  });
});
