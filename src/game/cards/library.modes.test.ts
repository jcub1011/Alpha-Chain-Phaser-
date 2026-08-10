/*
 * Per-mode card resolution: what may differ between modes, what may not, and the structural
 * guarantees that keep a Picker retune from reaching Classic.
 *
 * The companion to classic-lock.test.ts. That file pins Classic's absolute values; this one pins
 * the RELATIONSHIP between the modes — which is where a per-mode mechanism actually goes wrong.
 */

import { describe, expect, it } from "vitest";
import { makeBayEvaluator, armedClockSeconds } from "../scoring";
import { CardId, GameMode, type BayCard } from "../types";
import {
  CARD_CATALOGUE,
  cardIdentity,
  cardLibrary,
  dealableCardIds,
  getCard,
  tunedCardEntries,
} from "./library";
import { tuned, type TuneValue } from "./card";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));
const ids = () => Object.keys(CARD_CATALOGUE) as CardId[];

/** Cards that deliberately carry a Picker patch. Any addition must be a conscious edit here. */
const PATCHED = [CardId.TheVault, CardId.Redline, CardId.Speedracer] as const;

/** Fields that must be identical in every mode — the ones `CardIdentity` exposes mode-blind, and
 *  which every dealer and lobby number is computed from. */
const IDENTITY_FIELDS = [
  "id",
  "name",
  "family",
  "op",
  "rarity",
  "color",
  "maxInstances",
  "modes",
  "preference",
  "roomServices",
] as const;

describe("per-mode resolution — structure", () => {
  it("resolves an untuned card to the SAME OBJECT in both modes", () => {
    // Not merely equal: identical. An untuned entry is resolved once and shared, so those cards are
    // mode-invariant by construction rather than by luck.
    const classic = cardLibrary(GameMode.Classic);
    const picker = cardLibrary(GameMode.Picker);
    const tunedIds = new Set(tunedCardEntries().map(([id]) => id));
    const untuned = ids().filter((id) => !tunedIds.has(id));
    expect(untuned.length).toBeGreaterThan(40); // most of the catalogue
    for (const id of untuned) {
      expect(picker[id], id).toBe(classic[id]);
    }
  });

  it("hands `build` the BASE tune object itself in Classic, so a patch cannot touch it", () => {
    for (const [, entry] of tunedCardEntries()) {
      // Freezing the base would be indistinguishable; identity is the real claim.
      const before = { ...entry.tune };
      cardLibrary(GameMode.Classic); // already built, but re-reading must not mutate
      expect(entry.tune).toEqual(before);
    }
  });

  it("keeps every mode-invariant field equal across modes, for all 54 cards", () => {
    // This is what licenses `cardIdentity` being mode-blind, and therefore what licenses the
    // dealer, the lobby capacity warning and the bubbling checks never naming a mode.
    for (const id of ids()) {
      const c = cardLibrary(GameMode.Classic)[id];
      const p = cardLibrary(GameMode.Picker)[id];
      for (const field of IDENTITY_FIELDS) {
        expect(p[field], `${id}.${field}`).toEqual(c[field]);
      }
    }
  });

  it("exposes exactly the documented set of per-mode patches", () => {
    const patched = tunedCardEntries()
      .filter(([, e]) => e.perMode?.[GameMode.Picker] !== undefined)
      .map(([id]) => id)
      .sort();
    expect(patched).toEqual([...PATCHED].sort());
  });

  it("resolves any id in any mode — parameterized, never filtered", () => {
    // Dealability is `dealableCardIds`'s job. A card in a bay, a replay or the gallery must resolve
    // whatever mode is running, or those surfaces would render blanks.
    for (const id of ids()) {
      expect(getCard(id, GameMode.Classic), id).toBeDefined();
      expect(getCard(id, GameMode.Picker), id).toBeDefined();
    }
    expect(getCard("NotACard", GameMode.Classic)).toBeUndefined();
  });

  it("returns a stable object per mode, so identity comparisons and memoization hold", () => {
    expect(getCard(CardId.Redline, GameMode.Picker)).toBe(getCard(CardId.Redline, GameMode.Picker));
    expect(cardLibrary(GameMode.Picker)).toBe(cardLibrary(GameMode.Picker));
  });

  it("gives `cardIdentity` the same values the resolved cards carry", () => {
    for (const id of ids()) {
      expect(cardIdentity(id)?.rarity, id).toBe(cardLibrary(GameMode.Classic)[id].rarity);
    }
  });
});

describe("per-mode resolution — parity and its converse", () => {
  /** A card's mode-visible surface, excluding the identity fields checked above. */
  const surface = (id: CardId, mode: GameMode): string => {
    const c = cardLibrary(mode)[id];
    return [
      c.magnitudeText,
      c.description,
      c.clock ? `${c.clock.pctDelta ?? 0}/${c.clock.flatDelta ?? 0}` : "-",
      armedClockSeconds(20, bay(id), mode),
      c.timeoutFold ? foldChip(id, mode, true) : "-",
      foldChip(id, mode, false),
    ].join(" | ");
  };

  const foldChip = (id: CardId, mode: GameMode, timeout: boolean): string => {
    const ev = makeBayEvaluator("basketball", bay(id), {
      mode,
      prevWordLength: 0,
      clockRemaining: 20,
      clockTotal: 20,
      taxed: false,
    });
    const card = ev.resolved[0]!;
    const fn = timeout ? card.timeoutFold : card.fold;
    if (!fn) return "-";
    const r = fn.call(card, 10, ev.ctxFor(0));
    return `${r.valueText}@${r.value}`;
  };

  it("is identical across modes for every card WITHOUT a Picker patch", () => {
    for (const id of ids()) {
      if ((PATCHED as readonly string[]).includes(id)) continue;
      expect(surface(id, GameMode.Picker), id).toBe(surface(id, GameMode.Classic));
    }
  });

  it("DIFFERS across modes for every card WITH one — a patch that changes nothing is dead", () => {
    // The important half. A patch naming a knob `build` never reads would look like a balance
    // change in review and be none, and only this direction catches it.
    for (const id of PATCHED) {
      expect(surface(id, GameMode.Picker), id).not.toBe(surface(id, GameMode.Classic));
    }
  });
});

describe("tuning is load-bearing — every declared knob must reach the rendered card", () => {
  const perturb = (v: TuneValue): TuneValue =>
    typeof v === "number" ? v * 1.5 + 1 : typeof v === "boolean" ? !v : `${v}x`;

  /** Everything a knob could plausibly drive, rendered from a freshly built card. */
  const signature = (
    card: ReturnType<ReturnType<typeof tunedCardEntries>[0][1]["build"]>,
  ): string => {
    const ev = makeBayEvaluator("basketball", bay(CardId.TheAnchor), {
      mode: GameMode.Classic,
      prevWordLength: 0,
      clockRemaining: 20,
      clockTotal: 20,
      taxed: false,
    });
    const ctx = ev.ctxFor(0);
    const fold = card.fold(10, ctx);
    const timeout = card.timeoutFold?.(-10, ctx);
    return [
      card.magnitudeText,
      card.description,
      card.clock ? `${card.clock.pctDelta ?? 0}/${card.clock.flatDelta ?? 0}` : "-",
      card.preference?.redraw?.clockCostFraction ?? "-",
      `${fold.valueText}@${fold.value}`,
      timeout ? `${timeout.valueText}@${timeout.value}` : "-",
    ].join(" | ");
  };

  for (const [id, entry] of tunedCardEntries()) {
    for (const knob of Object.keys(entry.tune)) {
      it(`${id}: ${knob} changes the card`, () => {
        const base = signature(entry.build(entry.tune));
        const moved = signature(entry.build({ ...entry.tune, [knob]: perturb(entry.tune[knob]) }));
        expect(moved).not.toBe(base);
      });
    }
  }
});

describe("Picker copy is honest about the timeout penalty", () => {
  it("advertises no timeout penalty on any card Picker actually deals", () => {
    // Picker never calls scoreTimeout (match.ts pickerTimeoutCurrent), so every timeoutFold is
    // unreachable there and a card promising a timeout loss is lying to the player.
    //
    // Scoped to the DEALABLE pool, not the whole library: The Blindfold and Insurance both mention
    // timeouts and both are `modes: [Classic]`, so they can never reach a Picker bay — and they are
    // withheld precisely BECAUSE Picker has no timeout penalty (picker-gdd §4.4). A card that
    // cannot be dealt in a mode cannot mislead anyone playing it, and rewriting its Classic prose
    // to satisfy a Picker check would be the tail wagging the dog.
    const lying = dealableCardIds(GameMode.Picker)
      .map((id) => cardLibrary(GameMode.Picker)[id])
      .filter((c) => /time\s?d?\s?out/i.test(c.description))
      .map((c) => c.id);
    expect(lying).toEqual([]);
  });

  it("withholds the two remaining timeout-mentioning cards from Picker entirely", () => {
    // The other half of the guarantee above: they are absent, not reworded.
    const pickerPool = new Set<string>(dealableCardIds(GameMode.Picker));
    expect(pickerPool.has(CardId.Blindfold)).toBe(false);
    expect(pickerPool.has(CardId.Insurance)).toBe(false);
  });

  it("keeps the penalty clause in Classic, where it does fire", () => {
    for (const id of PATCHED) {
      expect(cardLibrary(GameMode.Classic)[id].description, id).toMatch(/Time out and lose \d+/);
    }
  });

  it("makes the unreachable drain inert in Picker, from the same number as the prose", () => {
    for (const id of PATCHED) {
      const card = cardLibrary(GameMode.Picker)[id];
      const ev = makeBayEvaluator("", bay(id), {
        mode: GameMode.Picker,
        prevWordLength: 0,
        clockRemaining: 0,
        clockTotal: 20,
        taxed: false,
      });
      const r = card.timeoutFold!.call(card, -10, ev.ctxFor(0));
      expect(r.triggered, id).toBe(false);
      expect(r.value, id).toBe(-10); // untouched
    }
  });

  it("leaves the Classic drain firing at its documented magnitude", () => {
    for (const [id, loss] of [
      [CardId.TheVault, 12],
      [CardId.Redline, 24],
      [CardId.Speedracer, 10],
    ] as const) {
      const card = cardLibrary(GameMode.Classic)[id];
      const ev = makeBayEvaluator("", bay(id), {
        mode: GameMode.Classic,
        prevWordLength: 0,
        clockRemaining: 0,
        clockTotal: 20,
        taxed: false,
      });
      const r = card.timeoutFold!.call(card, -10, ev.ctxFor(0));
      expect(r.triggered, id).toBe(true);
      expect(r.value, id).toBe(-10 - loss);
    }
  });
});

describe("structural guards (these are compile-time; the assertions only document them)", () => {
  it("rejects a Classic patch and an unknown knob", () => {
    const def = tuned({
      tune: { x: 1 },
      perMode: {
        // @ts-expect-error — Classic is not a patchable mode: the base tune IS Classic's values.
        classic: { x: 2 },
      },
      build: (t) => ({
        name: "T",
        rarity: "common",
        family: "letter",
        op: "additive",
        magnitudeText: `${t.x}`,
        description: `${t.x}`,
        fold: (v) => ({ triggered: true, value: v, valueText: "FX" }),
      }),
    });
    expect(def.tune.x).toBe(1);

    tuned({
      tune: { x: 1 },
      perMode: {
        // @ts-expect-error — an unknown knob in a patch is a typo, not a new knob.
        picker: { y: 2 },
      },
      build: (t) => ({
        name: "T",
        rarity: "common",
        family: "letter",
        op: "additive",
        magnitudeText: `${t.x}`,
        description: `${t.x}`,
        fold: (v) => ({ triggered: true, value: v, valueText: "FX" }),
      }),
    });
  });

  it("keeps no `classic` key in any shipped patch", () => {
    for (const [id, entry] of tunedCardEntries()) {
      expect(Object.keys(entry.perMode ?? {}), id).not.toContain(GameMode.Classic);
    }
  });
});
