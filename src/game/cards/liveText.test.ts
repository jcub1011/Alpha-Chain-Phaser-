import { describe, expect, it } from "vitest";
import { describeCardLive, type LiveCardCtx } from "./liveText";
import { getCard } from "./library";
import { scoreWord } from "../scoring";
import { BanLetterService, RoomServices } from "./roomServices";
import { GameMode, type PlayerState } from "../types";

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

/** At ×1 every plain template reproduces the static chip + prose byte-identically. */
const PLAIN_IDS = [
  "TheAnchor",
  "Vanilla",
  "ConsonantCrunch",
  "VocalVowels",
  "BrickLayer",
  "TheBlueprint",
  "LetterHoarder",
  "HighRoller",
  "Scavenger",
  "VowelSurge",
  "TheArchitect",
  "Sesquipedalian",
  "GutturalRoar",
  "PerfectLink",
  "Bookends",
  "TheLexicon",
  "Stonemason",
  "HeatSink",
  "Blindfold",
  "TunnelVision",
  "RouletteWheel",
  "MagnifyingGlass",
  "Forgery",
  "TheVault",
  "Redline",
  "Speedracer",
  "PanicButton",
  "ChronoSyphon",
  "Numismatist",
  "TryHard",
  "DoubleDown",
  "Tilesmith",
  "TollBooth",
  "TaxCollector",
  "LoanShark",
  "TaxWriteOff",
  "TheSniper",
];

describe("describeCardLive", () => {
  it("falls back to static copy without context", () => {
    const card = getCard("Redline", GameMode.Classic)!;
    expect(describeCardLive("Redline", GameMode.Classic)).toEqual({
      magnitudeText: card.magnitudeText,
      description: card.description,
    });
  });

  it("renders static copy with context for cards without a template", () => {
    // No renderText: pure-FX / capability cards whose prose states no magnitude.
    for (const id of ["Catalyst", "Insurance", "IrsAgent", "BaitAndSwitch"]) {
      const card = getCard(id, GameMode.Classic)!;
      const live = describeCardLive(
        id,
        GameMode.Classic,
        base({ bayIds: [id], magnification: 1.5 }),
      );
      expect(live.magnitudeText, `${id} chip`).toBe(card.magnitudeText);
      expect(live.description, `${id} prose`).toBe(card.description);
      expect(live.badge, `${id} badge`).toBeUndefined();
    }
  });

  it("reproduces the static copy at ×1 for plain templates", () => {
    for (const id of PLAIN_IDS) {
      const card = getCard(id, GameMode.Classic)!;
      const live = describeCardLive(id, GameMode.Classic, base({ bayIds: [id] }));
      expect(live.magnitudeText, `${id} chip`).toBe(card.magnitudeText);
      expect(live.description, `${id} prose`).toBe(card.description);
    }
  });

  it("folds the glass into the multiplier chip and prose", () => {
    const live = describeCardLive("Redline", GameMode.Classic, base({ magnification: 2.25 }));
    expect(live.magnitudeText).toBe("×4.5");
    expect(live.description).toContain("×4.5 always");
    expect(live.description).toContain("lose 54 points");
  });

  it("compounds stacked glasses", () => {
    const live = describeCardLive("VowelSurge", GameMode.Classic, base({ magnification: 3.375 }));
    expect(live.magnitudeText).toBe("×10.13");
  });

  it("scales per-unit additives", () => {
    const live = describeCardLive("VocalVowels", GameMode.Classic, base({ magnification: 2 }));
    expect(live.magnitudeText).toBe("+6/vwl");
    expect(live.description).toBe("+6/vowel; +8/vowel at 7+ letters.");
  });

  it("scales computed totals by the glass", () => {
    const booster = describeCardLive(
      "BoosterPack",
      GameMode.Classic,
      base({
        bayIds: ["BoosterPack", "Vanilla", "Vanilla"],
        index: 0,
        slots: 4,
        magnification: 1.5,
      }),
    );
    expect(booster.magnitudeText).toBe("+24");
    expect(booster.description).toContain("2 right × 4 slots = +24");

    const dividend = describeCardLive(
      "Dividend",
      GameMode.Classic,
      base({ bayIds: ["Sieve", "Dividend", "Vanilla"], index: 1, magnification: 2 }),
    );
    expect(dividend.magnitudeText).toBe("+8");

    const flywheel = describeCardLive(
      "TheFlywheel",
      GameMode.Classic,
      base({
        bayIds: ["TheFlywheel", "VowelSurge", "DoubleDown"],
        index: 0,
        magnification: 1.5,
      }),
    );
    expect(flywheel.magnitudeText).toBe("×1.95");

    const crescendo = describeCardLive(
      "Crescendo",
      GameMode.Classic,
      base({ streak: 2, magnification: 1.5 }),
    );
    expect(crescendo.magnitudeText).toBe("×2.25");
    expect(crescendo.badge).toBe("STREAK 2");
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

  it("names the effective glass output on a glassed glass", () => {
    const live = describeCardLive(
      "MagnifyingGlass",
      GameMode.Classic,
      base({ magnification: 1.5 }),
    );
    expect(live.description).toContain("×2.25");
  });

  it("names the glass on word-dynamic cards without resolving them", () => {
    for (const id of ["TryHard", "DoubleDown", "Numismatist", "Tilesmith"]) {
      const live = describeCardLive(id, GameMode.Classic, base({ magnification: 1.5 }));
      expect(live.description, id).toContain("(×1.5 glass)");
    }
  });

  it("scales timeout drains and clock chips", () => {
    const blind = describeCardLive("Blindfold", GameMode.Classic, base({ magnification: 2 }));
    expect(blind.description).toContain("lose 16 points");

    const vault = describeCardLive("TheVault", GameMode.Classic, base({ magnification: 1.5 }));
    expect(vault.magnitudeText).toBe("×2.25");
    expect(vault.clockText).toBe("−30% ⏱");

    const sniper = describeCardLive("TheSniper", GameMode.Classic, base({ magnification: 2 }));
    expect(sniper.description).toContain("40%");
  });

  it("prefers the projected step outcome when the staged word fires", () => {
    const live = describeCardLive(
      "Redline",
      GameMode.Classic,
      base({ magnification: 1.5, previewValueText: "×3", previewTriggered: true }),
    );
    expect(live.magnitudeText).toBe("×3");
  });

  it("keeps the resting chip when the staged word skips the card", () => {
    const live = describeCardLive(
      "Redline",
      GameMode.Classic,
      base({ previewValueText: "—", previewTriggered: false }),
    );
    expect(live.magnitudeText).toBe("×2");
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

  it("names the rolled personal ban", () => {
    const live = describeCardLive(
      "TollBooth",
      GameMode.Classic,
      base({ bayIds: ["TollBooth"], index: 0, personalBan: "q" }),
    );
    expect(live.description).toContain("ban: Q");
  });
});

describe("render/fold agreement", () => {
  // The resting face chip states the same total the fold banks on a triggering
  // probe word — the net that catches a template drifting from its fold.
  const bay = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));
  const opts = {
    mode: GameMode.Classic,
    prevWordLength: 0,
    clockRemaining: 20,
    clockTotal: 20,
    taxed: false as const,
  };

  it("flat and gated multipliers match their fired step", () => {
    const cases: { ids: string[]; word: string; index: number; mag: number }[] = [
      { ids: ["TheAnchor"], word: "cat", index: 0, mag: 1 },
      { ids: ["MagnifyingGlass", "VowelSurge"], word: "aei", index: 1, mag: 1.5 },
      { ids: ["MagnifyingGlass", "TheArchitect"], word: "abcdefgh", index: 1, mag: 1.5 },
      { ids: ["BoosterPack", "Vanilla", "Vanilla"], word: "cat", index: 0, mag: 1 },
      { ids: ["Sieve", "Dividend", "Vanilla"], word: "cat", index: 1, mag: 1 },
      { ids: ["TheFlywheel", "VowelSurge", "DoubleDown"], word: "aei", index: 0, mag: 1 },
    ];
    for (const { ids, word, index, mag } of cases) {
      const steps = scoreWord(word, bay(...ids), { ...opts, slots: 3, history: [] }).steps;
      const step = steps[index]!;
      expect(step.triggered, `${ids[index]} fires on "${word}"`).toBe(true);
      const live = describeCardLive(
        ids[index]!,
        GameMode.Classic,
        base({ bayIds: ids, index, slots: 3, magnification: mag }),
      );
      expect(live.magnitudeText, `${ids[index]} face`).toBe(step.valueText);
    }
  });

  it("glassed totals match their fired step", () => {
    const ids = ["MagnifyingGlass", "MagnifyingGlass", "VowelSurge"];
    const steps = scoreWord("aei", bay(...ids), { ...opts, slots: 3, history: [] }).steps;
    expect(steps[2]!.valueText).toBe("×6.75");
    const live = describeCardLive(
      "VowelSurge",
      GameMode.Classic,
      base({ bayIds: ids, index: 2, magnification: 2.25, slots: 3 }),
    );
    expect(live.magnitudeText).toBe("×6.75");
  });

  it("Crescendo matches its fired step on the live streak", () => {
    const services = new RoomServices(
      new BanLetterService(
        () => 0,
        () => "All",
        () => "e",
      ),
    );
    const player: PlayerState = {
      id: "p1",
      name: "You",
      isBot: false,
      accentIndex: 0,
      score: 0,
      eliminated: false,
      bay: [{ id: "Crescendo" }],
      slots: 3,
    };
    services.crescendoStreak.increment("p1");
    services.crescendoStreak.increment("p1");
    const steps = scoreWord("cat", player.bay, {
      ...opts,
      slots: 3,
      history: [],
      services,
      player,
    }).steps;
    expect(steps[0]!.valueText).toBe("×1.5");
    const live = describeCardLive(
      "Crescendo",
      GameMode.Classic,
      base({ bayIds: ["Crescendo"], index: 0, streak: 2 }),
    );
    expect(live.magnitudeText).toBe("×1.5");
  });
});
