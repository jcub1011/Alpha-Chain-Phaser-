import { describe, expect, it } from "vitest";
import { describeCardLive, type LiveCardCtx } from "./liveText";
import { getCard } from "./library";
import { GameMode } from "../types";

const base = (over: Partial<LiveCardCtx> = {}): LiveCardCtx => ({
  mode: GameMode.Classic,
  bayIds: [],
  index: 0,
  magnification: 1,
  slots: 3,
  streak: 0,
  wildcardAvailable: true,
  prismAvailable: true,
  winnowerAvailable: true,
  ...over,
});

describe("describeCardLive", () => {
  it("falls back to static copy without context", () => {
    const card = getCard("Redline", GameMode.Classic)!;
    expect(describeCardLive("Redline", GameMode.Classic)).toEqual({
      magnitudeText: card.magnitudeText,
      description: card.description,
    });
  });

  it("flags glass magnification without changing the resting chip", () => {
    const live = describeCardLive("Redline", GameMode.Classic, base({ magnification: 2.25 }));
    expect(live.magnitudeText).toBe("×2");
    expect(live.magnified).toBe(true);
  });

  it("prefers the projected step outcome when the staged word fires", () => {
    const live = describeCardLive(
      "Redline",
      GameMode.Classic,
      base({ magnification: 1.5, previewValueText: "×3", previewTriggered: true }),
    );
    expect(live.magnitudeText).toBe("×3");
    expect(live.magnified).toBe(true);
  });

  it("keeps the resting chip when the staged word skips the card", () => {
    const live = describeCardLive(
      "Redline",
      GameMode.Classic,
      base({ previewValueText: "—", previewTriggered: false }),
    );
    expect(live.magnitudeText).toBe("×2");
  });

  it("tracks the Crescendo streak with its cap", () => {
    expect(describeCardLive("Crescendo", GameMode.Classic, base()).magnitudeText).toBe("×1");
    expect(describeCardLive("Crescendo", GameMode.Classic, base({ streak: 2 })).magnitudeText).toBe(
      "×1.5",
    );
    const capped = describeCardLive("Crescendo", GameMode.Classic, base({ streak: 9 }));
    expect(capped.magnitudeText).toBe("×2");
    expect(capped.badge).toBe("STREAK 9");
    expect(capped.description).toContain("Streak 9");
  });

  it("badges guard charges (Wildcard / Prism / Winnower)", () => {
    expect(describeCardLive("Wildcard", GameMode.Classic, base()).badge).toBe("READY");
    const spent = describeCardLive(
      "Wildcard",
      GameMode.Classic,
      base({ wildcardAvailable: false }),
    );
    expect(spent.badge).toBe("SPENT");
    expect(spent.spent).toBe(true);
    const used = describeCardLive(
      "Wildcard",
      GameMode.Classic,
      base({ wildcardAvailable: false, wildcardUsed: true }),
    );
    expect(used.badge).toBe("USED");
    expect(describeCardLive("Prism", GameMode.Classic, base({ prismAvailable: false })).badge).toBe(
      "SPENT",
    );
    expect(
      describeCardLive("Winnower", GameMode.Classic, base({ winnowerAvailable: false })).badge,
    ).toBe("SPENT");
  });

  it("computes Booster Pack from cards-to-right and slots", () => {
    const live = describeCardLive(
      "BoosterPack",
      GameMode.Classic,
      base({ bayIds: ["BoosterPack", "Vanilla", "Vanilla"], index: 0, slots: 4 }),
    );
    expect(live.magnitudeText).toBe("+16");
    expect(live.description).toContain("2 right × 4 slots");
    const empty = describeCardLive(
      "BoosterPack",
      GameMode.Classic,
      base({ bayIds: ["Vanilla", "BoosterPack"], index: 1, slots: 4 }),
    );
    expect(empty.magnitudeText).toBe("+0");
  });

  it("hides inert Preference Cards from bay-size counts", () => {
    // Sieve is a scoring-inert Preference Card: invisible to Dividend, like the fold.
    const live = describeCardLive(
      "Dividend",
      GameMode.Classic,
      base({ bayIds: ["Sieve", "Dividend", "Vanilla"], index: 1 }),
    );
    expect(live.magnitudeText).toBe("+4");
  });

  it("computes Flywheel from the other multipliers", () => {
    const live = describeCardLive(
      "TheFlywheel",
      GameMode.Classic,
      base({ bayIds: ["TheFlywheel", "VowelSurge", "DoubleDown"], index: 0 }),
    );
    expect(live.magnitudeText).toBe("×1.3");
    const alone = describeCardLive(
      "TheFlywheel",
      GameMode.Classic,
      base({ bayIds: ["TheFlywheel", "Vanilla"], index: 0 }),
    );
    expect(alone.magnitudeText).toBe("—");
  });

  it("names the rolled personal ban", () => {
    const live = describeCardLive(
      "TollBooth",
      GameMode.Classic,
      base({ bayIds: ["TollBooth"], index: 0, personalBan: "q" }),
    );
    expect(live.description).toContain("ban: Q");
  });
});
