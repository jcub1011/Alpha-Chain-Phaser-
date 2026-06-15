/*
 * The vertical-slice card library: ~12 cards spanning every mechanic family
 * (additive, multiplier, glass-cannon clock cost, utility, reactive economy).
 * Behaviour is faithful to alpha-chain-gdd.md §3. The remaining 28 cards plug
 * into the same registry without touching the evaluator.
 */

import { add, fx, mul, RARE_START, skip, type ModifierCard } from "./card";

export const CARD_LIBRARY: Record<string, ModifierCard> = {
  // ── Additives (place left so multipliers act on a bigger base) ────────────
  TheAnchor: {
    id: "TheAnchor",
    name: "The Anchor",
    family: "letter",
    op: "additive",
    magnitudeText: "+10",
    description: "+10 flat, always.",
    fold: (v) => add(v, 10),
  },

  Vanilla: {
    id: "Vanilla",
    name: "Vanilla",
    family: "letter",
    op: "additive",
    magnitudeText: "+1/ltr",
    description: "+1 per letter; +2 per letter when the word is 7+ letters.",
    fold: (v, c) => add(v, c.length * (c.length >= 7 ? 2 : 1)),
  },

  ConsonantCrunch: {
    id: "ConsonantCrunch",
    name: "Consonant Crunch",
    family: "letter",
    op: "additive",
    magnitudeText: "+2/con",
    description: "+2 per consonant; +3 per consonant when the word is 7+ letters.",
    fold: (v, c) => add(v, c.consonantCount * (c.length >= 7 ? 3 : 2)),
  },

  BrickLayer: {
    id: "BrickLayer",
    name: "Brick Layer",
    family: "letter",
    op: "additive",
    magnitudeText: "+1/ltr",
    description: "+1 per letter, but only when the word is 6+ letters.",
    fold: (v, c) => (c.length >= 6 ? add(v, c.length) : skip(v)),
  },

  HighRoller: {
    id: "HighRoller",
    name: "High Roller",
    family: "economy",
    op: "additive",
    magnitudeText: "+20",
    description: "+20 when the word starts with a rare letter (Q, X, Z, J).",
    fold: (v, c) => (RARE_START.has(c.startsWith) ? add(v, 20) : skip(v)),
  },

  // ── Multipliers (place right so they scale accumulated additives) ─────────
  TheArchitect: {
    id: "TheArchitect",
    name: "The Architect",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×3",
    description: "×3 when the word is 8+ letters.",
    fold: (v, c) => (c.length >= 8 ? mul(v, 3) : skip(v)),
  },

  VowelSurge: {
    id: "VowelSurge",
    name: "Vowel Surge",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×3",
    description: "×3 when the word has more vowels than consonants.",
    fold: (v, c) => (c.vowelCount > c.consonantCount ? mul(v, 3) : skip(v)),
  },

  PerfectLink: {
    id: "PerfectLink",
    name: "Perfect Link",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description: "×1.5 when the word ends in a vowel (and hands an easy letter on).",
    fold: (v, c) => (c.endsInVowel ? mul(v, 1.5) : skip(v)),
  },

  Sesquipedalian: {
    id: "Sesquipedalian",
    name: "Sesquipedalian",
    family: "letter",
    op: "multiplicative",
    magnitudeText: "×5",
    description: "×5 when the word is 10+ letters.",
    fold: (v, c) => (c.length >= 10 ? mul(v, 5) : skip(v)),
  },

  // ── Glass cannon (multipliers paid in your own shot clock) ────────────────
  TheVault: {
    id: "TheVault",
    name: "The Vault",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×1.5",
    description: "×1.5 always; permanently −10% shot clock.",
    clock: { pctDelta: -0.1 },
    fold: (v) => mul(v, 1.5),
  },

  Redline: {
    id: "Redline",
    name: "Redline",
    family: "clock",
    op: "multiplicative",
    magnitudeText: "×2",
    description: "×2 always; permanently −20% shot clock.",
    clock: { pctDelta: -0.2 },
    fold: (v) => mul(v, 2),
  },

  // ── Utility / reactive economy (0 points themselves) ──────────────────────
  HeatSink: {
    id: "HeatSink",
    name: "The Heat Sink",
    family: "clock",
    op: "fx",
    magnitudeText: "FX",
    description: "+30% shot clock (neutralises Redline / Vault).",
    clock: { pctDelta: 0.3 },
    fold: (v) => fx(v),
  },

  TaxCollector: {
    id: "TaxCollector",
    name: "Tax Collector",
    family: "economy",
    op: "fx",
    magnitudeText: "FX",
    description: "When an opponent eats the Zero-Point Tax, collect half the would-be score.",
    reactive: "tax-collector",
    fold: (v) => fx(v),
  },
};

/** Ids dealt to players during the slice (the whole library, for now). */
export const DEALABLE_CARD_IDS: string[] = Object.keys(CARD_LIBRARY);

export const getCard = (id: string): ModifierCard | undefined => CARD_LIBRARY[id];
