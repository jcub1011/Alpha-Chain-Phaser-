/*
 * The Alpha Chain modifier card catalogue (alpha-chain-gdd.md §3). Behaviour is
 * faithful to the Blazor ModifierCardFactory; card ids match the SVG symbol ids
 * in public/assets/cards.svg. Every real scoring card multiplies its magnitude
 * by ctx.magnification() (a Magnifying Glass on its immediate left); inert FX
 * cards leave their factor at 1.0 so a glass never turns FX into a multiplier.
 *
 * Any length decision reads ctx.resolveWordLength() (Forgery-aware perceived
 * length) — gates, multipliers, all of it. Per-character cards still count the
 * real characters via ctx.vowelIndices() / consonantIndices() (Catalyst-aware):
 * Forgery adds no real letters, so a count can't change, but a length gate on
 * top of that count is Forgery-aware like every other length decision.
 *
 * Cards are added in build phases; the glass-cannon clocks (A2), tax/economy
 * (A3/A4) and aggression/shield (A5) cards plug in without touching the
 * evaluator. The per-mode deal pools only widen as each card's tests pass.
 *
 * PER-MODE VALUES. An entry is either a plain CardDef (identical in every mode) or a `tuned({...})`
 * one that declares its numbers ONCE and renders its chip, prose, clock cost and folds from them.
 * THE BASE `tune` BLOCK IS CLASSIC'S VALUES, and `perMode` cannot name Classic, so a Picker retune
 * is structurally incapable of moving Classic. `classic-lock.test.ts` holds every Classic number and
 * string to a committed fingerprint; `library.modes.test.ts` pins what may and may not differ
 * between modes. Read a card through `getCard(id, mode)`, or `cardIdentity(id)` when the answer
 * cannot depend on the mode.
 */

import {
  add,
  clampScore,
  DEFAULT_MAX_INSTANCES,
  fmtPct,
  fx,
  isVowel,
  mul,
  RARE_START,
  skip,
  tuned,
  type ModifierCard,
  type TunedCardDef,
  type TuneValue,
  type TuningBag,
} from "./card";
import { CardFamily, CardId, CardOp, CardRarity, GameMode } from "../types";
import type { PlayerState } from "../types";

/** Round to one decimal (per-letter multiplier steps are 0.1) for clean chips. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Scrabble-style letter-tile point values (Tilesmith). Rarer letters score more. */
const TILE_VALUES: Record<string, number> = {
  a: 1,
  e: 1,
  i: 1,
  o: 1,
  u: 1,
  l: 1,
  n: 1,
  s: 1,
  t: 1,
  r: 1,
  d: 2,
  g: 2,
  b: 3,
  c: 3,
  m: 3,
  p: 3,
  f: 4,
  h: 4,
  v: 4,
  w: 4,
  y: 4,
  k: 5,
  j: 8,
  x: 8,
  q: 10,
  z: 10,
};

/** Sum of a word's letter-tile values (unknown chars score 0). */
const tileValue = (word: string): number =>
  [...word].reduce((sum, ch) => sum + (TILE_VALUES[ch] ?? 0), 0);

/** A card minus its `id` — the id is assigned from the catalogue key when the per-mode
 *  libraries are built, so the key and id can never desync. */
type CardDef = Omit<ModifierCard, "id">;

/**
 * A catalogue entry: either a plain definition (identical in every mode) or a tuned one that
 * declares its numbers once and renders itself per mode from them.
 *
 * Both shapes are allowed ON PURPOSE. Only the cards whose values are actually mode-sensitive are
 * converted; the rest keep their source text byte-identical. A mechanical rewrite of all 54 cards
 * in the one file that must not change behaviour would be the largest regression risk in this work,
 * for no benefit on the cards nobody is retuning.
 */
type CardEntry = CardDef | TunedCardDef<TuningBag>;

const isTuned = (entry: CardEntry): entry is TunedCardDef<TuningBag> => "build" in entry;

const CARD_DEFS: Record<CardId, CardEntry> = {
  // ── §3.1 Core Additives (place left so multipliers act on a bigger base) ──
  TheAnchor: {
    name: "Decard",
    rarity: CardRarity.Common,
    color: "#4f9dff",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+10",
    description: "+10 to your submission",
    fold: (v, c) => add(v, 10 * c.magnification()),
  },

  Vanilla: {
    name: "Vanilla",
    rarity: CardRarity.Common,
    color: "#f2e2a8",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+1/ltr",
    description: "+1/letter; +2/letter at 7+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return add(v, L * (L >= 7 ? 2 : 1) * c.magnification());
    },
  },

  ConsonantCrunch: {
    name: "Consonant Crunch",
    rarity: CardRarity.Common,
    color: "#ff7a59",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+2/con",
    description: "+2/consonant; +3/consonant at 7+ letters.",
    fold: (v, c) =>
      add(
        v,
        c.consonantIndices().length * (c.resolveWordLength() >= 7 ? 3 : 2) * c.magnification(),
      ),
  },

  VocalVowels: {
    name: "Vocal Vowels",
    rarity: CardRarity.Common,
    color: "#7be0c4",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+3/vwl",
    description: "+3/vowel; +4/vowel at 7+ letters.",
    fold: (v, c) =>
      add(v, c.vowelIndices().length * (c.resolveWordLength() >= 7 ? 4 : 3) * c.magnification()),
  },

  BrickLayer: {
    name: "Brick Layer",
    rarity: CardRarity.Common,
    color: "#d96a3c",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+3/ltr",
    description: "+3/letter, only at 6+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 6 ? add(v, 3 * L * c.magnification()) : skip(v);
    },
  },

  TheBlueprint: {
    name: "Tempo",
    rarity: CardRarity.Common,
    color: "#9ad0ff",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+3/ltr",
    description:
      "+3/letter when your word is at least as long as the previous word; always pays on the first word.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return c.prevWordLength === 0 || L >= c.prevWordLength
        ? add(v, 3 * L * c.magnification())
        : skip(v);
    },
  },

  LetterHoarder: {
    name: "Character Collector",
    rarity: CardRarity.Common,
    color: "#e9c46a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+2/uniq",
    description: "+2 for each distinct letter.",
    fold: (v, c) => add(v, 2 * c.distinctLetters * c.magnification()),
  },

  HighRoller: {
    name: "High Roller",
    rarity: CardRarity.Common,
    color: "#ff5ca0",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+10/rare",
    description: "+10 per rare letter (Q, X, Z, J).",
    fold: (v, c) => {
      const rareCount = [...c.word].filter((ch) => RARE_START.has(ch)).length;
      return rareCount > 0 ? add(v, 10 * rareCount * c.magnification()) : skip(v);
    },
  },

  BoosterPack: {
    name: "Booster Pack",
    rarity: CardRarity.Common,
    color: "#ffb020",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+2×slots /right",
    description: "+2 per card to its right in the bay, multiplied by your slot count.",
    fold: (v, c) =>
      c.cardsToRight > 0
        ? add(v, 2 * c.cardsToRight * (c.slots ?? c.bayLength) * c.magnification())
        : skip(v),
  },

  Scavenger: {
    name: "Scavenger",
    rarity: CardRarity.Common,
    color: "#c08552",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+2/word",
    description: "+2 per previously submitted word (any player's) containing your starting letter.",
    fold: (v, c) => {
      const n = c.history.filter((h) => h.word.includes(c.startsWith)).length;
      return n > 0 ? add(v, 2 * n * c.magnification()) : skip(v);
    },
  },

  // ── §3.2 Core Multipliers (place right so they scale accumulated additives) ──
  VowelSurge: {
    name: "Vowel Surge",
    rarity: CardRarity.Uncommon,
    color: "#2ed6b6",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×3",
    description: "×3 when the word has more vowels than consonants.",
    fold: (v, c) =>
      c.vowelIndices().length > c.consonantIndices().length
        ? mul(v, 3 * c.magnification())
        : skip(v),
  },

  TheArchitect: {
    name: "Architect",
    rarity: CardRarity.Rare,
    color: "#8f8cff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×3",
    description: "×3 when the word is 8+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 8 ? mul(v, 3 * c.magnification()) : skip(v)),
  },

  Sesquipedalian: {
    name: "Deca-Quint",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    color: "#b06bff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×5",
    description: "×5 when the word is 10+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 10 ? mul(v, 5 * c.magnification()) : skip(v)),
  },

  GutturalRoar: {
    name: "Chant",
    rarity: CardRarity.Uncommon,
    color: "#c98a3c",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 when the word's only vowels are A or E.",
    // Matches C# LINQ .All(): a word with no (active-classifier) vowels triggers vacuously.
    fold: (v, c) =>
      c.vowelIndices().every((i) => c.word[i] === "a" || c.word[i] === "e")
        ? mul(v, 2 * c.magnification())
        : skip(v),
  },

  PerfectLink: {
    name: "Perfect Link",
    rarity: CardRarity.Common,
    color: "#57e08a",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description: "×1.5 when the word ends in a vowel.",
    fold: (v, c) =>
      c.vowelIndices().includes(c.length - 1) ? mul(v, 1.5 * c.magnification()) : skip(v),
  },

  TryHard: {
    name: "Try Hard",
    rarity: CardRarity.Uncommon,
    color: "#ff8c42",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5+",
    description: "×1.5 at 7 letters, +0.1 per letter beyond.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L > 6 ? mul(v, round1(1.4 + 0.1 * (L - 6)) * c.magnification()) : skip(v);
    },
  },

  DoubleDown: {
    name: "Double Down",
    rarity: CardRarity.Uncommon,
    color: "#ff4d9d",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 with a repeat letter, else ×0.5.",
    fold: (v, c) =>
      c.hasRepeatLetter ? mul(v, 2 * c.magnification()) : mul(v, 0.5 * c.magnification()),
  },

  // ── §3.3 Glass cannon (multipliers paid in your own shot clock) ──
  /* The glass cannons are tuned cards: the GDD flags every clock-scaling multiplier for per-mode
   * re-costing (§4.4), because a Picker commit is far faster than typing and their timeout drains
   * never fire there at all. Writing the numbers once is what lets that be a numbers-only edit. */
  TheVault: tuned({
    tune: { factor: 1.5, clockPct: -0.2, timeoutLoss: 12 },
    // Picker has no timeout penalty at all: `pickerTimeoutCurrent` never calls `scoreTimeout`, so
    // BASE_TIMEOUT_PENALTY and every timeoutFold are unreachable there. The drain could not fire,
    // yet the card face still advertised it. Zeroing the knob retires the clause AND the fold from
    // the same number, so the two can never disagree again. NOT a balance change: the fold it
    // disables was already unreachable.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Overclock",
      rarity: CardRarity.Rare,
      color: "#9fb3d6",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      magnitudeText: `×${t.factor}`,
      description:
        `×${t.factor} always; permanently ${fmtPct(t.clockPct)} shot clock.` +
        (t.timeoutLoss ? ` Time out and lose ${t.timeoutLoss} points.` : ""),
      clock: { pctDelta: t.clockPct },
      fold: (v, c) => mul(v, t.factor * c.magnification()),
      // `timeoutLoss: 0` means inert, and the description above drops its clause from the same
      // number — so a mode without a timeout penalty cannot end up advertising one.
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
    }),
  }),

  Redline: tuned({
    tune: { factor: 2, clockPct: -0.3, timeoutLoss: 24 },
    // Picker has no timeout penalty at all: `pickerTimeoutCurrent` never calls `scoreTimeout`, so
    // BASE_TIMEOUT_PENALTY and every timeoutFold are unreachable there. The drain could not fire,
    // yet the card face still advertised it. Zeroing the knob retires the clause AND the fold from
    // the same number, so the two can never disagree again. NOT a balance change: the fold it
    // disables was already unreachable.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Redline",
      rarity: CardRarity.Rare,
      color: "#ff4d4d",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      magnitudeText: `×${t.factor}`,
      description:
        `×${t.factor} always; permanently ${fmtPct(t.clockPct)} shot clock.` +
        (t.timeoutLoss ? ` Time out and lose ${t.timeoutLoss} points.` : ""),
      clock: { pctDelta: t.clockPct },
      fold: (v, c) => mul(v, t.factor * c.magnification()),
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
    }),
  }),

  PanicButton: tuned({
    tune: { perSecond: 0.05, cap: 2 },
    build: (t) => ({
      name: "Reflex",
      rarity: CardRarity.Uncommon,
      color: "#ff2e6e",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      magnitudeText: `≤×${t.cap}`,
      description: `+×${t.perSecond} for every second left in your shot clock, capped at ×${t.cap}.`,
      fold: (v, c) =>
        mul(v, Math.min(t.cap, 1 + c.clockRemaining * t.perSecond) * c.magnification()),
    }),
  }),

  SlowBurn: {
    name: "Slow Burn",
    rarity: CardRarity.Uncommon,
    color: "#ff9e57",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "+30% shot clock. Words shorter than 6 letters are illegal and take the Zero-Point Tax.",
    clock: { pctDelta: 0.3 },
    fold: (v) => fx(v),
    illegalWord: (c) => c.resolveWordLength() < 6,
  },

  Speedracer: tuned({
    /* `ratioWeight` is a weight on the remaining/total ratio, and 1 is the identity — the GDD asks
     * to "retune the curves, not the caps" (§4.4), and this is the knob that curve needs. At 1 the
     * expression differs from the original while the value does not, which is exactly what the
     * Classic lock verifies. A weight other than 1 must also reword the description below. */
    tune: { ratioWeight: 1, timeoutLoss: 10 },
    // Picker has no timeout penalty at all: `pickerTimeoutCurrent` never calls `scoreTimeout`, so
    // BASE_TIMEOUT_PENALTY and every timeoutFold are unreachable there. The drain could not fire,
    // yet the card face still advertised it. Zeroing the knob retires the clause AND the fold from
    // the same number, so the two can never disagree again. NOT a balance change: the fold it
    // disables was already unreachable.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Speedracer",
      rarity: CardRarity.Uncommon,
      maxInstances: 2,
      color: "#ffd23f",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      magnitudeText: "×(1+Remain /Total)",
      description:
        "×(1 + remaining clock time ÷ total clock time)." +
        (t.timeoutLoss ? ` Time out and lose ${t.timeoutLoss} points.` : ""),
      fold: (v, c) =>
        mul(v, (1 + t.ratioWeight * (c.clockRemaining / c.clockTotal)) * c.magnification()),
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
    }),
  }),

  Blindfold: {
    name: "Blindfold",
    rarity: CardRarity.Uncommon,
    maxInstances: 1,
    // Classic-only: its whole downside is masking the input box while you type, and Picker has no
    // input box — in Picker this would be a ×1.5 with no cost at all.
    modes: [GameMode.Classic],
    color: "#8a7dff",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description:
      "×1.5 always; hides your own input box while you type. Time out and lose 8 points.",
    fold: (v, c) => mul(v, 1.5 * c.magnification()),
    timeoutFold: (v, c) => add(v, -8 * c.magnification()),
    hidesInput: () => true,
  },

  // ── §3.8 Utility (FX; 0 points, enabling capabilities) ──
  HeatSink: {
    name: "Heat Sink",
    rarity: CardRarity.Common,
    color: "#7fd8ff",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×0.9",
    description: "+30% shot clock, but ×0.9 to your score.",
    clock: { pctDelta: 0.3 },
    fold: (v, c) => mul(v, 0.9 * c.magnification()),
  },

  Catalyst: {
    name: "Catalyst",
    rarity: CardRarity.Uncommon,
    color: "#b97bff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "For every card placed to its right: Y, W and H count as vowels as well as consonants.",
    fold: (v) => fx(v),
    isVowel: (ch) => "aeiouywh".includes(ch),
  },

  Forgery: {
    name: "Forgery",
    rarity: CardRarity.Legendary,
    color: "#d8b46a",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "Every card that checks the word length percieves it to be twice as long.",
    fold: (v) => fx(v),
    // Perceived = double the count seen BEFORE this card (so glasses stack), then
    // scaled by a glass magnifying Forgery itself (×2 → ×3), rounded half-up.
    perceivedLength: (c) => Math.floor(c.resolveWordLength() * 2 * c.magnification() + 0.5),
  },

  MagnifyingGlass: {
    name: "Magnifying Glass",
    rarity: CardRarity.Rare,
    // The only card capped ABOVE the default 3, and deliberately so: five in series
    // compound to ×7.59375, which we want reachable as a build-around rather than
    // impossible. Rarity is the brake here — at Rare the dealer rarely offers five,
    // and five glasses plus something to magnify needs 6 of the 12 max bay slots.
    maxInstances: 5,
    color: "#9ad0ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "Magnifies the card to its right by ×1.5. Glasses in series compound.",
    fold: (v) => fx(v),
    submitMagnifications: (reg, i) => reg.push(i + 1, 1.5 * reg.getMagnification(i)),
  },

  Wildcard: {
    name: "Wildcard",
    rarity: CardRarity.Rare,
    color: "#ffd34d",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Once per era, one word may ignore the Succession rule — it need not begin with the previous word's last letter.",
    fold: (v) => fx(v),
    roomServices: ["wildcardGuard"],
    // Available until consumed this era; the match consumes it only on an accepted bypass.
    ignoresSuccession: (c) =>
      !!c.player && (c.services?.wildcardGuard.isAvailable(c.player.id) ?? false),
  },

  Prism: {
    name: "Prism",
    rarity: CardRarity.Rare,
    color: "#6fe0ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Once per era, when your shot clock runs out your clock resets to full instead of ending your turn.",
    fold: (v) => fx(v),
    roomServices: ["prismGuard"],
    rescueClock: (c) => {
      if (c.player && c.services?.prismGuard.tryConsume(c.player.id)) {
        c.clock?.refillToFull();
        return true;
      }
      return false;
    },
  },

  IrsAgent: {
    name: "Fancy Accounting",
    rarity: CardRarity.Common,
    color: "#4caf6e",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "When your word is taxed, no opponent's Tax Collector collects from you.",
    fold: (v) => fx(v),
    ownTaxScore: () => 0,
    suppressesSiphon: true,
  },

  TaxWriteOff: {
    name: "Tax Write-Off",
    rarity: CardRarity.Common,
    color: "#3fa7a0",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "When your word is taxed, score the first half of it through your engine anyways.",
    fold: (v) => fx(v),
    writeOffBonus: (c, score) =>
      c.word.length > 0 ? score(c.word.substring(0, Math.ceil(c.word.length / 2))) : 0,
  },

  // ── §3.4 Personal-ban economy ──
  RouletteWheel: {
    name: "Roulette Wheel",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    color: "#e0457b",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description:
      "Each era, rolls you a personal banned letter (Zero-Point Tax if you use it). ×2 on every clean word.",
    fold: (v, c) => mul(v, 2 * c.magnification()),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, c.cardIndex, CardId.RouletteWheel, ban);
    },
  },

  TollBooth: {
    name: "Toll Booth",
    rarity: CardRarity.Rare,
    maxInstances: 1,
    color: "#caa24a",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Each era, you get a personal banned letter. Bank 20% of any opponent's score when their word uses that letter.",
    fold: (v) => fx(v),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, c.cardIndex, CardId.TollBooth, ban);
    },
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.taxed || res.earnedScore <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const banned = c.services?.cardBan.letterFor(owner.id, c.cardIndex);
      if (banned && res.word.includes(banned)) {
        const amount = clampScore(res.earnedScore * 0.2 * c.magnification());
        if (amount > 0) {
          owner.score += amount;
          c.effects?.bankSiphon(owner.id, amount, "The Toll Booth");
        }
      }
    },
  },

  // ── §3.5 Reactive economy (resolve via lifecycle hooks, not the scoring fold) ──
  TaxCollector: {
    name: "Tax Collector",
    rarity: CardRarity.Rare,
    color: "#2fa85a",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "When an opponent is taxed, collect 60% of their would-be score.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || !res.taxed || res.siphonSuppressed || res.wouldBeScore <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const amount = clampScore(res.wouldBeScore * 0.6 * c.magnification());
      if (amount <= 0) return;
      owner.score += amount;
      c.effects?.bankSiphon(owner.id, amount, "Tax Collector");
    },
  },

  /* Tuned: the GDD calls this "the most affected card in the catalogue" in Picker (§4.4), since a
   * fast commit leaves far more seconds on an opponent's clock than typing a word does. */
  ChronoSyphon: tuned({
    tune: { perSecond: 2 },
    build: (t) => ({
      name: "Chrono Syphon",
      rarity: CardRarity.Uncommon,
      color: "#5ad0c4",
      family: CardFamily.Economy,
      op: CardOp.Fx,
      magnitudeText: "FX",
      description: `+${t.perSecond} per whole second left on an opponent's shot clock when they submit.`,
      fold: (v) => fx(v),
      onOpponentWordResolved: (c) => {
        const res = c.resolution;
        if (!res || res.remainingSeconds <= 0) return;
        const owner = c.player;
        if (!owner || owner.id === res.submitterId) return;
        const amount = clampScore(res.remainingSeconds * t.perSecond * c.magnification());
        if (amount > 0) {
          owner.score += amount;
          c.effects?.bankSiphon(owner.id, amount, "Chrono Syphon");
        }
      },
    }),
  }),

  BaitAndSwitch: {
    name: "Bait & Switch",
    rarity: CardRarity.Uncommon,
    color: "#b388ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "When your word is taxed, curse the next player with that banned letter for their next turn.",
    fold: (v) => fx(v),
    roomServices: ["hijackBan"],
    onTurnEnded: (c) => {
      const res = c.resolution;
      const fx2 = c.effects;
      if (!res || !res.taxed || !res.offendingLetter || !fx2) return;
      const owner = c.player;
      if (!owner) return;
      const next = fx2.peekNextActivePlayer(owner.id);
      if (next) fx2.letterHijack(next, res.offendingLetter, "Bait & Switch");
    },
  },

  // ── Rebalance additions: archetypes to rival the speed build ────────────────
  // Long-word / Wordsmith — reward big words and the time to type them.
  TheLexicon: {
    name: "Scholar",
    rarity: CardRarity.Uncommon,
    color: "#7bb0ff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×2 @9+",
    description: "×2 when your word is 9+ letters; +15% shot clock.",
    clock: { pctDelta: 0.15 },
    fold: (v, c) => (c.resolveWordLength() >= 9 ? mul(v, 2 * c.magnification()) : skip(v)),
  },

  Stonemason: {
    name: "Stonemason",
    rarity: CardRarity.Uncommon,
    color: "#b5651d",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+4/ltr",
    description: "+4/letter, only at 8+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 8 ? add(v, 4 * L * c.magnification()) : skip(v);
    },
  },

  // Economy / Parasite — bank off opponents (Loan Shark taxes the big scorers).
  LoanShark: {
    name: "Loan Shark",
    rarity: CardRarity.Uncommon,
    color: "#2f8f5b",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Bank 15% of any opponent's word scoring more than 30 points, but only if they're ahead of you on the leaderboard.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.taxed || res.earnedScore <= 30) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      // Prey only on players ahead of you: skip opponents at or below your score.
      const submitter = c.players?.find((p) => p.id === res.submitterId);
      if (!submitter || submitter.score <= owner.score) return;
      const amount = clampScore(res.earnedScore * 0.15 * c.magnification());
      if (amount > 0) {
        owner.score += amount;
        c.effects?.bankSiphon(owner.id, amount, "Loan Shark");
      }
    },
  },

  Numismatist: {
    name: "Numismatist",
    rarity: CardRarity.Rare,
    color: "#caa24a",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.6 /rare",
    description: "×(1 + 0.6 per rare letter Q, X, Z, J).",
    fold: (v, c) => {
      const rare = [...c.word].filter((ch) => RARE_START.has(ch)).length;
      return rare > 0 ? mul(v, (1 + 0.6 * rare) * c.magnification()) : skip(v);
    },
  },

  // Aggression / Control — deny tempo (now sharper because timeouts cost points).
  /* Tuned: §4.4 expects no change here, but names it as the one aggression card whose value moves
   * in Picker (clock pressure scales with how long an Offer takes to read). Parameterized so a
   * playtest answer is a one-number edit rather than a hunt through prose and hook. */
  TheSniper: tuned({
    tune: { shavePct: 0.2 },
    build: (t) => ({
      name: "Blind Sniper",
      rarity: CardRarity.Rare,
      color: "#ff5252",
      family: CardFamily.Utility,
      op: CardOp.Fx,
      magnitudeText: "FX",
      // A plain percent, not fmtPct: the shave's sign is carried by the word "Shave", so a signed
      // "+20%" would read as the opposite of what the card does.
      description: `Shave ${Math.round(t.shavePct * 100)}% off the shot clock of the leader. This applies to you if you are in the lead.`,
      fold: (v) => fx(v),
      roomServices: ["timePenalty"],
      onTurnEnded: (c) => {
        const owner = c.player;
        const fx2 = c.effects;
        if (!owner || !fx2) return;
        // The overall leader among ALL active players — including the owner, so a
        // leading Blind Sniper shaves its own clock (a built-in anti-snowball cost).
        let top: PlayerState | null = null;
        for (const p of fx2.orderedActivePlayers()) {
          if (!top || p.score > top.score) top = p;
        }
        if (top) {
          const shave = Math.max(
            1,
            Math.round(fx2.armedClockOf(top) * t.shavePct * c.magnification()),
          );
          fx2.timeShave(top, shave, "Blind Sniper");
        }
      },
    }),
  }),

  // Defensive / Combo engine.
  Insurance: {
    name: "Insurance",
    rarity: CardRarity.Common,
    // Classic-only: it negates the timeout point penalty, and Picker has no timeout penalty (a
    // Picker expiry commits a word and scores it), so the card would be pure dead weight.
    modes: [GameMode.Classic],
    color: "#4cc2ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "Scores nothing on a normal word. If you time out, you lose no points.",
    fold: (v) => fx(v),
    // Negate the timeout loss: bring the running penalty back up to 0 (the refund is
    // shown in the replay). negatesTimeoutLoss also floors the net at 0 so glass-cannon
    // drains placed to the right of this card can't re-open a loss (order-independent).
    negatesTimeoutLoss: true,
    timeoutFold: (v) => (v < 0 ? add(v, -v) : skip(v)),
  },

  TheFlywheel: {
    name: "Flywheel",
    rarity: CardRarity.Rare,
    color: "#8f8cff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.15+",
    description: "×1.15 for each other multiplier card in your bay (capped at ×2.3).",
    fold: (v, c) => {
      const ids = c.bayCardIds ?? [];
      // `cardIdentity`, not `getCard`: `op` is mode-invariant, so counting the other multipliers
      // needs no mode — which also spares this fold from having to name the mode it is itself
      // being evaluated in.
      const others = ids.filter(
        (id, i) => i !== c.cardIndex && cardIdentity(id)?.op === CardOp.Multiplicative,
      ).length;
      if (others === 0) return skip(v);
      const factor = Math.min(2.3, round1(1 + 0.15 * others));
      return mul(v, factor * c.magnification());
    },
  },

  // ── New archetype cards: word quality, clean-streak consistency, engine width ──
  Tilesmith: {
    name: "Tilesmith",
    rarity: CardRarity.Common,
    color: "#c9a227",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+tile",
    description: "Scores the word based on its letter-tile values (Scrabble-style).",
    fold: (v, c) => add(v, tileValue(c.word) * c.magnification()),
  },

  Crescendo: {
    name: "Crescendo",
    rarity: CardRarity.Uncommon,
    color: "#ff8fb0",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×1+0.25 /clean",
    description:
      "×(1 + 0.25 per clean word you've played this era), capped at ×2. Being taxed or timing out resets it.",
    roomServices: ["crescendoStreak"],
    fold: (v, c) => {
      const streak = c.player && c.services ? c.services.crescendoStreak.get(c.player.id) : 0;
      return streak > 0 ? mul(v, Math.min(2, 1 + 0.25 * streak) * c.magnification()) : skip(v);
    },
  },

  Bookends: {
    name: "Bookends",
    rarity: CardRarity.Common,
    color: "#8fb0ff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 when the word's first and last letter are the same.",
    fold: (v, c) => {
      const w = c.word;
      return w.length >= 2 && w[0] === w[w.length - 1] ? mul(v, 2 * c.magnification()) : skip(v);
    },
  },

  Dividend: {
    name: "Dividend",
    rarity: CardRarity.Common,
    color: "#4caf6e",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+2/card",
    description: "+2 for each card in your bay.",
    fold: (v, c) => add(v, 2 * c.bayLength * c.magnification()),
  },

  /* ── Preference Cards (Picker only) ──────────────────────────────────────────────────────────
   * They shape the Offer rather than scoring the word, and they occupy Engine Bay slots to do it.
   * There is no second engine: a separate picker strip would be pure upside, and pure upside is not
   * a decision. Sharing the bay makes the family an extension of the Intermission Dilemma.
   *
   * Every one is a shape constraint WITH A COST. Any Preference Card that is strictly good for its
   * owner is mis-designed — check the cost column before adding to this block.
   *
   * RARITIES BELOW ARE PROPOSED, NOT VALIDATED. Because these compete with scoring cards for slots,
   * their deal rate directly controls how often the mode's central dilemma is actually posed, so
   * they want a balance pass once Picker has real play data. */

  Sieve: {
    name: "Sieve",
    rarity: CardRarity.Common,
    modes: [GameMode.Picker],
    color: "#7ec8a9",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "6+ only",
    description: "Your Offer contains only words of 6+ letters. Scores nothing itself.",
    fold: (v) => fx(v),
    // The cost: you can never duck a Banned Letter with a short safe word.
    preference: { filter: () => (w) => w.length >= 6 },
  },

  /* Tuned not for per-mode values — it is Picker-only, so it has no Classic form to protect — but
   * because its 30% was written twice, in the prose AND in the redraw spec the engine charges.
   * Those are precisely the two that must never disagree. */
  Winnower: tuned({
    tune: { clockCostFraction: 0.3 },
    build: (t) => ({
      name: "Winnower",
      rarity: CardRarity.Rare,
      maxInstances: 1,
      modes: [GameMode.Picker],
      color: "#c9a6ff",
      family: CardFamily.Utility,
      op: CardOp.Fx,
      magnitudeText: "redraw",
      description: `Once per turn, redraw your whole Offer for ${Math.round(t.clockCostFraction * 100)}% of your shot clock.`,
      fold: (v) => fx(v),
      roomServices: ["winnowerGuard"],
      // The price is a FIXED fraction, so it grows harsher as your engine grows and each Offer
      // takes longer to read — the card gets worse exactly as your bay gets better.
      preference: { redraw: { clockCostFraction: t.clockCostFraction } },
    }),
  }),

  WideNet: {
    name: "Wide Net",
    rarity: CardRarity.Common,
    modes: [GameMode.Picker],
    color: "#6fb7ff",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    magnitudeText: "+2 / −15%",
    description: "+2 Offer Cards, and −15% shot clock. More to choose from, less time to choose.",
    fold: (v) => fx(v),
    // A genuine ClockModifier, which is why armedClockSeconds keeps the FULL bay even though this
    // card is hidden from bay-size SCORING.
    clock: { pctDelta: -0.15 },
    preference: { countDelta: 2 },
  },

  TunnelVision: {
    name: "Tunnel Vision",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    modes: [GameMode.Picker],
    color: "#ff8f6b",
    family: CardFamily.Utility,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.4",
    description: "×1.4 always, but you are offered 2 fewer words. Raw multiplier, less choice.",
    fold: (v, c) => mul(v, 1.4 * c.magnification()),
    // The one Preference Card that really scores, so it is placed and counted like any other
    // multiplier rather than bubbling left — see isInertPreference for why that must be so.
    preference: { countDelta: -2 },
  },

  Prospector: {
    name: "Prospector",
    rarity: CardRarity.Uncommon,
    modes: [GameMode.Picker],
    color: "#e0c060",
    family: CardFamily.Letter,
    op: CardOp.Fx,
    magnitudeText: "1 rare",
    description: "At least one Offer Card always contains Q, X, Z or J. Scores nothing itself.",
    fold: (v) => fx(v),
    // The cost: one of your Offer slots is permanently spent on a word you may not want.
    preference: { guarantee: () => (w) => [...w].some((ch) => RARE_START.has(ch)) },
  },

  Tide: {
    name: "Tide",
    rarity: CardRarity.Uncommon,
    modes: [GameMode.Picker],
    color: "#5fd0d8",
    family: CardFamily.Letter,
    op: CardOp.Fx,
    magnitudeText: "vowels",
    description: "Your Offer is drawn vowel-heavy wherever the pool allows. Scores nothing itself.",
    fold: (v) => fx(v),
    // A SOFT bias, abandoned when the pool cannot serve it, so it never starves the Offer. The
    // cost is concentration: a narrower draw means more repeats and a thinner ending-letter graph.
    preference: {
      prefer: () => (w) => {
        let vowels = 0;
        for (const ch of w) if (isVowel(ch)) vowels++;
        return vowels * 2 >= w.length;
      },
    },
  },

  Sentinel: {
    name: "Sentinel",
    rarity: CardRarity.Rare,
    modes: [GameMode.Picker],
    color: "#9fb4c7",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "1 safe",
    description:
      "At least one Offer Card is guaranteed free of every letter banned against you. Scores nothing itself.",
    fold: (v) => fx(v),
    // Insurance against the Zero-Point Tax, paid for in slots — and it spends an Offer slot on
    // safety rather than on ceiling. With no bans in force it guarantees nothing and costs nothing.
    preference: {
      guarantee: (ctx) =>
        ctx.bannedLetters.length === 0
          ? null
          : (w) => !ctx.bannedLetters.some((letter) => w.includes(letter)),
    },
  },
};

/* ── Resolution: the per-mode libraries ────────────────────────────────────────────────────────
 * Built once at module load, so resolving a card in the scoring hot path stays a lookup and each
 * mode's cards have stable object identity.
 *
 * CLASSIC NEVER MERGES. For the baseline mode the tune handed to `build` is the card's own base
 * object, untouched — so a Picker patch cannot participate in Classic's resolution even at
 * runtime, not merely by type. An untuned entry is resolved ONCE and shared by every mode, so
 * those cards are mode-invariant by construction (library.modes.test.ts asserts it with ===).
 *
 * Spread and freeze only: no structuredClone, no Date, no fetch, no DOM, so the authority bundle
 * stays a single import-free ESM file. Each card's `id` is assigned from its CARD_DEFS key, so the
 * key and id are the same value by construction (no desync possible). */

/** Merge a tuned card's base numbers with `mode`'s patch. Returns the BASE OBJECT ITSELF for the
 *  baseline mode, and for any mode with no patch — see the block comment above. */
function resolveTune(entry: TunedCardDef<TuningBag>, mode: GameMode): TuningBag {
  if (mode === GameMode.Classic) return entry.tune;
  const patch = entry.perMode?.[mode as Exclude<GameMode, typeof GameMode.Classic>];
  if (!patch) return entry.tune;
  // Copied key by key rather than spread: a `Partial<T>` spread widens every value to
  // `TuneValue | undefined`, and an explicitly-undefined key would then erase a base value
  // instead of leaving it alone. Skipping undefined makes "unlisted knob keeps its baseline"
  // true however the patch was written.
  const merged: Record<string, TuneValue> = { ...entry.tune };
  for (const [knob, value] of Object.entries(patch)) {
    if (value !== undefined) merged[knob] = value;
  }
  return Object.freeze(merged);
}

const LIBRARY_BY_MODE: Record<GameMode, Record<CardId, ModifierCard>> = {
  [GameMode.Picker]: {} as Record<CardId, ModifierCard>,
  [GameMode.Classic]: {} as Record<CardId, ModifierCard>,
};

for (const [key, entry] of Object.entries(CARD_DEFS) as [CardId, CardEntry][]) {
  if (!isTuned(entry)) {
    const card = Object.freeze({ id: key, ...entry });
    for (const mode of Object.values(GameMode)) LIBRARY_BY_MODE[mode][key] = card;
    continue;
  }
  for (const mode of Object.values(GameMode)) {
    LIBRARY_BY_MODE[mode][key] = Object.freeze({
      id: key,
      ...entry.build(resolveTune(entry, mode)),
    });
  }
}

/**
 * The mode-INVARIANT half of a card: what the card IS, as opposed to what it DOES.
 *
 * Spelled as an explicit Pick, not an Omit, so adding a tunable field to ModifierCard can never
 * silently join this type. Every tunable field — magnitudeText, description, clock, fold,
 * timeoutFold and every capability/lifecycle hook — is ABSENT here, which means a caller holding a
 * CardIdentity cannot read a mode-sensitive value even by accident. Most former `getCard` callers
 * want only this, and are better off unable to see the rest.
 *
 * Widening this is the tripwire for per-mode rarity: `rarity`, `maxInstances` and `modes` being
 * non-tunable is what keeps every dealer and lobby number mode-agnostic, and
 * `library.modes.test.ts` asserts these fields never differ between modes.
 */
export type CardIdentity = Pick<
  ModifierCard,
  | "id"
  | "name"
  | "family"
  | "op"
  | "rarity"
  | "color"
  | "maxInstances"
  | "modes"
  | "preference"
  | "roomServices"
>;

/** Catalogue metadata, mode-blind by construction. Replaces the old `CARD_LIBRARY`.
 *
 *  This is the Classic-resolved table exposed through a type that cannot see a tuned field — no
 *  copy is made, so the narrowing costs nothing. Safe because every field in `CardIdentity` is
 *  non-tunable, which the mode-parity test pins. */
export const CARD_CATALOGUE: Readonly<Record<CardId, CardIdentity>> =
  LIBRARY_BY_MODE[GameMode.Classic];

/** A card's mode-invariant metadata. Prefer this over `getCard` wherever a mode is irrelevant —
 *  it is both shorter at the call site and unable to return a number that depends on the mode. */
export const cardIdentity = (id: string): CardIdentity | undefined =>
  (CARD_CATALOGUE as Record<string, CardIdentity>)[id];

/**
 * The fully resolved card as it behaves and reads in `mode`.
 *
 * `mode` is REQUIRED. An omitted mode would silently serve Classic's numbers during a Picker
 * match, which is the exact failure this whole mechanism exists to remove — so every call site is
 * a compile error until it names one. Callers that need no mode should use `cardIdentity`.
 *
 * This resolves ANY id in ANY mode and deliberately does NOT filter by `modes`: a card already in
 * a bay, in a score replay, or in the sandbox gallery must still resolve whatever mode is running,
 * and resolves to its base values there. Dealability remains `dealableCardIds`'s job.
 */
export const getCard = (id: string, mode: GameMode): ModifierCard | undefined =>
  (LIBRARY_BY_MODE[mode] as Record<string, ModifierCard>)[id];

/** The whole resolved library for `mode`. For the lock tests and the sandbox gallery. */
export const cardLibrary = (mode: GameMode): Readonly<Record<CardId, ModifierCard>> =>
  LIBRARY_BY_MODE[mode];

/**
 * The tuned entries, unresolved. FOR THE LOCK TESTS ONLY — nothing in the game reads this.
 *
 * It exists so a test can rebuild a card with one knob perturbed and prove every declared number
 * is load-bearing. That is the one check which catches a stray literal left sitting beside a `t.`
 * read, where the prose would move on a retune but the fold would not.
 */
export const tunedCardEntries = (): ReadonlyArray<readonly [CardId, TunedCardDef<TuningBag>]> =>
  (Object.entries(CARD_DEFS) as [CardId, CardEntry][]).filter(
    (pair): pair is [CardId, TunedCardDef<TuningBag>] => isTuned(pair[1]),
  );

/* ── The deal pool, per mode ───────────────────────────────────────────────────────────────────
 * There is deliberately NO mode-blind exported id list. A card whose effect is meaningless in a
 * mode (see ModifierCard.modes) must be invisible to the dealer AND to the lobby's capacity
 * warning, and the way to guarantee that is to make every caller name a mode — if the dealer and
 * the readout could disagree, the warning would simply be wrong.
 *
 * This is a DEALABILITY filter and is entirely separate from per-mode resolution: `getCard(id,
 * mode)` is mode-parameterized but never mode-filtered, so a card already in a bay, in a score
 * replay, or in the sandbox gallery still resolves whatever mode is running.
 *
 * Everything below reads `CARD_CATALOGUE`, whose fields (`modes`, `rarity`, `maxInstances`) are
 * non-tunable — which is what keeps every dealer and lobby number mode-agnostic even though cards
 * now resolve per mode. */

/** Both pools, resolved once. `.filter` preserves CARD_DEFS declaration order, which is
 *  load-bearing: the dealer's weighted walk and its float-drift last-slot fallback both index into
 *  this array, so reordering it would change which card a given rng roll deals. */
const DEALABLE_BY_MODE: Record<GameMode, CardId[]> = {
  [GameMode.Picker]: [],
  [GameMode.Classic]: [],
};
for (const mode of Object.values(GameMode)) {
  DEALABLE_BY_MODE[mode] = (Object.keys(CARD_CATALOGUE) as CardId[]).filter((id) => {
    const modes = CARD_CATALOGUE[id].modes;
    return modes === undefined || modes.includes(mode);
  });
}

const RARITY_COUNTS_BY_MODE: Record<GameMode, Record<CardRarity, number>> = {
  [GameMode.Picker]: emptyTierCounts(),
  [GameMode.Classic]: emptyTierCounts(),
};
for (const mode of Object.values(GameMode)) {
  for (const id of DEALABLE_BY_MODE[mode]) RARITY_COUNTS_BY_MODE[mode][CARD_CATALOGUE[id].rarity]++;
}

function emptyTierCounts(): Record<CardRarity, number> {
  return {
    [CardRarity.Common]: 0,
    [CardRarity.Uncommon]: 0,
    [CardRarity.Rare]: 0,
    [CardRarity.Legendary]: 0,
  };
}

/** The ids dealt to players in `mode`, in declaration order. */
export const dealableCardIds = (mode: GameMode): readonly CardId[] => DEALABLE_BY_MODE[mode];

/** How many dealable cards sit in each rarity tier, in `mode`. */
export const rarityCardCounts = (mode: GameMode): Record<CardRarity, number> =>
  RARITY_COUNTS_BY_MODE[mode];

/**
 * Each tier's share of a single draw under the given deal weights, as a fraction in
 * [0, 1] — a tier's card count × its weight, over the sum across tiers. Returns all
 * zeros (never NaN) when every weight is 0, which is the "deal nothing" configuration.
 *
 * This is the FULL-POOL, UNCAPPED share: a real pool shrinks as a player's cards hit
 * their maxInstances, which shifts the true odds mid-deal. Good enough to label a
 * lobby stepper, not a balance oracle — don't assert game outcomes against it.
 */
export function rarityDealShare(
  weights: Record<CardRarity, number>,
  mode: GameMode,
): Record<CardRarity, number> {
  const counts = rarityCardCounts(mode);
  const tiers = Object.values(CardRarity);
  const total = tiers.reduce((sum, tier) => sum + counts[tier] * weights[tier], 0);
  const share = {} as Record<CardRarity, number>;
  for (const tier of tiers) {
    share[tier] = total > 0 ? (counts[tier] * weights[tier]) / total : 0;
  }
  return share;
}

/**
 * The most cards ONE player can ever be dealt under the given weights: every copy of every
 * card in an enabled (weight > 0) tier, since a zeroed tier leaves the deal pool outright
 * and each card is capped at its `maxInstances` per player.
 *
 * This is a hard ceiling, not an estimate. Once a player holds this many, `dealCards` finds
 * an empty pool and stops early — so a lobby whose enabled tiers total less than
 * `totalCardsDealtPerPlayer(settings)` will silently deal nothing in its later intermissions.
 * Both lobbies warn on exactly that comparison.
 */
export function dealPoolCapacity(weights: Record<CardRarity, number>, mode: GameMode): number {
  return dealableCardIds(mode).reduce((sum, id) => {
    const card = CARD_CATALOGUE[id];
    if (weights[card.rarity] <= 0) return sum;
    return sum + (card.maxInstances ?? DEFAULT_MAX_INSTANCES);
  }, 0);
}
