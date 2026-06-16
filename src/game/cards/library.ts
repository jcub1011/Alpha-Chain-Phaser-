/*
 * The Alpha Chain modifier card catalogue (alpha-chain-gdd.md §3). Behaviour is
 * faithful to the Blazor ModifierCardFactory; card ids match the SVG symbol ids
 * in public/assets/cards.svg. Every real scoring card multiplies its magnitude
 * by ctx.magnification() (a Magnifying Glass on its immediate left); inert FX
 * cards leave their factor at 1.0 so a glass never turns FX into a multiplier.
 *
 * Length-scoring cards read ctx.resolveWordLength() (Forgery-aware perceived
 * length); per-character cards read the real characters via ctx.vowelIndices()
 * / consonantIndices() (Catalyst-aware) and are unaffected by Forgery.
 *
 * Cards are added in build phases; the glass-cannon clocks (A2), tax/economy
 * (A3/A4) and aggression/shield (A5) cards plug in without touching the
 * evaluator. DEALABLE_CARD_IDS only widens as each card's tests pass.
 */

import { add, clampScore, fx, mul, RARE_START, skip, type ModifierCard } from "./card";

/** Round to one decimal (per-letter multiplier steps are 0.1) for clean chips. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

export const CARD_LIBRARY: Record<string, ModifierCard> = {
  // ── §3.1 Core Additives (place left so multipliers act on a bigger base) ──
  TheAnchor: {
    id: "TheAnchor",
    name: "The Anchor",
    color: "#4f9dff",
    family: "letter",
    op: "additive",
    magnitudeText: "+10",
    description: "+10 flat, always.",
    fold: (v, c) => add(v, 10 * c.magnification()),
  },

  Vanilla: {
    id: "Vanilla",
    name: "Vanilla",
    color: "#f2e2a8",
    family: "letter",
    op: "additive",
    magnitudeText: "+1/ltr",
    description: "+1 per letter; +2 per letter when the word is 7+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return add(v, L * (L >= 7 ? 2 : 1) * c.magnification());
    },
  },

  ConsonantCrunch: {
    id: "ConsonantCrunch",
    name: "Consonant Crunch",
    color: "#ff7a59",
    family: "letter",
    op: "additive",
    magnitudeText: "+2/con",
    description: "+2 per consonant; +3 per consonant when the word is 7+ letters.",
    // Gate on the REAL word length (matches C#), count via Catalyst-aware indices.
    fold: (v, c) =>
      add(v, c.consonantIndices().length * (c.length >= 7 ? 3 : 2) * c.magnification()),
  },

  VocalVowels: {
    id: "VocalVowels",
    name: "Vocal Vowels",
    color: "#7be0c4",
    family: "letter",
    op: "additive",
    magnitudeText: "+3/vwl",
    description: "+3 per vowel; +4 per vowel when the word is 7+ letters.",
    fold: (v, c) => add(v, c.vowelIndices().length * (c.length >= 7 ? 4 : 3) * c.magnification()),
  },

  BrickLayer: {
    id: "BrickLayer",
    name: "Brick Layer",
    color: "#d96a3c",
    family: "letter",
    op: "additive",
    magnitudeText: "+1/ltr",
    description: "+1 per letter, but only when the word is 6+ letters.",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L >= 6 ? add(v, L * c.magnification()) : skip(v);
    },
  },

  TheBlueprint: {
    id: "TheBlueprint",
    name: "The Blueprint",
    color: "#9ad0ff",
    family: "letter",
    op: "additive",
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
    id: "LetterHoarder",
    name: "Letter Hoarder",
    color: "#e9c46a",
    family: "letter",
    op: "additive",
    magnitudeText: "+1/uniq",
    description: "+1 per distinct letter.",
    fold: (v, c) => add(v, c.distinctLetters * c.magnification()),
  },

  HighRoller: {
    id: "HighRoller",
    name: "High Roller",
    color: "#ff5ca0",
    family: "economy",
    op: "additive",
    magnitudeText: "+20",
    description: "+20 when the word starts with a rare letter (Q, X, Z, J).",
    fold: (v, c) => (RARE_START.has(c.startsWith) ? add(v, 20 * c.magnification()) : skip(v)),
  },

  BoosterPack: {
    id: "BoosterPack",
    name: "Booster Pack",
    color: "#ffb020",
    family: "economy",
    op: "additive",
    magnitudeText: "+2/right",
    description: "+2 for every card placed to the right of this one in the bay.",
    fold: (v, c) => (c.cardsToRight > 0 ? add(v, 2 * c.cardsToRight * c.magnification()) : skip(v)),
  },

  Scavenger: {
    id: "Scavenger",
    name: "Scavenger",
    color: "#c08552",
    family: "economy",
    op: "additive",
    magnitudeText: "+1/word",
    description:
      "+1 for every previously submitted word (any player's) that contains your word's starting letter.",
    fold: (v, c) => {
      const n = c.history.filter((h) => h.word.includes(c.startsWith)).length;
      return n > 0 ? add(v, n * c.magnification()) : skip(v);
    },
  },

  // ── §3.2 Core Multipliers (place right so they scale accumulated additives) ──
  VowelSurge: {
    id: "VowelSurge",
    name: "Vowel Surge",
    color: "#2ed6b6",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×3",
    description: "×3 when the word has more vowels than consonants.",
    fold: (v, c) =>
      c.vowelIndices().length > c.consonantIndices().length
        ? mul(v, 3 * c.magnification())
        : skip(v),
  },

  TheArchitect: {
    id: "TheArchitect",
    name: "The Architect",
    color: "#8f8cff",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×3",
    description: "×3 when the word is 8+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 8 ? mul(v, 3 * c.magnification()) : skip(v)),
  },

  Sesquipedalian: {
    id: "Sesquipedalian",
    name: "Sesquipedalian",
    color: "#b06bff",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×5",
    description: "×5 when the word is 10+ letters.",
    fold: (v, c) => (c.resolveWordLength() >= 10 ? mul(v, 5 * c.magnification()) : skip(v)),
  },

  GutturalRoar: {
    id: "GutturalRoar",
    name: "Guttural Roar",
    color: "#c98a3c",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description: "×1.5 when the word's only vowels are A or E.",
    // Matches C# LINQ .All(): a word with no (active-classifier) vowels triggers vacuously.
    fold: (v, c) =>
      c.vowelIndices().every((i) => c.word[i] === "a" || c.word[i] === "e")
        ? mul(v, 1.5 * c.magnification())
        : skip(v),
  },

  PerfectLink: {
    id: "PerfectLink",
    name: "Perfect Link",
    color: "#57e08a",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description: "×1.5 when the word ends in a vowel (and hands an easy letter on).",
    fold: (v, c) =>
      c.vowelIndices().includes(c.length - 1) ? mul(v, 1.5 * c.magnification()) : skip(v),
  },

  TryHard: {
    id: "TryHard",
    name: "Try Hard",
    color: "#ff8c42",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×1.1+",
    description: "×1.1 at 7 letters, +0.1 per letter beyond (8 → ×1.2, 9 → ×1.3, …).",
    fold: (v, c) => {
      const L = c.resolveWordLength();
      return L > 6 ? mul(v, round1(1 + 0.1 * (L - 6)) * c.magnification()) : skip(v);
    },
  },

  DoubleDown: {
    id: "DoubleDown",
    name: "The Double Down",
    color: "#ff4d9d",
    family: "economy",
    op: "multiplicative",
    magnitudeText: "×2",
    description: "×2 when the word has a repeat letter (the 'ff' in coffin), else ×0.5.",
    fold: (v, c) =>
      c.hasRepeatLetter ? mul(v, 2 * c.magnification()) : mul(v, 0.5 * c.magnification()),
  },

  // ── §3.3 Glass cannon (multipliers paid in your own shot clock) ──
  TheVault: {
    id: "TheVault",
    name: "The Vault",
    color: "#9fb3d6",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description: "×1.5 always; permanently −10% shot clock.",
    clock: { pctDelta: -0.1 },
    fold: (v, c) => mul(v, 1.5 * c.magnification()),
  },

  Redline: {
    id: "Redline",
    name: "Redline",
    color: "#ff4d4d",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×2",
    description: "×2 always; permanently −20% shot clock.",
    clock: { pctDelta: -0.2 },
    fold: (v, c) => mul(v, 2 * c.magnification()),
  },

  PanicButton: {
    id: "PanicButton",
    name: "Panic Button",
    color: "#ff2e6e",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×1.35–2.7",
    description:
      "Halves your shot clock. ×1.35 normally — but ×2.7 if you submit before the final 2 seconds.",
    clock: { pctDelta: -0.5 },
    // ×2.7 when there are >=2s left (submitted early), else ×1.35.
    fold: (v, c) => mul(v, (c.clockRemaining >= 2 ? 2.7 : 1.35) * c.magnification()),
  },

  AnchorChain: {
    id: "AnchorChain",
    name: "The Anchor Chain",
    color: "#5b7fb0",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×0.5/ltr",
    description:
      "Locks your shot clock to a strict, unmodifiable 5s for the era. In exchange: ×(0.5 per letter).",
    // Uses the REAL word length (not Forgery-perceived), per C# AnchorChainCard.
    fold: (v, c) => mul(v, 0.5 * c.length * c.magnification()),
    shotClockOverride: () => 5,
  },

  HyperDrive: {
    id: "HyperDrive",
    name: "Hyper-Drive",
    color: "#46d0ff",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description:
      "Caps your shot clock at 5s. When your word is longer than 6 letters, ×1.5 to your score so far.",
    // Per-word ×1.5 folded at its own slot (boosts the seed + everything to its left).
    fold: (v, c) => (c.resolveWordLength() > 6 ? mul(v, 1.5 * c.magnification()) : skip(v)),
    shotClockCap: () => 5,
  },

  SlowBurn: {
    id: "SlowBurn",
    name: "Slow Burn",
    color: "#ff9e57",
    family: "clock",
    op: "fx",
    magnitudeText: "FX",
    description:
      "Lengthens your shot clock by 20%, but words shorter than 6 letters are illegal — they take the Zero-Point Tax.",
    clock: { pctDelta: 0.2 },
    fold: (v) => fx(v),
    illegalWord: (c) => c.resolveWordLength() < 6,
  },

  Speedracer: {
    id: "Speedracer",
    name: "Speedracer",
    color: "#ffd23f",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "≤×(ltr/2)",
    description:
      "When your word is longer than 6 letters, ×(1 ÷ [remaining ÷ total clock]), capped at half your letter count.",
    fold: (v, c) => {
      if (c.resolveWordLength() <= 6) return skip(v);
      const cap = Math.floor(c.resolveWordLength() / 2);
      const factor = c.clockRemaining <= 0 ? cap : Math.min(c.clockTotal / c.clockRemaining, cap);
      return mul(v, factor * c.magnification());
    },
  },

  Blindfold: {
    id: "Blindfold",
    name: "The Blindfold",
    color: "#8a7dff",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×1.8",
    description: "×1.8 always; hides your own input box while you type (no peeking at typos).",
    fold: (v, c) => mul(v, 1.8 * c.magnification()),
    hidesInput: () => true,
  },

  // ── §3.8 Utility (FX; 0 points, enabling capabilities) ──
  HeatSink: {
    id: "HeatSink",
    name: "The Heat Sink",
    color: "#7fd8ff",
    family: "clock",
    op: "fx",
    magnitudeText: "FX",
    description: "+30% shot clock (neutralises Redline / Vault).",
    clock: { pctDelta: 0.3 },
    fold: (v) => fx(v),
  },

  Catalyst: {
    id: "Catalyst",
    name: "The Catalyst",
    color: "#b97bff",
    family: "utility",
    op: "fx",
    magnitudeText: "FX",
    description:
      "For every card placed after it, the letters Y, W and H count as a vowel in addition to their consonant role.",
    fold: (v) => fx(v),
    isVowel: (ch) => "aeiouywh".includes(ch),
  },

  Forgery: {
    id: "Forgery",
    name: "Forgery",
    color: "#d8b46a",
    family: "utility",
    op: "fx",
    magnitudeText: "FX",
    description:
      "Every length-scoring card placed after it perceives your word as having double the letters.",
    fold: (v) => fx(v),
    // Perceived = double the count seen BEFORE this card (so glasses stack), then
    // scaled by a glass magnifying Forgery itself (×2 → ×3), rounded half-up.
    perceivedLength: (c) => Math.floor(c.resolveWordLength() * 2 * c.magnification() + 0.5),
  },

  MagnifyingGlass: {
    id: "MagnifyingGlass",
    name: "Magnifying Glass",
    color: "#9ad0ff",
    family: "utility",
    op: "fx",
    magnitudeText: "FX",
    description:
      "Magnifies the card immediately to its right by ×1.5. Glasses in series compound (two → ×2.25).",
    fold: (v) => fx(v),
    submitMagnifications: (reg, i) => reg.push(i + 1, 1.5 * reg.getMagnification(i)),
  },

  Wildcard: {
    id: "Wildcard",
    name: "The Wildcard",
    color: "#ffd34d",
    family: "utility",
    op: "fx",
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
    id: "Prism",
    name: "The Prism",
    color: "#6fe0ff",
    family: "utility",
    op: "fx",
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
    id: "IrsAgent",
    name: "The IRS Agent",
    color: "#4caf6e",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description:
      "When YOUR word is hit by the Zero-Point Tax, no opponent's Tax Collector collects a thing.",
    fold: (v) => fx(v),
    ownTaxScore: () => 0,
    suppressesSiphon: true,
  },

  TaxWriteOff: {
    id: "TaxWriteOff",
    name: "Tax Write-Off",
    color: "#3fa7a0",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description:
      "When your word is taxed, score its first letter through your engine as a clean submission and add that on top.",
    fold: (v) => fx(v),
    writeOffBonus: (c, score) => (c.word.length > 0 ? score(c.word[0]) : 0),
  },

  // ── §3.4 Personal-ban economy ──
  RouletteWheel: {
    id: "RouletteWheel",
    name: "The Roulette Wheel",
    color: "#e0457b",
    family: "economy",
    op: "multiplicative",
    magnitudeText: "×1.75",
    description:
      "Each era, rolls you a personal banned letter (Zero-Point Tax if you use it). Reward: ×1.75 on every clean word.",
    fold: (v, c) => mul(v, 1.75 * c.magnification()),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, "RouletteWheel", ban);
    },
  },

  TollBooth: {
    id: "TollBooth",
    name: "The Toll Booth",
    color: "#caa24a",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description:
      "Each era, rolls you a personal banned letter. Toll: bank 20% of any opponent's score when their word uses that letter.",
    fold: (v) => fx(v),
    roomServices: ["cardBan"],
    onEraStart: (c) => {
      if (!c.player) return;
      const ban = c.services?.banLetters.rollPersonalBan();
      if (ban) c.services?.cardBan.roll(c.player.id, "TollBooth", ban);
    },
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.taxed || res.earnedScore <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const banned = c.services?.cardBan.letterFor(owner.id, "TollBooth");
      if (banned && res.word.includes(banned)) {
        const amount = clampScore(res.earnedScore * 0.2 * c.magnification());
        if (amount > 0) owner.score += amount;
      }
    },
  },

  // ── §3.5 Reactive economy (resolve via lifecycle hooks, not the scoring fold) ──
  TaxCollector: {
    id: "TaxCollector",
    name: "Tax Collector",
    color: "#2fa85a",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description: "When an opponent eats the Zero-Point Tax, collect half the would-be score.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || !res.taxed || res.siphonSuppressed || res.wouldBeScore <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const amount = clampScore(res.wouldBeScore * 0.5 * c.magnification());
      if (amount <= 0) return;
      owner.score += amount;
      c.effects?.recordSiphon(owner.id, amount);
    },
  },

  ChronoSyphon: {
    id: "ChronoSyphon",
    name: "Chrono Syphon",
    color: "#5ad0c4",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description:
      "Banks +1 for every whole second left on an opponent's shot clock when they submit.",
    fold: (v) => fx(v),
    onOpponentWordResolved: (c) => {
      const res = c.resolution;
      if (!res || res.remainingSeconds <= 0) return;
      const owner = c.player;
      if (!owner || owner.id === res.submitterId) return;
      const amount = clampScore(res.remainingSeconds * c.magnification());
      if (amount > 0) {
        owner.score += amount;
        c.effects?.recordSiphon(owner.id, amount);
      }
    },
  },

  // ── §3.6 Automated aggression (route through the victim's Titanium Mirror) ──
  FlakCannon: {
    id: "FlakCannon",
    name: "Flak Cannon",
    color: "#ff7043",
    family: "economy",
    op: "fx",
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
    id: "BountyHunter",
    name: "The Bounty Hunter",
    color: "#d4a017",
    family: "economy",
    op: "fx",
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
    id: "BaitAndSwitch",
    name: "Bait & Switch",
    color: "#b388ff",
    family: "utility",
    op: "fx",
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
    id: "TitaniumMirror",
    name: "The Titanium Mirror",
    color: "#9fd3e0",
    family: "utility",
    op: "multiplicative",
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
};

/** Ids dealt to players. Widens as each phase's cards land + pass tests. */
export const DEALABLE_CARD_IDS: string[] = Object.keys(CARD_LIBRARY);

export const getCard = (id: string): ModifierCard | undefined => CARD_LIBRARY[id];
