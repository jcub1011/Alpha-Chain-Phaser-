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
 * evaluator. DEALABLE_CARD_IDS only widens as each card's tests pass.
 */

import { add, clampScore, fx, mul, RARE_START, skip, type ModifierCard } from "./card";
import { CardFamily, CardId, CardOp } from "../types";
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

/** A card minus its `id` — the id is assigned from the catalogue key when
 *  CARD_LIBRARY is built, so the key and id can never desync. */
type CardDef = Omit<ModifierCard, "id">;

const CARD_DEFS: Record<CardId, CardDef> = {
  // ── §3.1 Core Additives (place left so multipliers act on a bigger base) ──
  TheAnchor: {
    name: "Decard",
    color: "#4f9dff",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+10",
    description: "+10 to your submission",
    fold: (v, c) => add(v, 10 * c.magnification()),
  },

  Vanilla: {
    name: "Vanilla",
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
    color: "#e9c46a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+2/uniq",
    description: "+2 for each distinct letter.",
    fold: (v, c) => add(v, 2 * c.distinctLetters * c.magnification()),
  },

  HighRoller: {
    name: "High Roller",
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
    color: "#8f8cff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×3",
    description: "×3 when the word is 8+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 8 ? mul(v, 3 * c.magnification()) : skip(v)),
  },

  Sesquipedalian: {
    name: "Deca-Quint",
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
    color: "#ff4d9d",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 with a repeat letter, else ×0.5.",
    fold: (v, c) =>
      c.hasRepeatLetter ? mul(v, 2 * c.magnification()) : mul(v, 0.5 * c.magnification()),
  },

  // ── §3.3 Glass cannon (multipliers paid in your own shot clock) ──
  TheVault: {
    name: "Overclock",
    color: "#9fb3d6",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description: "×1.5 always; permanently −20% shot clock. Time out and lose 12 points.",
    clock: { pctDelta: -0.2 },
    fold: (v, c) => mul(v, 1.5 * c.magnification()),
    timeoutFold: (v, c) => add(v, -12 * c.magnification()),
  },

  Redline: {
    name: "Redline",
    color: "#ff4d4d",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 always; permanently −30% shot clock. Time out and lose 24 points.",
    clock: { pctDelta: -0.3 },
    fold: (v, c) => mul(v, 2 * c.magnification()),
    timeoutFold: (v, c) => add(v, -24 * c.magnification()),
  },

  PanicButton: {
    name: "Reflex",
    color: "#ff2e6e",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "≤×2",
    description: "+×0.05 for every second left in your shot clock, capped at ×2.",
    fold: (v, c) => mul(v, Math.min(2, 1 + c.clockRemaining * 0.05) * c.magnification()),
  },

  SlowBurn: {
    name: "Slow Burn",
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

  Speedracer: {
    name: "Speedracer",
    maxInstances: 2,
    color: "#ffd23f",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×(1+Remain /Total)",
    description: "×(1 + remaining clock time ÷ total clock time). Time out and lose 10 points.",
    fold: (v, c) => mul(v, (1 + c.clockRemaining / c.clockTotal) * c.magnification()),
    timeoutFold: (v, c) => add(v, -10 * c.magnification()),
  },

  Blindfold: {
    name: "Blindfold",
    maxInstances: 1,
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

  ChronoSyphon: {
    name: "Chrono Syphon",
    color: "#5ad0c4",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "+2 per whole second left on an opponent's shot clock when they submit.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.remainingSeconds <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const amount = clampScore(res.remainingSeconds * 2 * c.magnification());
      if (amount > 0) {
        owner.score += amount;
        c.effects?.bankSiphon(owner.id, amount, "Chrono Syphon");
      }
    },
  },

  BaitAndSwitch: {
    name: "Bait & Switch",
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
  TheSniper: {
    name: "Blind Sniper",
    color: "#ff5252",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Shave 20% off the shot clock of the leader. This applies to you if you are in the lead.",
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
        const shave = Math.max(1, Math.round(fx2.armedClockOf(top) * 0.2 * c.magnification()));
        fx2.timeShave(top, shave, "Blind Sniper");
      }
    },
  },

  // Defensive / Combo engine.
  Insurance: {
    name: "Insurance",
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
    color: "#8f8cff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.15+",
    description: "×1.15 for each other multiplier card in your bay (capped at ×2.3).",
    fold: (v, c) => {
      const ids = c.bayCardIds ?? [];
      const others = ids.filter(
        (id, i) => i !== c.cardIndex && getCard(id)?.op === CardOp.Multiplicative,
      ).length;
      if (others === 0) return skip(v);
      const factor = Math.min(2.3, round1(1 + 0.15 * others));
      return mul(v, factor * c.magnification());
    },
  },

  // ── New archetype cards: word quality, clean-streak consistency, engine width ──
  Tilesmith: {
    name: "Tilesmith",
    color: "#c9a227",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+tile",
    description: "Scores the word based on its letter-tile values (Scrabble-style).",
    fold: (v, c) => add(v, tileValue(c.word) * c.magnification()),
  },

  Crescendo: {
    name: "Crescendo",
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
    color: "#4caf6e",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+2/card",
    description: "+2 for each card in your bay.",
    fold: (v, c) => add(v, 2 * c.bayLength * c.magnification()),
  },
};

/** The runtime catalogue. Each card's `id` is assigned from its CARD_DEFS key,
 *  so the key and id are the same value by construction (no desync possible). */
export const CARD_LIBRARY: Record<CardId, ModifierCard> = Object.fromEntries(
  Object.entries(CARD_DEFS).map(([id, def]) => [id, { id, ...def }]),
) as Record<CardId, ModifierCard>;

/** Ids dealt to players. Widens as each phase's cards land + pass tests. */
export const DEALABLE_CARD_IDS: CardId[] = Object.keys(CARD_LIBRARY) as CardId[];

export const getCard = (id: string): ModifierCard | undefined =>
  (CARD_LIBRARY as Record<string, ModifierCard>)[id];
