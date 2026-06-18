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

/** A card minus its `id` — the id is assigned from the catalogue key when
 *  CARD_LIBRARY is built, so the key and id can never desync. */
type CardDef = Omit<ModifierCard, "id">;

const CARD_DEFS: Record<CardId, CardDef> = {
  // ── §3.1 Core Additives (place left so multipliers act on a bigger base) ──
  TheAnchor: {
    name: "The Anchor",
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
    description: "+1 per letter; +2 per letter when the word is 7+ letters.",
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
    description: "+2 per consonant; +3 per consonant when the word is 7+ letters.",
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
    description: "+3 per vowel; +4 per vowel when the word is 7+ letters.",
    fold: (v, c) =>
      add(v, c.vowelIndices().length * (c.resolveWordLength() >= 7 ? 4 : 3) * c.magnification()),
  },

  BrickLayer: {
    name: "Brick Layer",
    color: "#d96a3c",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+3/ltr",
    description: "+3 per letter, but only when the word is 6+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 6 ? add(v, 3 * L * c.magnification()) : skip(v);
    },
  },

  TheBlueprint: {
    name: "The Blueprint",
    color: "#9ad0ff",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+3/ltr",
    description:
      "+3 per letter when your word is at least as long as the previous word (always pays on the first word).",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return c.prevWordLength === 0 || L >= c.prevWordLength
        ? add(v, 3 * L * c.magnification())
        : skip(v);
    },
  },

  LetterHoarder: {
    name: "Letter Hoarder",
    color: "#e9c46a",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+2/uniq",
    description: "+2 per distinct letter.",
    fold: (v, c) => add(v, 2 * c.distinctLetters * c.magnification()),
  },

  HighRoller: {
    name: "High Roller",
    color: "#ff5ca0",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+10/rare",
    description: "+10 for every rare letter in the word (Q, X, Z, J).",
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
    magnitudeText: "+3/right",
    description: "+3 for every card placed to the right of this one in the bay.",
    fold: (v, c) => (c.cardsToRight > 0 ? add(v, 3 * c.cardsToRight * c.magnification()) : skip(v)),
  },

  Scavenger: {
    name: "Scavenger",
    color: "#c08552",
    family: CardFamily.Economy,
    op: CardOp.Additive,
    magnitudeText: "+2/word",
    description:
      "+2 for every previously submitted word (any player's) that contains your word's starting letter.",
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
    name: "The Architect",
    color: "#8f8cff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×3",
    description: "×3 when the word is 8+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 8 ? mul(v, 3 * c.magnification()) : skip(v)),
  },

  Sesquipedalian: {
    name: "Sesquipedalian",
    maxInstances: 1,
    color: "#b06bff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×5",
    description: "×5 when the word is 10+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 10 ? mul(v, 5 * c.magnification()) : skip(v)),
  },

  GutturalRoar: {
    name: "Guttural Roar",
    color: "#c98a3c",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description: "×1.5 when the word's only vowels are A or E.",
    // Matches C# LINQ .All(): a word with no (active-classifier) vowels triggers vacuously.
    fold: (v, c) =>
      c.vowelIndices().every((i) => c.word[i] === "a" || c.word[i] === "e")
        ? mul(v, 1.5 * c.magnification())
        : skip(v),
  },

  PerfectLink: {
    name: "Perfect Link",
    color: "#57e08a",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description: "×1.5 when the word ends in a vowel (and hands an easy letter on).",
    fold: (v, c) =>
      c.vowelIndices().includes(c.length - 1) ? mul(v, 1.5 * c.magnification()) : skip(v),
  },

  TryHard: {
    name: "Try Hard",
    color: "#ff8c42",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.2+",
    description: "×1.2 at 7 letters, +0.1 per letter beyond (8 → ×1.3, 9 → ×1.4, …).",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L > 6 ? mul(v, round1(1.1 + 0.1 * (L - 6)) * c.magnification()) : skip(v);
    },
  },

  DoubleDown: {
    name: "The Double Down",
    color: "#ff4d9d",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 when the word has a repeat letter (the 'ff' in coffin), else ×0.5.",
    fold: (v, c) =>
      c.hasRepeatLetter ? mul(v, 2 * c.magnification()) : mul(v, 0.5 * c.magnification()),
  },

  // ── §3.3 Glass cannon (multipliers paid in your own shot clock) ──
  TheVault: {
    name: "The Vault",
    color: "#9fb3d6",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description: "×1.5 always; permanently −10% shot clock. Time out and lose 5 points.",
    clock: { pctDelta: -0.1 },
    fold: (v, c) => mul(v, 1.5 * c.magnification()),
    timeoutFold: (v, c) => add(v, -5 * c.magnification()),
  },

  Redline: {
    name: "Redline",
    maxInstances: 2,
    color: "#ff4d4d",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×2",
    description: "×2 always; permanently −20% shot clock. Time out and lose 12 points.",
    clock: { pctDelta: -0.2 },
    fold: (v, c) => mul(v, 2 * c.magnification()),
    timeoutFold: (v, c) => add(v, -12 * c.magnification()),
  },

  PanicButton: {
    name: "Panic Button",
    maxInstances: 2,
    color: "#ff2e6e",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.3–2.5",
    description:
      "Halves your shot clock. ×1.3 normally — but ×2.5 if you submit before the final 2 seconds. Time out and lose 20 points.",
    clock: { pctDelta: -0.5 },
    // ×2.5 when there are >=2s left (submitted early), else ×1.3.
    fold: (v, c) => mul(v, (c.clockRemaining >= 2 ? 2.5 : 1.3) * c.magnification()),
    timeoutFold: (v, c) => add(v, -20 * c.magnification()),
  },

  AnchorChain: {
    name: "The Anchor Chain",
    maxInstances: 1,
    color: "#5b7fb0",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×0.5/ltr",
    description:
      "Locks your shot clock to a strict, unmodifiable 5s for the era. In exchange: ×(0.5 per letter). Time out and lose 10 points.",
    // ×(0.5 per letter), Forgery-aware (resolveWordLength) — Forgery's whole point
    // is to inflate length scoring. Diverges from the C# AnchorChainCard, which
    // used the real length (an oversight in that port).
    fold: (v, c) => mul(v, 0.5 * c.resolveWordLength() * c.magnification()),
    timeoutFold: (v, c) => add(v, -10 * c.magnification()),
    shotClockOverride: () => 5,
  },

  HyperDrive: {
    name: "Hyper-Drive",
    maxInstances: 1,
    color: "#46d0ff",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.5",
    description:
      "Caps your shot clock at 5s. When your word is longer than 6 letters, ×1.5 to your score so far. Time out and lose 8 points.",
    // Per-word ×1.5 folded at its own slot (boosts the seed + everything to its left).
    fold: (v, c) => (c.resolveWordLength() > 6 ? mul(v, 1.5 * c.magnification()) : skip(v)),
    timeoutFold: (v, c) => add(v, -8 * c.magnification()),
    shotClockCap: () => 5,
  },

  SlowBurn: {
    name: "Slow Burn",
    color: "#ff9e57",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Lengthens your shot clock by 20%, but words shorter than 6 letters are illegal — they take the Zero-Point Tax.",
    clock: { pctDelta: 0.2 },
    fold: (v) => fx(v),
    illegalWord: (c) => c.resolveWordLength() < 6,
  },

  Speedracer: {
    name: "Speedracer",
    maxInstances: 2,
    color: "#ffd23f",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "≤×(ltr/2)",
    description:
      "When your word is longer than 6 letters, ×(1 ÷ [remaining ÷ total clock]), capped at half your letter count. Time out and lose 10 points.",
    fold: (v, c) => {
      if (c.resolveWordLength() <= 6) return skip(v);
      const cap = Math.floor(c.resolveWordLength() / 2);
      const factor = c.clockRemaining <= 0 ? cap : Math.min(c.clockTotal / c.clockRemaining, cap);
      return mul(v, factor * c.magnification());
    },
    timeoutFold: (v, c) => add(v, -10 * c.magnification()),
  },

  Blindfold: {
    name: "The Blindfold",
    maxInstances: 1,
    color: "#8a7dff",
    family: CardFamily.Clock,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.8",
    description:
      "×1.8 always; hides your own input box while you type (no peeking at typos). Time out and lose 8 points.",
    fold: (v, c) => mul(v, 1.8 * c.magnification()),
    timeoutFold: (v, c) => add(v, -8 * c.magnification()),
    hidesInput: () => true,
  },

  // ── §3.8 Utility (FX; 0 points, enabling capabilities) ──
  HeatSink: {
    name: "The Heat Sink",
    color: "#7fd8ff",
    family: CardFamily.Clock,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "+40% shot clock (buys time for long words; neutralises Redline / Vault).",
    clock: { pctDelta: 0.4 },
    fold: (v) => fx(v),
  },

  Catalyst: {
    name: "The Catalyst",
    color: "#b97bff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "For every card placed after it, the letters Y, W and H count as a vowel in addition to their consonant role.",
    fold: (v) => fx(v),
    isVowel: (ch) => "aeiouywh".includes(ch),
  },

  Forgery: {
    name: "Forgery",
    color: "#d8b46a",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Every length-scoring card placed after it perceives your word as having double the letters.",
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
    description:
      "Magnifies the card immediately to its right by ×1.5. Glasses in series compound (two → ×2.25).",
    fold: (v) => fx(v),
    submitMagnifications: (reg, i) => reg.push(i + 1, 1.5 * reg.getMagnification(i)),
  },

  Wildcard: {
    name: "The Wildcard",
    color: "#ffd34d",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Once per era, one of your words may ignore the Succession rule — it need not begin with the previous word's last letter.",
    fold: (v) => fx(v),
    roomServices: ["wildcardGuard"],
    // Available until consumed this era; the match consumes it only on an accepted bypass.
    ignoresSuccession: (c) =>
      !!c.player && (c.services?.wildcardGuard.isAvailable(c.player.id) ?? false),
  },

  Prism: {
    name: "The Prism",
    color: "#6fe0ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "If your word is a typo or fails validation, your shot clock resets to full — once per era — instead of ticking away.",
    fold: (v) => fx(v),
    roomServices: ["prismGuard"],
    onValidationFailed: (c) => {
      if (c.player && c.services?.prismGuard.tryConsume(c.player.id)) c.clock?.refillToFull();
    },
  },

  IrsAgent: {
    name: "The IRS Agent",
    color: "#4caf6e",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "When YOUR word is hit by the Zero-Point Tax, no opponent's Tax Collector collects a thing.",
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
    description:
      "When your word is taxed, score its first letter through your engine as a clean submission and add that on top.",
    fold: (v) => fx(v),
    writeOffBonus: (c, score) => (c.word.length > 0 ? score(c.word[0]) : 0),
  },

  // ── §3.4 Personal-ban economy ──
  RouletteWheel: {
    name: "The Roulette Wheel",
    maxInstances: 1,
    color: "#e0457b",
    family: CardFamily.Economy,
    op: CardOp.Multiplicative,
    magnitudeText: "×1.75",
    description:
      "Each era, rolls you a personal banned letter (Zero-Point Tax if you use it). Reward: ×1.75 on every clean word.",
    fold: (v, c) => mul(v, 1.75 * c.magnification()),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, c.cardIndex, CardId.RouletteWheel, ban);
    },
  },

  TollBooth: {
    name: "The Toll Booth",
    maxInstances: 1,
    color: "#caa24a",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Each era, rolls you a personal banned letter. Toll: bank 20% of any opponent's score when their word uses that letter.",
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
    description: "When an opponent eats the Zero-Point Tax, collect 60% of the would-be score.",
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
    description:
      "Banks +2 for every whole second left on an opponent's shot clock when they submit.",
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

  // ── §3.6 Automated aggression (route through the victim's Titanium Mirror) ──
  FlakCannon: {
    name: "Flak Cannon",
    color: "#ff7043",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "Takes 10% off the next shot clock of every player scoring higher than you.",
    fold: (v) => fx(v),
    roomServices: ["timePenalty"],
    onTurnEnded: (c) => {
      const owner = c.player;
      const fx2 = c.effects;
      if (!owner || !fx2) return;
      const mag = c.magnification();
      for (const opp of fx2.orderedActivePlayers()) {
        if (opp.id === owner.id || opp.score <= owner.score) continue;
        const shave = Math.max(1, Math.round(fx2.armedClockOf(opp) * 0.1 * mag));
        fx2.timeShave(owner, opp, shave, "Flak Cannon");
      }
    },
  },

  BountyHunter: {
    name: "The Bounty Hunter",
    color: "#d4a017",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "Marks the round leader — if they play a word shorter than 6 letters, they lose 15 points.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      const fx2 = c.effects;
      if (!res || !fx2) return;
      if (res.submitterId !== fx2.roundLeaderId || res.word.length >= 6) return;
      const owner = c.player;
      const leader = c.players?.find((p) => p.id === res.submitterId);
      if (!owner || !leader || owner.id === leader.id) return;
      fx2.drain(owner, leader, Math.round(15 * c.magnification()), "Bounty Hunter");
    },
  },

  BaitAndSwitch: {
    name: "Bait & Switch",
    color: "#b388ff",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "When your word is taxed, curse the next player with that exact banned letter for their next turn.",
    fold: (v) => fx(v),
    roomServices: ["hijackBan"],
    onTurnEnded: (c) => {
      const res = c.resolution;
      const fx2 = c.effects;
      if (!res || !res.taxed || !res.offendingLetter || !fx2) return;
      const owner = c.player;
      if (!owner) return;
      const next = fx2.peekNextActivePlayer(owner.id);
      if (next) fx2.letterHijack(owner, next, res.offendingLetter, "Bait & Switch");
    },
  },

  // ── §3.7 The Shield ──
  TitaniumMirror: {
    name: "The Titanium Mirror",
    maxInstances: 1,
    color: "#9fd3e0",
    family: CardFamily.Utility,
    op: CardOp.Multiplicative,
    magnitudeText: "shield",
    description:
      "Passive ×1.0. Blocks and reflects incoming attacks back at their source — but loses 0.1× per block, across eras.",
    roomServices: ["shield"],
    fold: (v, c) => {
      const m = c.player && c.services ? c.services.shield.getMultiplier(c.player.id) : 1;
      return mul(v, m * c.magnification());
    },
    intercept: (owner, services) => {
      services.shield.decay(owner.id, 0.1);
      return true;
    },
  },

  // ── Rebalance additions: archetypes to rival the speed build ────────────────
  // Long-word / Wordsmith — reward big words and the time to type them.
  TheLexicon: {
    name: "The Lexicon",
    color: "#7bb0ff",
    family: CardFamily.Letter,
    op: CardOp.Multiplicative,
    magnitudeText: "×2 @9+",
    description:
      "×2 when your word is 9+ letters — and +15% shot clock, so you have time to type it.",
    clock: { pctDelta: 0.15 },
    fold: (v, c) => (c.resolveWordLength() >= 9 ? mul(v, 2 * c.magnification()) : skip(v)),
  },

  Stonemason: {
    name: "Stonemason",
    color: "#b5651d",
    family: CardFamily.Letter,
    op: CardOp.Additive,
    magnitudeText: "+4/ltr",
    description: "+4 per letter, but only when the word is 8+ letters.",
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
    description: "Bank 15% of any opponent's word that scores more than 30 points.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.taxed || res.earnedScore <= 30) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
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
    op: CardOp.Additive,
    magnitudeText: "+6/rare",
    description: "+6 for every rare letter (Q, X, Z, J) and +2 per distinct letter.",
    fold: (v, c) => {
      const rare = [...c.word].filter((ch) => RARE_START.has(ch)).length;
      return add(v, (6 * rare + 2 * c.distinctLetters) * c.magnification());
    },
  },

  // Aggression / Control — deny tempo (now sharper because timeouts cost points).
  TheSniper: {
    name: "The Sniper",
    color: "#ff5252",
    family: CardFamily.Utility,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description:
      "At turn end, shave 20% off the next shot clock of the single highest-scoring opponent above you.",
    fold: (v) => fx(v),
    roomServices: ["timePenalty"],
    onTurnEnded: (c) => {
      const owner = c.player;
      const fx2 = c.effects;
      if (!owner || !fx2) return;
      let top: PlayerState | null = null;
      for (const opp of fx2.orderedActivePlayers()) {
        if (opp.id === owner.id) continue;
        if (!top || opp.score > top.score) top = opp;
      }
      if (top && top.score > owner.score) {
        const shave = Math.max(1, Math.round(fx2.armedClockOf(top) * 0.2 * c.magnification()));
        fx2.timeShave(owner, top, shave, "The Sniper");
      }
    },
  },

  TheLeech: {
    name: "The Leech",
    color: "#7a4fb0",
    family: CardFamily.Economy,
    op: CardOp.Fx,
    magnitudeText: "FX",
    description: "At turn end, drain 3 points from every player scoring higher than you.",
    fold: (v) => fx(v),
    onTurnEnded: (c) => {
      const owner = c.player;
      const fx2 = c.effects;
      if (!owner || !fx2) return;
      const amount = Math.max(1, Math.round(3 * c.magnification()));
      for (const opp of fx2.orderedActivePlayers()) {
        if (opp.id === owner.id || opp.score <= owner.score) continue;
        fx2.drain(owner, opp, amount, "The Leech");
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
    description:
      "Scores nothing on a normal word — but if you time out, regain 10 points (offsetting the base timeout penalty).",
    fold: (v) => fx(v),
    // The proof that the timeout pass is general, not debuff-only: a REWARD fold.
    timeoutFold: (v) => add(v, 10),
  },

  TheFlywheel: {
    name: "The Flywheel",
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
