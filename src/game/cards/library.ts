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
  fmtMag,
  fmtPct,
  fx,
  isVowel,
  mul,
  RARE_START,
  skip,
  staticFace,
  tuned,
  type CardRenderContext,
  type ModifierCard,
  type TunedCardDef,
  type TuneValue,
  type TuningBag,
} from "./card";
import { CardFamily, CardId, CardOp, CardRarity, GameMode } from "../types";
import type { PlayerState } from "../types";

/** Round to one decimal (per-letter multiplier steps are 0.1) for clean chips. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/* ── Render-template helpers ─────────────────────────────────────────────────
 * Every `renderText` below interpolates the same numbers its `fold` uses, so
 * the face and the score cannot disagree. At ×1 each template reproduces the
 * neutral face byte-identically (pinned by the render tests); under a
 * Magnifying Glass the stated magnitudes scale with it. */

/** Glass note for cards whose resting magnitude cannot resolve without a word
 *  (length curves, rare counts, clock ratios) or whose effect is reactive:
 *  names the glass factor so the face still reads magnified. Empty at ×1. */
const glassNote = (c: CardRenderContext): string =>
  c.magnification > 1 ? ` (×${fmtMag(c.magnification)} glass)` : "";

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
 * converted; the rest keep their single `renderText` template byte-identical. A mechanical rewrite
 * of all 54 cards in the one file that must not change behaviour would be the largest regression
 * risk in this work, for no benefit on the cards nobody is retuning.
 */
type CardEntry = CardDef | TunedCardDef<TuningBag>;

const isTuned = (entry: CardEntry): entry is TunedCardDef<TuningBag> => "build" in entry;

const CARD_DEFS: Record<CardId, CardEntry> = {
  // ── §3.1 Core Additives (place left so multipliers act on a bigger base) ──
  TheAnchor: {
    name: "Decard",
    rarity: CardRarity.Common,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => add(v, 10 * c.magnification()),
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(10 * c.magnification)}`,
      description: `+${fmtMag(10 * c.magnification)} to your word`,
    }),
  },

  Vanilla: {
    name: "Vanilla",
    rarity: CardRarity.Common,
    color: "#dcae4c",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return add(v, L * (L >= 7 ? 2 : 1) * c.magnification());
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(c.magnification)}/ltr`,
      description: `+${fmtMag(c.magnification)}/letter; +${fmtMag(2 * c.magnification)}/letter at 7+ letters.`,
    }),
  },

  ConsonantCrunch: {
    name: "Consonant Crunch",
    rarity: CardRarity.Common,
    color: "#c25a3a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) =>
      add(
        v,
        c.consonantIndices().length * (c.resolveWordLength() >= 7 ? 3 : 2) * c.magnification(),
      ),
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(2 * c.magnification)}/con`,
      description: `+${fmtMag(2 * c.magnification)}/consonant; +${fmtMag(3 * c.magnification)}/consonant at 7+ letters.`,
    }),
  },

  VocalVowels: {
    name: "Vocal Vowels",
    rarity: CardRarity.Common,
    color: "#74b291",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) =>
      add(v, c.vowelIndices().length * (c.resolveWordLength() >= 7 ? 4 : 3) * c.magnification()),
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(3 * c.magnification)}/vwl`,
      description: `+${fmtMag(3 * c.magnification)}/vowel; +${fmtMag(4 * c.magnification)}/vowel at 7+ letters.`,
    }),
  },

  BrickLayer: {
    name: "Brick Layer",
    rarity: CardRarity.Common,
    color: "#b26a3a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 6 ? add(v, 3 * L * c.magnification()) : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(3 * c.magnification)}/ltr`,
      description: `+${fmtMag(3 * c.magnification)}/letter, only at 6+ letters.`,
    }),
  },

  TheBlueprint: {
    name: "Tempo",
    rarity: CardRarity.Common,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return c.prevWordLength === 0 || L >= c.prevWordLength
        ? add(v, 3 * L * c.magnification())
        : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(3 * c.magnification)}/ltr`,
      description: `+${fmtMag(3 * c.magnification)}/letter when your word is at least as long as the previous word; always pays on the first word.`,
    }),
  },

  LetterHoarder: {
    name: "Character Collector",
    rarity: CardRarity.Common,
    color: "#dcae4c",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => add(v, 2 * c.distinctLetters * c.magnification()),
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(2 * c.magnification)}/uniq`,
      description: `+${fmtMag(2 * c.magnification)} for each distinct letter.`,
    }),
  },

  HighRoller: {
    name: "High Roller",
    rarity: CardRarity.Common,
    color: "#b56276",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    fold: (v, c) => {
      const rareCount = [...c.word].filter((ch) => RARE_START.has(ch)).length;
      return rareCount > 0 ? add(v, 10 * rareCount * c.magnification()) : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(10 * c.magnification)}/rare`,
      description: `+${fmtMag(10 * c.magnification)} per rare letter (Q, X, Z, J).`,
    }),
  },

  BoosterPack: {
    name: "Booster Pack",
    rarity: CardRarity.Common,
    color: "#b26a3a",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    fold: (v, c) =>
      c.cardsToRight > 0
        ? add(v, 2 * c.cardsToRight * (c.slots ?? c.bayLength) * c.magnification())
        : skip(v),
    renderText: (c) => {
      const amount = 2 * c.cardsToRight * c.slots * c.magnification;
      return {
        magnitudeText: c.cardsToRight > 0 ? `+${fmtMag(amount)}` : "+0",
        description:
          c.cardsToRight > 0
            ? `+${fmtMag(2 * c.magnification)} per card to its right in the bay, multiplied by your slot count. (${c.cardsToRight} right × ${c.slots} slots = +${fmtMag(amount)}).`
            : "+2 per card to its right in the bay, multiplied by your slot count. (no cards to its right).",
      };
    },
  },

  Scavenger: {
    name: "Scavenger",
    rarity: CardRarity.Common,
    color: "#b26a3a",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    fold: (v, c) => {
      const n = c.history.filter((h) => h.word.includes(c.startsWith)).length;
      return n > 0 ? add(v, 2 * n * c.magnification()) : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(2 * c.magnification)}/word`,
      description: `+${fmtMag(2 * c.magnification)} per previously submitted word (any player's) containing your starting letter.`,
    }),
  },

  // ── §3.2 Core Multipliers (place right so they scale accumulated additives) ──
  VowelSurge: {
    name: "Vowel Surge",
    rarity: CardRarity.Uncommon,
    color: "#5c9a78",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) =>
      c.vowelIndices().length > c.consonantIndices().length
        ? mul(v, 3 * c.magnification())
        : skip(v),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(3 * c.magnification)}`,
      description: `×${fmtMag(3 * c.magnification)} when the word has more vowels than consonants.`,
    }),
  },

  TheArchitect: {
    name: "Architect",
    rarity: CardRarity.Rare,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) => (c.resolveWordLength() >= 8 ? mul(v, 3 * c.magnification()) : skip(v)),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(3 * c.magnification)}`,
      description: `×${fmtMag(3 * c.magnification)} when the word is 8+ letters.`,
    }),
  },

  Sesquipedalian: {
    name: "Deca-Quint",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    color: "#9878ae",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) => (c.resolveWordLength() >= 10 ? mul(v, 5 * c.magnification()) : skip(v)),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(5 * c.magnification)}`,
      description: `×${fmtMag(5 * c.magnification)} when the word is 10+ letters.`,
    }),
  },

  GutturalRoar: {
    name: "Chant",
    rarity: CardRarity.Uncommon,
    color: "#b26a3a",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    // Matches C# LINQ .All(): a word with no (active-classifier) vowels triggers vacuously.
    fold: (v, c) =>
      c.vowelIndices().every((i) => c.word[i] === "a" || c.word[i] === "e")
        ? mul(v, 2 * c.magnification())
        : skip(v),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(2 * c.magnification)}`,
      description: `×${fmtMag(2 * c.magnification)} when the word's only vowels are A or E.`,
    }),
  },

  PerfectLink: {
    name: "Perfect Link",
    rarity: CardRarity.Common,
    color: "#5c9a78",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) =>
      c.vowelIndices().includes(c.length - 1) ? mul(v, 1.5 * c.magnification()) : skip(v),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(1.5 * c.magnification)}`,
      description: `×${fmtMag(1.5 * c.magnification)} when the word ends in a vowel.`,
    }),
  },

  TryHard: {
    name: "Try Hard",
    rarity: CardRarity.Uncommon,
    color: "#cb8450",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L > 6 ? mul(v, round1(1.4 + 0.1 * (L - 6)) * c.magnification()) : skip(v);
    },
    // A length curve, not a flat factor: the resting face keeps the curve prose
    // and names the glass; the exact factor appears once a word is staged.
    renderText: (c) => ({
      magnitudeText: "×1.5+",
      description: `×1.5 at 7 letters, +0.1 per letter beyond.${glassNote(c)}`,
    }),
  },

  DoubleDown: {
    name: "Double Down",
    rarity: CardRarity.Uncommon,
    color: "#b56276",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    fold: (v, c) =>
      c.hasRepeatLetter ? mul(v, 2 * c.magnification()) : mul(v, 0.5 * c.magnification()),
    // Word-dependent branch (repeat or not): the resting face keeps both
    // outcomes and names the glass; the exact factor appears once staged.
    renderText: (c) => ({
      magnitudeText: "×2",
      description: `×2 with a repeat letter, else ×0.5.${glassNote(c)}`,
    }),
  },

  // ── §3.3 Glass cannon (multipliers paid in your own shot clock) ──
  /* The glass cannons are tuned cards: the GDD flags every clock-scaling multiplier for per-mode
   * re-costing (§4.4), because a Picker commit is far faster than typing and their timeout drains
   * never fire there at all. Writing the numbers once is what lets that be a numbers-only edit. */
  TheVault: tuned({
    tune: { factor: 1.5, clockPct: -0.2, timeoutLoss: 12 },
    // Picker levies the base timeout penalty but no per-card drain: `pickerTimeoutCurrent` scores
    // through `scoreTimeout`, so BASE_TIMEOUT_PENALTY fires there while this card's own fold stays
    // inert. Zeroing the knob retires the clause AND the fold from the same number, so the two can
    // never disagree again.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Overclock",
      rarity: CardRarity.Rare,
      color: "#6699bd",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      clock: { pctDelta: t.clockPct },
      fold: (v, c) => mul(v, t.factor * c.magnification()),
      // `timeoutLoss: 0` means inert, and the description above drops its clause from the same
      // number — so a mode without a timeout penalty cannot end up advertising one.
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
      renderText: (c) => ({
        magnitudeText: `×${fmtMag(t.factor * c.magnification)}`,
        description:
          `×${fmtMag(t.factor * c.magnification)} always; permanently ${fmtPct(t.clockPct * c.magnification)} shot clock.` +
          (t.timeoutLoss
            ? ` Time out and lose ${fmtMag(t.timeoutLoss * c.magnification)} points.`
            : ""),
        clockText: `${fmtPct(t.clockPct * c.magnification)} ⏱`,
      }),
    }),
  }),

  Redline: tuned({
    tune: { factor: 2, clockPct: -0.3, timeoutLoss: 24 },
    // Picker levies the base timeout penalty but no per-card drain: `pickerTimeoutCurrent` scores
    // through `scoreTimeout`, so BASE_TIMEOUT_PENALTY fires there while this card's own fold stays
    // inert. Zeroing the knob retires the clause AND the fold from the same number, so the two can
    // never disagree again.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Redline",
      rarity: CardRarity.Rare,
      color: "#c25a3a",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      clock: { pctDelta: t.clockPct },
      fold: (v, c) => mul(v, t.factor * c.magnification()),
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
      renderText: (c) => ({
        magnitudeText: `×${fmtMag(t.factor * c.magnification)}`,
        description:
          `×${fmtMag(t.factor * c.magnification)} always; permanently ${fmtPct(t.clockPct * c.magnification)} shot clock.` +
          (t.timeoutLoss
            ? ` Time out and lose ${fmtMag(t.timeoutLoss * c.magnification)} points.`
            : ""),
        clockText: `${fmtPct(t.clockPct * c.magnification)} ⏱`,
      }),
    }),
  }),

  PanicButton: tuned({
    tune: { perSecond: 0.05, cap: 2 },
    build: (t) => ({
      name: "Reflex",
      rarity: CardRarity.Uncommon,
      color: "#9c4a5e",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      fold: (v, c) =>
        mul(v, Math.min(t.cap, 1 + c.clockRemaining * t.perSecond) * c.magnification()),
      // A clock ratio, not a flat factor: the resting face scales the cap the
      // glass raises and names it; the exact factor appears once staged.
      renderText: (c) => ({
        magnitudeText: `≤×${fmtMag(t.cap * c.magnification)}`,
        description: `+×${t.perSecond} for every second left in your shot clock, capped at ×${fmtMag(t.cap * c.magnification)}.${glassNote(c)}`,
      }),
    }),
  }),

  SlowBurn: {
    name: "Slow Burn",
    rarity: CardRarity.Uncommon,
    color: "#cb8450",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    clock: { pctDelta: 0.3 },
    fold: (v) => fx(v),
    illegalWord: (c) => c.resolveWordLength() < 6,
    renderText: (c) => ({
      magnitudeText: "FX",
      description: `${fmtPct(0.3 * c.magnification)} shot clock. Words shorter than 6 letters are taxed.`,
      clockText: `${fmtPct(0.3 * c.magnification)} ⏱`,
    }),
  },

  Speedracer: tuned({
    /* `ratioWeight` is a weight on the remaining/total ratio, and 1 is the identity — the GDD asks
     * to "retune the curves, not the caps" (§4.4), and this is the knob that curve needs. At 1 the
     * expression differs from the original while the value does not, which is exactly what the
     * Classic lock verifies. A weight other than 1 must also reword the description below. */
    tune: { ratioWeight: 1, timeoutLoss: 10 },
    // Picker levies the base timeout penalty but no per-card drain: `pickerTimeoutCurrent` scores
    // through `scoreTimeout`, so BASE_TIMEOUT_PENALTY fires there while this card's own fold stays
    // inert. Zeroing the knob retires the clause AND the fold from the same number, so the two can
    // never disagree again.
    perMode: { [GameMode.Picker]: { timeoutLoss: 0 } },
    build: (t) => ({
      name: "Speedracer",
      rarity: CardRarity.Uncommon,
      maxInstances: 2,
      color: "#dcae4c",
      family: CardFamily.Clock,
      op: CardOp.Multiplicative,
      fold: (v, c) =>
        mul(v, (1 + t.ratioWeight * (c.clockRemaining / c.clockTotal)) * c.magnification()),
      timeoutFold: (v, c) => (t.timeoutLoss ? add(v, -t.timeoutLoss * c.magnification()) : skip(v)),
      // A clock ratio: the resting face keeps the curve prose and names the
      // glass; the timeout drain (a flat number) scales exactly. The curve
      // coefficient renders too, so a retune of the curve rewords the face
      // instead of leaving prose that describes the old one.
      renderText: (c) => ({
        magnitudeText: "×(1+Rem /Total)",
        description:
          `×(1 + ${t.ratioWeight === 1 ? "" : `${t.ratioWeight} × `}remaining clock time ÷ total clock time).${glassNote(c)}` +
          (t.timeoutLoss
            ? ` Time out and lose ${fmtMag(t.timeoutLoss * c.magnification)} points.`
            : ""),
      }),
    }),
  }),

  Blindfold: {
    name: "Blindfold",
    rarity: CardRarity.Uncommon,
    maxInstances: 1,
    // Classic-only: its whole downside is masking the input box while you type, and Picker has no
    // input box — in Picker this would be a ×1.5 with no cost at all.
    modes: [GameMode.Classic],
    color: "#6699bd",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    fold: (v, c) => mul(v, 1.5 * c.magnification()),
    timeoutFold: (v, c) => add(v, -8 * c.magnification()),
    hidesInput: () => true,
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(1.5 * c.magnification)}`,
      description: `×${fmtMag(1.5 * c.magnification)} always; hides your own input box while you type. Time out and lose ${fmtMag(8 * c.magnification)} points.`,
    }),
  },

  // ── §3.8 Utility (FX; 0 points, enabling capabilities) ──
  HeatSink: {
    name: "Heat Sink",
    rarity: CardRarity.Common,
    color: "#74b291",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    clock: { pctDelta: 0.3 },
    fold: (v, c) => mul(v, 0.9 * c.magnification()),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(0.9 * c.magnification)}`,
      description: `${fmtPct(0.3 * c.magnification)} shot clock, but ×${fmtMag(0.9 * c.magnification)} to your score.`,
      clockText: `${fmtPct(0.3 * c.magnification)} ⏱`,
    }),
  },

  Catalyst: {
    name: "Catalyst",
    rarity: CardRarity.Uncommon,
    color: "#9878ae",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    isVowel: (ch) => "aeiouywh".includes(ch),
    renderText: () =>
      staticFace(
        "FX",
        "For every card placed to its right: Y, W and H count as vowels as well as consonants.",
      ),
  },

  Forgery: {
    name: "Forgery",
    rarity: CardRarity.Legendary,
    color: "#dcae4c",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // Perceived = double the count seen BEFORE this card (so glasses stack), then
    // scaled by a glass magnifying Forgery itself (×2 → ×3), rounded half-up.
    perceivedLength: (c) => Math.floor(c.resolveWordLength() * 2 * c.magnification() + 0.5),
    renderText: (c) => ({
      magnitudeText: "FX",
      description:
        c.magnification > 1
          ? `Every card that checks the word length percieves it to be ×${fmtMag(2 * c.magnification)} as long.`
          : "Every card that checks the word length percieves it to be twice as long.",
    }),
  },

  MagnifyingGlass: {
    name: "Magnifying Glass",
    rarity: CardRarity.Rare,
    // The only card capped ABOVE the default 3, and deliberately so: five in series
    // compound to ×7.59375, which we want reachable as a build-around rather than
    // impossible. Rarity is the brake here — at Rare the dealer rarely offers five,
    // and five glasses plus something to magnify needs 6 of the 12 max bay slots.
    maxInstances: 5,
    color: "#6699bd",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    submitMagnifications: (reg, i) => reg.push(i + 1, 1.5 * reg.getMagnification(i)),
    // A glassed glass compounds: its output is its own magnification × 1.5.
    renderText: (c) => ({
      magnitudeText: "FX",
      description:
        c.magnification > 1
          ? `Magnifies the card to its right by ×${fmtMag(1.5 * c.magnification)}. Stackable.`
          : "Magnifies the card to its right by ×1.5. Stackable.",
    }),
  },

  Wildcard: {
    name: "Wildcard",
    rarity: CardRarity.Rare,
    color: "#dcae4c",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    roomServices: ["wildcardGuard"],
    // Available until consumed this era; the match consumes it only on an accepted bypass.
    ignoresSuccession: (c) =>
      !!c.player && (c.services?.wildcardGuard.isAvailable(c.player.id) ?? false),
    renderText: (c) => {
      if (c.wildcardUsed) {
        return {
          magnitudeText: "FX",
          description: "Once per era, you may ignore the starting letter. Used by this word.",
          badge: "USED",
        };
      }
      return {
        magnitudeText: "FX",
        description: `Once per era, you may ignore the starting letter. ${c.wildcardAvailable ? "Charge available." : "Spent this era."}`,
        badge: c.wildcardAvailable ? "READY" : "SPENT",
        spent: !c.wildcardAvailable,
      };
    },
  },

  Prism: {
    name: "Prism",
    rarity: CardRarity.Rare,
    color: "#74b291",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    roomServices: ["prismGuard"],
    rescueClock: (c) => {
      if (c.player && c.services?.prismGuard.tryConsume(c.player.id)) {
        c.clock?.refillToFull();
        return true;
      }
      return false;
    },
    renderText: (c) => ({
      magnitudeText: "FX",
      description: `Once per era, when your shot clock runs out your clock resets instead of ending your turn. ${c.prismAvailable ? "Charge available." : "Spent this era."}`,
      badge: c.prismAvailable ? "READY" : "SPENT",
      spent: !c.prismAvailable,
    }),
  },

  IrsAgent: {
    name: "Fancy Accounting",
    rarity: CardRarity.Common,
    color: "#5c9a78",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    ownTaxScore: () => 0,
    suppressesSiphon: true,
    renderText: () =>
      staticFace("FX", "When your word is taxed, no Tax Collector collects from you."),
  },

  TaxWriteOff: {
    name: "Tax Write-Off",
    rarity: CardRarity.Common,
    color: "#4f7fa4",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    writeOffBonus: (c, score) =>
      c.word.length > 0 ? score(c.word.substring(0, Math.ceil(c.word.length / 2))) : 0,
    // The salvage re-scores through this slot, so a glass on it scales the bonus.
    renderText: (c) => ({
      magnitudeText: "FX",
      description: `When your word is taxed, score the first half of it through your engine anyways.${glassNote(c)}`,
    }),
  },

  // ── §3.4 Personal-ban economy ──
  RouletteWheel: {
    name: "Roulette Wheel",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    color: "#9c4a5e",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    fold: (v, c) => mul(v, 2 * c.magnification()),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, c.cardIndex, CardId.RouletteWheel, ban);
    },
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(2 * c.magnification)}`,
      description:
        `Each era, you get a new personal banned letter. ×${fmtMag(2 * c.magnification)} on every word.` +
        (c.personalBan ? ` (ban: ${c.personalBan.toUpperCase()}).` : ""),
    }),
  },

  TollBooth: {
    name: "Toll Booth",
    rarity: CardRarity.Rare,
    maxInstances: 1,
    color: "#c8952f",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, c.cardIndex, CardId.TollBooth, ban);
    },
    // The toll payout scales with a glass on this slot — name it.
    renderText: (c) => ({
      magnitudeText: "FX",
      description:
        `Each era, you get a personal banned letter. Bank 20% of any opponent's score when their word uses that letter.${glassNote(c)}` +
        (c.personalBan ? ` (ban: ${c.personalBan.toUpperCase()}).` : ""),
    }),
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
    color: "#5c9a78",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // The bounty scales with a glass on this slot — name it.
    renderText: (c) => ({
      magnitudeText: "FX",
      description: `When an opponent is taxed, collect 60% of their would-be score.${glassNote(c)}`,
    }),
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

  /* Tuned: pure elapsed-time payout — fast submits deny the card, slow submits feed
   * it (capped), and real timeouts bounty the cap (see timeoutCurrent/pickerTimeoutCurrent).
   * Inverts the old remaining-time formula, whose dominant response was stalling to ~0s.
   *
   * INTENTIONAL: the cap applies to the base payout BEFORE Magnifying Glass
   * magnification, so a glassed Syphon can pay out above the nominal max (e.g. a
   * 30s stall at ×1.5 pays 45 against a stated "max 30"). This matches the other
   * capped cards (Panic Button, Flywheel, Crescendo), which likewise cap the base
   * factor and then multiply by magnification. */
  ChronoSyphon: tuned({
    tune: { perSecond: 1, cap: 30 },
    build: (t) => ({
      name: "Chrono Syphon",
      rarity: CardRarity.Uncommon,
      color: "#5c9a78",
      family: CardFamily.Economy,
      op: CardOp.Fx,
      fold: (v) => fx(v),
      // The payout scales with a glass on this slot — name it.
      renderText: (c) => ({
        magnitudeText: "FX",
        description: `+${t.perSecond} per whole second taken on an opponent's shot clock when they submit, max ${t.cap}.${glassNote(c)}`,
      }),
      onOpponentWordResolved: (c) => {
        const res = c.resolution;
        if (!res) return;
        const owner = c.player;
        if (!owner || owner.id === res.submitterId) return;
        const elapsed = Math.floor(c.clockTotal - c.clockRemaining);
        if (elapsed <= 0) return;
        // Cap-before-magnification is intentional: cap the base payout, then let a
        // glass multiply above the nominal max (see catalogue comment above).
        const amount = clampScore(Math.min(t.cap, elapsed * t.perSecond) * c.magnification());
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
    color: "#9878ae",
    family: CardFamily.Utility,
    op: CardOp.Fx,
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
    renderText: () =>
      staticFace(
        "FX",
        "When your word is taxed, the next player must use that banned letter for their turn.",
      ),
  },

  // ── Rebalance additions: archetypes to rival the speed build ────────────────
  // Long-word / Wordsmith — reward big words and the time to type them.
  TheLexicon: {
    name: "Scholar",
    rarity: CardRarity.Uncommon,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    clock: { pctDelta: 0.15 },
    fold: (v, c) => (c.resolveWordLength() >= 9 ? mul(v, 2 * c.magnification()) : skip(v)),
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(2 * c.magnification)} @9+`,
      description: `×${fmtMag(2 * c.magnification)} when your word is 9+ letters; ${fmtPct(0.15 * c.magnification)} shot clock.`,
      clockText: `${fmtPct(0.15 * c.magnification)} ⏱`,
    }),
  },

  Stonemason: {
    name: "Stonemason",
    rarity: CardRarity.Uncommon,
    color: "#b26a3a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 8 ? add(v, 4 * L * c.magnification()) : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `+${fmtMag(4 * c.magnification)}/ltr`,
      description: `+${fmtMag(4 * c.magnification)}/letter, only at 8+ letters.`,
    }),
  },

  // Economy / Parasite — bank off opponents (Loan Shark taxes the big scorers).
  LoanShark: {
    name: "Loan Shark",
    rarity: CardRarity.Uncommon,
    color: "#5c9a78",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // The cut scales with a glass on this slot — name it.
    renderText: (c) => ({
      magnitudeText: "FX",
      description: `Bank 15% of any opponent's word worth more than 30 points. Only applies if they are ahead of you on the leaderboard.${glassNote(c)}`,
    }),
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
    color: "#c8952f",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    fold: (v, c) => {
      const rare = [...c.word].filter((ch) => RARE_START.has(ch)).length;
      return rare > 0 ? mul(v, (1 + 0.6 * rare) * c.magnification()) : skip(v);
    },
    // A per-letter curve: the resting face keeps the curve prose and names the
    // glass; the exact factor appears once a word is staged.
    renderText: (c) => ({
      magnitudeText: "×1.6 /rare",
      description: `×(1 + 0.6 per rare letter Q, X, Z, J).${glassNote(c)}`,
    }),
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
      color: "#c25a3a",
      family: CardFamily.Utility,
      op: CardOp.Fx,
      // A plain percent, not fmtPct: the shave's sign is carried by the word "Shave", so a signed
      // "+20%" would read as the opposite of what the card does.
      fold: (v) => fx(v),
      roomServices: ["timePenalty"],
      // The shave scales with a glass on this slot — name the effective cut.
      renderText: (c) => ({
        magnitudeText: "FX",
        description:
          c.magnification > 1
            ? `Shave ${Math.round(t.shavePct * 100)}% off the shot clock of the leader (×${fmtMag(c.magnification)} glass → ${Math.round(t.shavePct * c.magnification * 100)}%). This applies to you if you are in the lead.`
            : `Shave ${Math.round(t.shavePct * 100)}% off the shot clock of the leader. This applies to you if you are in the lead.`,
      }),
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
    // Classic-only: it negates the timeout point penalty, and Picker's timeout levies only the
    // base loss with every per-card drain zeroed — so the card would refund just the base while
    // taking up a bay slot tuned for Classic's deeper penalty walk. Kept out of the Picker pool.
    modes: [GameMode.Classic],
    color: "#6699bd",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // Negate the timeout loss: bring the running penalty back up to 0 (the refund is
    // shown in the replay). negatesTimeoutLoss also floors the net at 0 so glass-cannon
    // drains placed to the right of this card can't re-open a loss (order-independent).
    negatesTimeoutLoss: true,
    timeoutFold: (v) => (v < 0 ? add(v, -v) : skip(v)),
    renderText: () => staticFace("FX", "If you time out, you lose no points."),
  },

  TheFlywheel: {
    name: "Flywheel",
    rarity: CardRarity.Rare,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
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
    renderText: (c) => {
      if (c.otherMultipliers === 0) {
        return {
          magnitudeText: "—",
          description:
            "×1.15 for each other multiplier card in your bay (capped at ×2.3). (no other multipliers in your bay).",
        };
      }
      const factor = Math.min(2.3, round1(1 + 0.15 * c.otherMultipliers)) * c.magnification;
      return {
        magnitudeText: `×${fmtMag(factor)}`,
        description: `×1.15 for each other multiplier card in your bay (capped at ×2.3). (${c.otherMultipliers} other multiplier${c.otherMultipliers === 1 ? "" : "s"} = ×${fmtMag(factor)}).`,
      };
    },
  },

  // ── New archetype cards: word quality, clean-streak consistency, engine width ──
  Tilesmith: {
    name: "Tilesmith",
    rarity: CardRarity.Common,
    color: "#c8952f",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    fold: (v, c) => add(v, tileValue(c.word) * c.magnification()),
    // Per-letter tile values resolve per word: the resting face names the glass;
    // the exact total appears once a word is staged.
    renderText: (c) => ({
      magnitudeText: "+tile",
      description: `Scores the word based on its letter-tile values (Scrabble-style).${glassNote(c)}`,
    }),
  },

  Crescendo: {
    name: "Crescendo",
    rarity: CardRarity.Uncommon,
    color: "#b56276",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    roomServices: ["crescendoStreak"],
    fold: (v, c) => {
      const streak = c.player && c.services ? c.services.crescendoStreak.get(c.player.id) : 0;
      return streak > 0 ? mul(v, Math.min(2, 1 + 0.25 * streak) * c.magnification()) : skip(v);
    },
    renderText: (c) => {
      const factor = (c.streak > 0 ? Math.min(2, 1 + 0.25 * c.streak) : 1) * c.magnification;
      const next = Math.min(2, 1 + 0.25 * (c.streak + 1)) * c.magnification;
      return {
        magnitudeText: `×${fmtMag(factor)}`,
        description:
          "×(1 + 0.25 per word you've played this era), capped at ×2. Being taxed or timing out resets it." +
          ` Streak ${c.streak}` +
          (c.streak > 0 ? ` (next word ×${fmtMag(next)}).` : " — play clean to start it."),
        badge: `STREAK ${c.streak}`,
      };
    },
  },

  Bookends: {
    name: "Bookends",
    rarity: CardRarity.Common,
    color: "#6699bd",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    fold: (v, c) => {
      const w = c.word;
      return w.length >= 2 && w[0] === w[w.length - 1] ? mul(v, 2 * c.magnification()) : skip(v);
    },
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(2 * c.magnification)}`,
      description: `×${fmtMag(2 * c.magnification)} when the word's first and last letter are the same.`,
    }),
  },

  Dividend: {
    name: "Dividend",
    rarity: CardRarity.Common,
    color: "#5c9a78",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    fold: (v, c) => add(v, 2 * c.bayLength * c.magnification()),
    renderText: (c) => {
      const amount = 2 * c.scoringCount * c.magnification;
      return {
        magnitudeText: `+${fmtMag(amount)}`,
        description: `+${fmtMag(2 * c.magnification)} for each card in your bay. (${c.scoringCount} cards = +${fmtMag(amount)}).`,
      };
    },
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
    color: "#74b291",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    // States the guarantee the engine can actually keep. selectGoldenSeed clamps the floor to
    // min(minSeedLength, rackSize) because an 8-letter seed cannot be decomposed into a smaller
    // rack — so with Tunnel Vision, or a lobby rack under 8, the seed is the whole rack instead.
    fold: (v) => fx(v),
    // The cost: you can never duck a Banned Letter with a short safe word.
    preference: {
      minSeedLength: 8,
      filter: () => (w) => w.length >= 6,
    },
    renderText: () => staticFace("8+ seed", "Seeds your Tile Rack from a word of 8+ letters."),
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
      color: "#9878ae",
      family: CardFamily.Utility,
      op: CardOp.Fx,
      fold: (v) => fx(v),
      roomServices: ["winnowerGuard"],
      // The price is a FIXED fraction, so it grows harsher as your engine grows and each Offer
      // takes longer to read — the card gets worse exactly as your bay gets better.
      preference: { redraw: { clockCostFraction: t.clockCostFraction } },
      renderText: (c) => ({
        magnitudeText: "redraw",
        description: `Once per turn, redraw your whole Tile Rack for ${Math.round(t.clockCostFraction * 100)}% of your shot clock. ${c.winnowerAvailable ? "Redraw available." : "Spent this turn."}`,
        badge: c.winnowerAvailable ? "READY" : "SPENT",
        spent: !c.winnowerAvailable,
      }),
    }),
  }),

  WideNet: {
    name: "Wide Net",
    rarity: CardRarity.Common,
    modes: [GameMode.Picker],
    color: "#6699bd",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // A genuine ClockModifier, which is why armedClockSeconds keeps the FULL bay even though this
    // card is hidden from bay-size SCORING.
    clock: { pctDelta: -0.15 },
    preference: { countDelta: 2 },
    renderText: (c) => ({
      magnitudeText: "+2 / −15%",
      description: `+2 Rack tiles, and ${fmtPct(-0.15 * c.magnification)} shot clock.`,
      clockText: `${fmtPct(-0.15 * c.magnification)} ⏱`,
    }),
  },

  TunnelVision: {
    name: "Tunnel Vision",
    rarity: CardRarity.Legendary,
    maxInstances: 1,
    modes: [GameMode.Picker],
    color: "#c25a3a",
    family: CardFamily.Utility,
    op: CardOp.Multiplicative,
    fold: (v, c) => mul(v, 1.4 * c.magnification()),
    // The one Preference Card that really scores, so it is placed and counted like any other
    // multiplier rather than bubbling left — see isInertPreference for why that must be so.
    preference: { countDelta: -2 },
    renderText: (c) => ({
      magnitudeText: `×${fmtMag(1.4 * c.magnification)}`,
      description: `×${fmtMag(1.4 * c.magnification)} always, but you have 2 fewer Rack tiles.`,
    }),
  },

  Prospector: {
    name: "Prospector",
    rarity: CardRarity.Uncommon,
    modes: [GameMode.Picker],
    color: "#dcae4c",
    family: CardFamily.Letter,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // The cost: one of your Offer slots is permanently spent on a word you may not want.
    preference: {
      guaranteeRare: true,
      guarantee: () => (w) => [...w].some((ch) => RARE_START.has(ch)),
    },
    renderText: () =>
      staticFace("1 rare", "Guarantees at least one rare letter (Q, X, Z, J) in your Tile Rack."),
  },

  Tide: {
    name: "Tide",
    rarity: CardRarity.Uncommon,
    modes: [GameMode.Picker],
    color: "#5c9a78",
    family: CardFamily.Letter,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // A SOFT bias, abandoned when the pool cannot serve it, so it never starves the Offer. The
    // cost is concentration: a narrower draw means more repeats and a thinner ending-letter graph.
    preference: {
      highVowelRatio: true,
      prefer: () => (w) => {
        let vowels = 0;
        for (const ch of w) if (isVowel(ch)) vowels++;
        return vowels * 2 >= w.length;
      },
    },
    renderText: () => staticFace("vowels", "Your Tile Rack is made vowel-heavy (>=50% vowels)."),
  },

  Sentinel: {
    name: "Sentinel",
    rarity: CardRarity.Rare,
    modes: [GameMode.Picker],
    color: "#6699bd",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    fold: (v) => fx(v),
    // Insurance against the Zero-Point Tax, paid for in slots — and it spends a bay slot on
    // safety rather than on ceiling. With no bans in force it guarantees nothing and costs nothing.
    preference: {
      excludeBannedLetters: true,
      guarantee: (ctx) =>
        ctx.bannedLetters.length === 0
          ? null
          : (w) => !ctx.bannedLetters.some((letter) => w.includes(letter)),
    },
    renderText: () => staticFace("1 safe", "Ensures your Tile Rack doesn't contain banned letters."),
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
