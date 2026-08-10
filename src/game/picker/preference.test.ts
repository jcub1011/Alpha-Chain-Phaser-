/*
 * Preference Cards — the family that shapes the Offer instead of scoring the word.
 *
 * Three things are pinned here, in rising order of how badly they'd fail silently:
 *   1. Each card actually shapes the Offer the way its text says.
 *   2. The inert ones are INVISIBLE to bay-size scoring — the Dividend / Booster Pack
 *      non-inflation regressions, which would otherwise read as a balance drift, not a bug.
 *   3. They bubble left, which is what makes a Magnifying Glass unable to target one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cardIdentity } from "../cards/library";
import { Dictionary } from "../dictionary";
import { scoreWord } from "../scoring";
import { CardOp, type BayCard } from "../types";
import { buildPoolIndex, generateOffer, type OfferRequest } from "./offer";
import { bubblePreferences, buildOfferShaping, isInertPreference, NO_SHAPING } from "./preference";
import { dictionaryWordPool } from "./wordPool";
import { GameMode } from "../types";

const REDUCED = readFileSync(
  path.resolve(__dirname, "../../../public/assets/words-common.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .map((w) => w.trim())
  .filter(Boolean);

const pool = dictionaryWordPool(new Dictionary(REDUCED));
const index = buildPoolIndex(pool);

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bay = (...ids: string[]): BayCard[] => ids.map((id, i) => ({ id, uid: `u${i}` }));
const cardsOf = (...ids: string[]) => ids.map((id) => cardIdentity(id));

/** Shaping built from a bay of card ids, with no bans in force unless given. */
const shapingOf = (ids: string[], bannedLetters: string[] = []) =>
  buildOfferShaping(cardsOf(...ids), { bannedLetters });

/** Offers generated over the real Reduced pool with the given cards in the bay. */
function offersWith(ids: string[], over: Partial<OfferRequest> = {}, runs = 40): string[][] {
  const out: string[][] = [];
  for (let s = 0; s < runs; s++) {
    out.push(
      generateOffer({
        pool,
        index,
        requiredLetter: "c",
        usedWords: new Set<string>(),
        count: 5,
        shaping: shapingOf(ids),
        rng: seeded(s + 1),
        ...over,
      }).words,
    );
  }
  return out;
}

describe("the family's shape", () => {
  const SEVEN = ["Sieve", "Winnower", "WideNet", "TunnelVision", "Prospector", "Tide", "Sentinel"];

  it("marks all seven as Preference Cards", () => {
    for (const id of SEVEN) expect(cardIdentity(id)?.preference, id).toBeDefined();
  });

  it("treats six as scoring-inert and Tunnel Vision as a real multiplier", () => {
    /* The GDD calls Tunnel Vision "FX, ×1.4", which cannot be both. It is modelled as what its
     * EFFECT says — hiding it from the scoring bay would delete the ×1.4 outright, and bubbling it
     * to the far left would leave the multiplier scaling almost nothing, since the fold runs
     * strictly left → right. So it is placed and counted like any other multiplier, and pays for
     * itself with −2 Offer Cards instead. */
    for (const id of SEVEN.filter((x) => x !== "TunnelVision")) {
      expect(isInertPreference(cardIdentity(id)), id).toBe(true);
    }
    expect(isInertPreference(cardIdentity("TunnelVision"))).toBe(false);
    expect(cardIdentity("TunnelVision")?.op).toBe(CardOp.Multiplicative);
  });

  it("scores nothing for the six inert ones", () => {
    for (const id of SEVEN.filter((x) => x !== "TunnelVision")) {
      const r = scoreWord("planets", bay(id), {
        mode: GameMode.Picker,
        prevWordLength: 0,
        clockRemaining: 10,
        clockTotal: 20,
        taxed: false,
      });
      expect(r.finalScore, id).toBe(7); // the bare word seed, untouched
    }
  });

  it("still scores ×1.4 for Tunnel Vision", () => {
    const r = scoreWord("planets", bay("TunnelVision"), {
      mode: GameMode.Picker,
      prevWordLength: 0,
      clockRemaining: 10,
      clockTotal: 20,
      taxed: false,
    });
    expect(r.finalScore).toBe(10); // 7 × 1.4
  });
});

describe("scoring invisibility", () => {
  // Picker: Preference Cards only ever occupy a bay in Picker, so that is the mode whose values
  // these non-inflation regressions must hold under.
  const opts = {
    mode: GameMode.Picker,
    prevWordLength: 0,
    clockRemaining: 10,
    clockTotal: 20,
    taxed: false,
  };
  const score = (ids: string[], slots?: number): number =>
    scoreWord("planets", bay(...ids), { ...opts, ...(slots ? { slots } : {}) }).finalScore;

  it("does not inflate Dividend (+2 per card in your bay)", () => {
    // THE regression. Dividend reads ctx.bayLength; if a Preference Card counted, holding one
    // would be +2 for free on every word, and the family would be upside rather than a trade.
    const alone = score(["Dividend"]);
    expect(score(["Sieve", "Dividend"])).toBe(alone);
    expect(score(["Sieve", "Prospector", "Tide", "Dividend"])).toBe(alone);
  });

  it("does not inflate Booster Pack (+2 per card to its right × slots)", () => {
    /* Booster Pack reads BOTH cardsToRight and slots, and bubbling puts every Preference Card to
     * its LEFT — so an unmasked cardsToRight would be wrong in the safe direction here, but the
     * slots fallback would still inflate. Both channels are checked. */
    const alone = score(["BoosterPack", "TheAnchor"]);
    expect(score(["Sieve", "BoosterPack", "TheAnchor"])).toBe(alone);
    expect(score(["Sieve", "Tide", "BoosterPack", "TheAnchor"])).toBe(alone);
  });

  it("keeps counting Tunnel Vision, because it really scores", () => {
    // The other half of the exception: it is a multiplier occupying a slot, so Dividend sees it.
    const alone = score(["Dividend"]);
    expect(score(["Dividend", "TunnelVision"])).toBeGreaterThan(alone);
  });

  it("leaves an explicit slots count alone", () => {
    // A caller-supplied `slots` is bay CAPACITY, not occupancy, so it is not masked.
    expect(score(["BoosterPack", "TheAnchor"], 5)).toBe(
      score(["Sieve", "BoosterPack", "TheAnchor"], 5),
    );
  });

  it("keeps the step walk aligned with the bay, so the replay still matches", () => {
    // Masking the SIZE channels rather than filtering the array is what preserves this: one step
    // per slot, in slot order. <ac-score-replay> and the HUD projection both index into it.
    const ids = ["Sieve", "TheAnchor", "Tide", "Dividend"];
    const r = scoreWord("planets", bay(...ids), opts);
    expect(r.steps.map((s) => s.cardId)).toEqual(ids);
  });
});

describe("bubbling", () => {
  const isPref = (id: string) => isInertPreference(cardIdentity(id));

  it("moves Preference Cards to the front, keeping scoring order intact", () => {
    const order = ["TheAnchor", "Sieve", "BoosterPack", "Tide", "Dividend"];
    expect(bubblePreferences(order, isPref)).toEqual([
      "Sieve",
      "Tide",
      "TheAnchor",
      "BoosterPack",
      "Dividend",
    ]);
  });

  it("is idempotent, so re-committing an already-bubbled bay is a no-op", () => {
    const once = bubblePreferences(["TheAnchor", "Sieve"], isPref);
    expect(bubblePreferences(once, isPref)).toEqual(once);
  });

  it("leaves a bay with no Preference Cards exactly as it was", () => {
    const order = ["Dividend", "TheAnchor", "BoosterPack"];
    expect(bubblePreferences(order, isPref)).toEqual(order);
  });

  it("does not bubble Tunnel Vision, which needs to sit right to be worth anything", () => {
    const order = ["TheAnchor", "TunnelVision"];
    expect(bubblePreferences(order, isPref)).toEqual(order);
  });

  it("makes a Magnifying Glass unable to target a Preference Card", () => {
    /* A glass magnifies slot i+1 unconditionally — there is no card-type check anywhere in the
     * registry, so position is the ONLY lever. Bubbling puts every Preference Card at an index
     * below every glass, and i+1 > i always, so the target can never land back in the block. */
    const bubbled = bubblePreferences(["MagnifyingGlass", "Sieve", "Tide", "TheAnchor"], isPref);
    const glass = bubbled.indexOf("MagnifyingGlass");
    for (const id of ["Sieve", "Tide"]) {
      expect(bubbled.indexOf(id)).toBeLessThan(glass);
      expect(bubbled.indexOf(id)).not.toBe(glass + 1);
    }
  });
});

describe("Sieve — only 6+ letter words", () => {
  it("filters every Offer Card", () => {
    for (const words of offersWith(["Sieve"])) {
      expect(words.length).toBe(5);
      for (const w of words) expect(w.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("is skipped rather than partially applied when the letter cannot serve it", () => {
    /* GDD §3.2: a filter that would drop the pool below the Offer count is skipped ENTIRELY, so the
     * picker can never soft-lock and the Offer is always full size. Here only short c-words exist. */
    const tiny = dictionaryWordPool(new Dictionary(["cat", "cog", "cub", "cap", "car", "melon"]));
    const r = generateOffer({
      pool: tiny,
      index: buildPoolIndex(tiny),
      requiredLetter: "c",
      usedWords: new Set(),
      count: 5,
      shaping: shapingOf(["Sieve"]),
      rng: seeded(3),
    });
    expect(r.words.length).toBe(5);
    expect(r.skippedFilters).toEqual(["Sieve"]);
  });

  it("skips deterministically", () => {
    // A resolution that varied between runs would desynchronise multiplayer.
    const tiny = dictionaryWordPool(new Dictionary(["cat", "cog", "cub", "cap", "car"]));
    const idx = buildPoolIndex(tiny);
    const run = () =>
      generateOffer({
        pool: tiny,
        index: idx,
        requiredLetter: "c",
        usedWords: new Set(),
        count: 4,
        shaping: shapingOf(["Sieve"]),
        rng: seeded(9),
      });
    expect(run().words).toEqual(run().words);
    expect(run().skippedFilters).toEqual(["Sieve"]);
  });
});

describe("Prospector — a rare letter is guaranteed", () => {
  it("always includes a word containing Q, X, Z or J", () => {
    for (const words of offersWith(["Prospector"], { requiredLetter: "" }, 25)) {
      expect(words.some((w) => /[qxzj]/.test(w))).toBe(true);
    }
  });

  it("spends a slot on it rather than growing the Offer", () => {
    for (const words of offersWith(["Prospector"], { requiredLetter: "" }, 10)) {
      expect(words.length).toBe(5);
    }
  });

  it("is skipped in silence when the letter has no rare word at all", () => {
    // Guarantees follow the same rule as filters: nothing a Preference Card asks for may shrink
    // the Offer.
    const tiny = dictionaryWordPool(
      new Dictionary(["cat", "cog", "cub", "cap", "car", "cost", "coat"]),
    );
    const r = generateOffer({
      pool: tiny,
      index: buildPoolIndex(tiny),
      requiredLetter: "c",
      usedWords: new Set(),
      count: 5,
      shaping: shapingOf(["Prospector"]),
      rng: seeded(4),
    });
    expect(r.words.length).toBe(5);
  });
});

describe("Sentinel — one guaranteed-safe word", () => {
  it("guarantees a word clean of every banned letter", () => {
    const shaping = shapingOf(["Sentinel"], ["a", "e"]);
    for (let s = 0; s < 25; s++) {
      const { words } = generateOffer({
        pool,
        index,
        requiredLetter: "",
        usedWords: new Set(),
        count: 5,
        shaping,
        rng: seeded(s + 1),
      });
      expect(words.some((w) => !w.includes("a") && !w.includes("e"))).toBe(true);
    }
  });

  it("guarantees nothing when no letter is banned, so it costs no slot", () => {
    expect(shapingOf(["Sentinel"], []).guarantees).toEqual([]);
  });
});

describe("Tide — vowel-heavy where the pool allows", () => {
  it("raises the vowel share without starving the Offer", () => {
    const vowelShare = (sets: string[][]): number => {
      let vowels = 0;
      let letters = 0;
      for (const words of sets) {
        for (const w of words) {
          letters += w.length;
          for (const ch of w) if ("aeiou".includes(ch)) vowels++;
        }
      }
      return vowels / letters;
    };
    const plain = offersWith([], {}, 60);
    const tided = offersWith(["Tide"], {}, 60);
    for (const words of tided) expect(words.length).toBe(5); // soft: never shrinks the Offer
    expect(vowelShare(tided)).toBeGreaterThan(vowelShare(plain));
  });
});

describe("Offer count deltas", () => {
  it("Wide Net adds two and Tunnel Vision removes two", () => {
    expect(shapingOf(["WideNet"]).countDelta).toBe(2);
    expect(shapingOf(["TunnelVision"]).countDelta).toBe(-2);
    // They compose, and cancel.
    expect(shapingOf(["WideNet", "TunnelVision"]).countDelta).toBe(0);
    expect(shapingOf(["WideNet", "WideNet"]).countDelta).toBe(4);
  });
});

describe("composition", () => {
  it("intersects filters and keeps them in bay order", () => {
    const shaping = shapingOf(["Sieve", "Prospector", "Tide"]);
    expect(shaping.filters.map((f) => f.cardId)).toEqual(["Sieve"]);
    expect(shaping.guarantees.map((g) => g.cardId)).toEqual(["Prospector"]);
    expect(shaping.prefer).not.toBeNull();
  });

  it("drops the RIGHTMOST filter first, honouring the order the player chose", () => {
    /* Filter order is player-controlled and meaningful, so the leftmost survives longest. Two
     * mutually unsatisfiable filters: 3-letter words, and 6+ letter words.
     *
     * The pool deliberately gives every ending letter enough start-words to satisfy the LOOKAHEAD
     * at count 2. Without that the lookahead would block everything, both filters would be given up
     * on the way to relaxing it, and the test would be measuring the wrong constraint. */
    const tiny = dictionaryWordPool(
      new Dictionary(["cat", "cog", "cub", "tap", "tin", "gum", "gap", "bus", "bin"]),
    );
    const shaping = {
      ...NO_SHAPING,
      filters: [
        { cardId: "left", accepts: (w: string) => w.length <= 3 },
        { cardId: "right", accepts: (w: string) => w.length >= 6 },
      ],
    };
    const r = generateOffer({
      pool: tiny,
      index: buildPoolIndex(tiny),
      requiredLetter: "c",
      usedWords: new Set(),
      count: 2,
      shaping,
      rng: seeded(11),
    });
    expect(r.words.length).toBe(2);
    expect(r.skippedFilters).toEqual(["right"]); // the leftmost one survived
    for (const w of r.words) expect(w.length).toBeLessThanOrEqual(3);
  });

  it("keeps the filters when the LOOKAHEAD was the real blocker", () => {
    /* A pool where nothing can satisfy the lookahead (only c-words exist, so every ending letter is
     * starved). Sieve is perfectly satisfiable here, so it must survive: the first pass gives it
     * up while hunting for the real obstacle, and the second pass restores it once the lookahead is
     * out of the way. */
    const tiny = dictionaryWordPool(
      new Dictionary(["candle", "castle", "cinema", "copper", "cat", "cog"]),
    );
    const r = generateOffer({
      pool: tiny,
      index: buildPoolIndex(tiny),
      requiredLetter: "c",
      usedWords: new Set(),
      count: 3,
      shaping: shapingOf(["Sieve"]),
      rng: seeded(12),
    });
    expect(r.words.length).toBe(3);
    expect(r.skippedFilters).toEqual([]);
    for (const w of r.words) expect(w.length).toBeGreaterThanOrEqual(6);
  });

  it("leaves an unshaped Offer untouched", () => {
    const shaping = shapingOf(["TheAnchor", "Dividend"]);
    expect(shaping).toEqual(NO_SHAPING);
  });
});
