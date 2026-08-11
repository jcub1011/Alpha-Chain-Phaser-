/*
 * THE CLASSIC LOCK. This file exists to make "Classic's numbers stay byte-identical" a mechanical
 * fact rather than a review promise.
 *
 * It fingerprints every card AS RESOLVED IN CLASSIC — its chip, its prose, its clock cost, which
 * hooks it opts into, and what its fold and timeoutFold actually produce across a fixed probe
 * matrix — and compares the lot against a committed literal. Any change to a Classic value or a
 * Classic string fails here, naming the card and showing the before/after in the diff.
 *
 * WHY AN INLINE LITERAL AND NOT `toMatchSnapshot()`: a snapshot file gets `-u`'d reflexively the
 * moment it goes red, which would silently bless exactly the regression this is here to catch. An
 * inline literal forces the changed number into the reviewable diff of a real source file.
 *
 * WHEN THIS FAILS: if you did not mean to change Classic, you have a bug — most likely a tuned
 * card's `build()` no longer reproduces its base numbers. If you DID mean to change Classic (a
 * deliberate rebalance of the base game), update the literal in the same commit, so the diff
 * records it.
 */

import { describe, expect, it } from "vitest";
import { armedClockSeconds, scoreTimeout, scoreWord } from "../scoring";
import { CardId, GameMode, type BayCard } from "../types";
import { cardLibrary } from "./library";

const bay = (...ids: string[]): BayCard[] => ids.map((id) => ({ id }));

/** Probe words chosen to straddle every length gate in the catalogue (3/6/7/8/10), plus a
 *  rare-letter word, a repeated-letter word and a vowel-less one. */
const PROBES = [
  "cat",
  "monkey",
  "monster",
  "elephant",
  "basketball",
  "quiz",
  "tatter",
  "rhythm",
] as const;

const opts = (over: Partial<Parameters<typeof scoreWord>[2]> = {}) => ({
  mode: GameMode.Classic,
  prevWordLength: 0,
  clockRemaining: 10,
  clockTotal: 20,
  taxed: false,
  era: 1,
  history: [],
  ...over,
});

/** The chip a card's fold produced at `index`, or "∅" when the slot emitted no step. */
const chipAt = (word: string, ids: string[], index: number, over = {}): string =>
  scoreWord(word, bay(...ids), opts(over)).steps[index]?.valueText ?? "∅";

const scoreOf = (word: string, ids: string[], over = {}): number =>
  scoreWord(word, bay(...ids), opts(over)).finalBeforeTax;

/**
 * One card's complete Classic behaviour, as a single reviewable line.
 *
 * Three bay shapes, because a card's fold can read its neighbours: alone; behind a Magnifying
 * Glass (exercises `magnification()`); and with a card to its right (exercises `cardsToRight` and
 * bay-size reads like Booster Pack and Dividend). Two clock ratios, because the clock-scaling
 * multipliers are exactly the cards Picker will retune.
 */
function fingerprint(id: string): string {
  const card = cardLibrary(GameMode.Classic)[id as CardId];
  const hooks = (
    [
      "timeoutFold",
      "negatesTimeoutLoss",
      "shotClockOverride",
      "shotClockCap",
      "baseShotClock",
      "perceivedLength",
      "isVowel",
      "isConsonant",
      "illegalWord",
      "ownTaxScore",
      "suppressesSiphon",
      "writeOffBonus",
      "ignoresSuccession",
      "rescueClock",
      "hidesInput",
      "submitMagnifications",
      "onEraStart",
      "onWordAccepted",
      "onTurnEnded",
      "onOpponentWordResolved",
      "preference",
    ] as const
  )
    .filter((k) => card[k] !== undefined)
    .join("+");

  const parts = [
    `chip=${card.magnitudeText}`,
    `desc=${card.description}`,
    `clock=${card.clock ? `${card.clock.pctDelta ?? 0}/${card.clock.flatDelta ?? 0}` : "-"}`,
    `armed=${armedClockSeconds(20, bay(id), GameMode.Classic)}`,
    `hooks=${hooks || "-"}`,
    // Fold across the probe matrix, at a half clock.
    `alone=${PROBES.map((w) => `${chipAt(w, [id], 0)}:${scoreOf(w, [id])}`).join(" ")}`,
    // Full clock — separates the clock-scaling curves from everything else.
    `full=${PROBES.map((w) => chipAt(w, [id], 0, { clockRemaining: 20 })).join(" ")}`,
    `glass=${chipAt("monster", [CardId.MagnifyingGlass, id], 1)}`,
    `right=${chipAt("monster", [id, CardId.TheAnchor], 0)}`,
    `timeout=${scoreTimeout(bay(id), opts({ clockRemaining: 0 })).steps[0]?.valueText ?? "∅"}`,
  ];
  return parts.join(" | ");
}

export function classicFingerprints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(cardLibrary(GameMode.Classic))) out[id] = fingerprint(id);
  return out;
}

describe("Classic lock — every card's resolved Classic behaviour", () => {
  it("matches the committed fingerprint for all 54 cards", () => {
    expect(classicFingerprints()).toEqual(EXPECTED);
  });

  it("covers the whole catalogue, so a new card cannot slip in unlocked", () => {
    expect(Object.keys(classicFingerprints()).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(EXPECTED)).toHaveLength(54);
  });
});

/** Committed Classic behaviour. Generated from the pre-refactor build; see the file docblock. */
const EXPECTED: Record<string, string> = {
  TheAnchor:
    "chip=+10 | desc=+10 to your submission | clock=- | armed=20 | hooks=- | alone=+10:13 +10:16 +10:17 +10:18 +10:20 +10:14 +10:16 +10:16 | full=+10 +10 +10 +10 +10 +10 +10 +10 | glass=+15 | right=+10 | timeout=—",
  Vanilla:
    "chip=+1/ltr | desc=+1/letter; +2/letter at 7+ letters. | clock=- | armed=20 | hooks=- | alone=+3:6 +6:12 +14:21 +16:24 +20:30 +4:8 +6:12 +6:12 | full=+3 +6 +14 +16 +20 +4 +6 +6 | glass=+21 | right=+14 | timeout=—",
  ConsonantCrunch:
    "chip=+2/con | desc=+2/consonant; +3/consonant at 7+ letters. | clock=- | armed=20 | hooks=- | alone=+4:7 +8:14 +15:22 +15:23 +21:31 +4:8 +8:14 +12:18 | full=+4 +8 +15 +15 +21 +4 +8 +12 | glass=+22.5 | right=+15 | timeout=—",
  VocalVowels:
    "chip=+3/vwl | desc=+3/vowel; +4/vowel at 7+ letters. | clock=- | armed=20 | hooks=- | alone=+3:6 +6:12 +8:15 +12:20 +12:22 +6:10 +6:12 +0:6 | full=+3 +6 +8 +12 +12 +6 +6 +0 | glass=+12 | right=+8 | timeout=—",
  BrickLayer:
    "chip=+3/ltr | desc=+3/letter, only at 6+ letters. | clock=- | armed=20 | hooks=- | alone=—:3 +18:24 +21:28 +24:32 +30:40 —:4 +18:24 +18:24 | full=— +18 +21 +24 +30 — +18 +18 | glass=+31.5 | right=+21 | timeout=—",
  TheBlueprint:
    "chip=+3/ltr | desc=+3/letter when your word is at least as long as the previous word; always pays on the first word. | clock=- | armed=20 | hooks=- | alone=+9:12 +18:24 +21:28 +24:32 +30:40 +12:16 +18:24 +18:24 | full=+9 +18 +21 +24 +30 +12 +18 +18 | glass=+31.5 | right=+21 | timeout=—",
  LetterHoarder:
    "chip=+2/uniq | desc=+2 for each distinct letter. | clock=- | armed=20 | hooks=- | alone=+6:9 +12:18 +14:21 +14:22 +14:24 +8:12 +8:14 +10:16 | full=+6 +12 +14 +14 +14 +8 +8 +10 | glass=+21 | right=+14 | timeout=—",
  HighRoller:
    "chip=+10/rare | desc=+10 per rare letter (Q, X, Z, J). | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 +20:24 —:6 —:6 | full=— — — — — +20 — — | glass=— | right=— | timeout=—",
  BoosterPack:
    "chip=+2×slots /right | desc=+2 per card to its right in the bay, multiplied by your slot count. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=+4 | timeout=—",
  Scavenger:
    "chip=+2/word | desc=+2 per previously submitted word (any player's) containing your starting letter. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  VowelSurge:
    "chip=×3 | desc=×3 when the word has more vowels than consonants. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  TheArchitect:
    "chip=×3 | desc=×3 when the word is 8+ letters. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 ×3:24 ×3:30 —:4 —:6 —:6 | full=— — — ×3 ×3 — — — | glass=— | right=— | timeout=—",
  Sesquipedalian:
    "chip=×5 | desc=×5 when the word is 10+ letters. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 ×5:50 —:4 —:6 —:6 | full=— — — — ×5 — — — | glass=— | right=— | timeout=—",
  GutturalRoar:
    "chip=×2 | desc=×2 when the word's only vowels are A or E. | clock=- | armed=20 | hooks=- | alone=×2:6 —:6 —:7 ×2:16 ×2:20 —:4 ×2:12 ×2:12 | full=×2 — — ×2 ×2 — ×2 ×2 | glass=— | right=— | timeout=—",
  PerfectLink:
    "chip=×1.5 | desc=×1.5 when the word ends in a vowel. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  TryHard:
    "chip=×1.5+ | desc=×1.5 at 7 letters, +0.1 per letter beyond. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 ×1.5:11 ×1.6:13 ×1.8:18 —:4 —:6 —:6 | full=— — ×1.5 ×1.6 ×1.8 — — — | glass=×2.25 | right=×1.5 | timeout=—",
  DoubleDown:
    "chip=×2 | desc=×2 with a repeat letter, else ×0.5. | clock=- | armed=20 | hooks=- | alone=×0.5:2 ×0.5:3 ×0.5:4 ×2:16 ×2:20 ×0.5:2 ×2:12 ×2:12 | full=×0.5 ×0.5 ×0.5 ×2 ×2 ×0.5 ×2 ×2 | glass=×0.75 | right=×0.5 | timeout=—",
  TheVault:
    "chip=×1.5 | desc=×1.5 always; permanently −20% shot clock. Time out and lose 12 points. | clock=-0.2/0 | armed=16 | hooks=timeoutFold | alone=×1.5:5 ×1.5:9 ×1.5:11 ×1.5:12 ×1.5:15 ×1.5:6 ×1.5:9 ×1.5:9 | full=×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 | glass=×2.25 | right=×1.5 | timeout=−12",
  Redline:
    "chip=×2 | desc=×2 always; permanently −30% shot clock. Time out and lose 24 points. | clock=-0.3/0 | armed=14 | hooks=timeoutFold | alone=×2:6 ×2:12 ×2:14 ×2:16 ×2:20 ×2:8 ×2:12 ×2:12 | full=×2 ×2 ×2 ×2 ×2 ×2 ×2 ×2 | glass=×3 | right=×2 | timeout=−24",
  PanicButton:
    "chip=≤×2 | desc=+×0.05 for every second left in your shot clock, capped at ×2. | clock=- | armed=20 | hooks=- | alone=×1.5:5 ×1.5:9 ×1.5:11 ×1.5:12 ×1.5:15 ×1.5:6 ×1.5:9 ×1.5:9 | full=×2 ×2 ×2 ×2 ×2 ×2 ×2 ×2 | glass=×2.25 | right=×1.5 | timeout=—",
  SlowBurn:
    "chip=FX | desc=+30% shot clock. Words shorter than 6 letters are illegal and take the Zero-Point Tax. | clock=0.3/0 | armed=26 | hooks=illegalWord | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Speedracer:
    "chip=×(1+Remain /Total) | desc=×(1 + remaining clock time ÷ total clock time). Time out and lose 10 points. | clock=- | armed=20 | hooks=timeoutFold | alone=×1.5:5 ×1.5:9 ×1.5:11 ×1.5:12 ×1.5:15 ×1.5:6 ×1.5:9 ×1.5:9 | full=×2 ×2 ×2 ×2 ×2 ×2 ×2 ×2 | glass=×2.25 | right=×1.5 | timeout=−10",
  Blindfold:
    "chip=×1.5 | desc=×1.5 always; hides your own input box while you type. Time out and lose 8 points. | clock=- | armed=20 | hooks=timeoutFold+hidesInput | alone=×1.5:5 ×1.5:9 ×1.5:11 ×1.5:12 ×1.5:15 ×1.5:6 ×1.5:9 ×1.5:9 | full=×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 ×1.5 | glass=×2.25 | right=×1.5 | timeout=−8",
  HeatSink:
    "chip=×0.9 | desc=+30% shot clock, but ×0.9 to your score. | clock=0.3/0 | armed=26 | hooks=- | alone=×0.9:3 ×0.9:5 ×0.9:6 ×0.9:7 ×0.9:9 ×0.9:4 ×0.9:5 ×0.9:5 | full=×0.9 ×0.9 ×0.9 ×0.9 ×0.9 ×0.9 ×0.9 ×0.9 | glass=×1.35 | right=×0.9 | timeout=—",
  Catalyst:
    "chip=FX | desc=For every card placed to its right: Y, W and H count as vowels as well as consonants. | clock=- | armed=20 | hooks=isVowel | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Forgery:
    "chip=FX | desc=Every card that checks the word length percieves it to be twice as long. | clock=- | armed=20 | hooks=perceivedLength | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  MagnifyingGlass:
    "chip=FX | desc=Magnifies the card to its right by ×1.5. Glasses in series compound. | clock=- | armed=20 | hooks=submitMagnifications | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Wildcard:
    "chip=FX | desc=Once per era, one word may ignore the Succession rule — it need not begin with the previous word's last letter. | clock=- | armed=20 | hooks=ignoresSuccession | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Prism:
    "chip=FX | desc=Once per era, when your shot clock runs out your clock resets to full instead of ending your turn. | clock=- | armed=20 | hooks=rescueClock | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  IrsAgent:
    "chip=FX | desc=When your word is taxed, no opponent's Tax Collector collects from you. | clock=- | armed=20 | hooks=ownTaxScore+suppressesSiphon | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  TaxWriteOff:
    "chip=FX | desc=When your word is taxed, score the first half of it through your engine anyways. | clock=- | armed=20 | hooks=writeOffBonus | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  RouletteWheel:
    "chip=×2 | desc=Each era, rolls you a personal banned letter (Zero-Point Tax if you use it). ×2 on every clean word. | clock=- | armed=20 | hooks=onEraStart | alone=×2:6 ×2:12 ×2:14 ×2:16 ×2:20 ×2:8 ×2:12 ×2:12 | full=×2 ×2 ×2 ×2 ×2 ×2 ×2 ×2 | glass=×3 | right=×2 | timeout=—",
  TollBooth:
    "chip=FX | desc=Each era, you get a personal banned letter. Bank 20% of any opponent's score when their word uses that letter. | clock=- | armed=20 | hooks=onEraStart+onOpponentWordResolved | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  TaxCollector:
    "chip=FX | desc=When an opponent is taxed, collect 60% of their would-be score. | clock=- | armed=20 | hooks=onOpponentWordResolved | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  ChronoSyphon:
    "chip=FX | desc=+2 per whole second left on an opponent's shot clock when they submit. | clock=- | armed=20 | hooks=onOpponentWordResolved | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  BaitAndSwitch:
    "chip=FX | desc=When your word is taxed, curse the next player with that banned letter for their next turn. | clock=- | armed=20 | hooks=onTurnEnded | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  TheLexicon:
    "chip=×2 @9+ | desc=×2 when your word is 9+ letters; +15% shot clock. | clock=0.15/0 | armed=23 | hooks=- | alone=—:3 —:6 —:7 —:8 ×2:20 —:4 —:6 —:6 | full=— — — — ×2 — — — | glass=— | right=— | timeout=—",
  Stonemason:
    "chip=+4/ltr | desc=+4/letter, only at 8+ letters. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 +32:40 +40:50 —:4 —:6 —:6 | full=— — — +32 +40 — — — | glass=— | right=— | timeout=—",
  LoanShark:
    "chip=FX | desc=Bank 15% of any opponent's word scoring more than 30 points, but only if they're ahead of you on the leaderboard. | clock=- | armed=20 | hooks=onOpponentWordResolved | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Numismatist:
    "chip=×1.6 /rare | desc=×(1 + 0.6 per rare letter Q, X, Z, J). | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 ×2.2:9 —:6 —:6 | full=— — — — — ×2.2 — — | glass=— | right=— | timeout=—",
  TheSniper:
    "chip=FX | desc=Shave 20% off the shot clock of the leader. This applies to you if you are in the lead. | clock=- | armed=20 | hooks=onTurnEnded | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Insurance:
    "chip=FX | desc=Scores nothing on a normal word. If you time out, you lose no points. | clock=- | armed=20 | hooks=timeoutFold+negatesTimeoutLoss | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=+10",
  TheFlywheel:
    "chip=×1.15+ | desc=×1.15 for each other multiplier card in your bay (capped at ×2.3). | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  Tilesmith:
    "chip=+tile | desc=Scores the word based on its letter-tile values (Scrabble-style). | clock=- | armed=20 | hooks=- | alone=+5:8 +15:21 +9:16 +13:21 +18:28 +22:26 +6:12 +17:23 | full=+5 +15 +9 +13 +18 +22 +6 +17 | glass=+13.5 | right=+9 | timeout=—",
  Crescendo:
    "chip=×1+0.25 /clean | desc=×(1 + 0.25 per clean word you've played this era), capped at ×2. Being taxed or timing out resets it. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  Bookends:
    "chip=×2 | desc=×2 when the word's first and last letter are the same. | clock=- | armed=20 | hooks=- | alone=—:3 —:6 —:7 —:8 —:10 —:4 —:6 —:6 | full=— — — — — — — — | glass=— | right=— | timeout=—",
  Dividend:
    "chip=+2/card | desc=+2 for each card in your bay. | clock=- | armed=20 | hooks=- | alone=+2:5 +2:8 +2:9 +2:10 +2:12 +2:6 +2:8 +2:8 | full=+2 +2 +2 +2 +2 +2 +2 +2 | glass=+6 | right=+4 | timeout=—",
  Sieve:
    "chip=6+ only | desc=Your Offer contains only words of 6+ letters. Scores nothing itself. | clock=- | armed=20 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Winnower:
    "chip=redraw | desc=Once per turn, redraw your whole Offer for 30% of your shot clock. | clock=- | armed=20 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  WideNet:
    "chip=+2 / −15% | desc=+2 Offer Cards, and −15% shot clock. More to choose from, less time to choose. | clock=-0.15/0 | armed=17 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  TunnelVision:
    "chip=×1.4 | desc=×1.4 always, but you are offered 2 fewer words. Raw multiplier, less choice. | clock=- | armed=20 | hooks=preference | alone=×1.4:4 ×1.4:8 ×1.4:10 ×1.4:11 ×1.4:14 ×1.4:6 ×1.4:8 ×1.4:8 | full=×1.4 ×1.4 ×1.4 ×1.4 ×1.4 ×1.4 ×1.4 ×1.4 | glass=×2.1 | right=×1.4 | timeout=—",
  Prospector:
    "chip=1 rare | desc=At least one Offer Card always contains Q, X, Z or J. Scores nothing itself. | clock=- | armed=20 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Tide: "chip=vowels | desc=Your Offer is drawn vowel-heavy wherever the pool allows. Scores nothing itself. | clock=- | armed=20 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
  Sentinel:
    "chip=1 safe | desc=At least one Offer Card is guaranteed free of every letter banned against you. Scores nothing itself. | clock=- | armed=20 | hooks=preference | alone=FX:3 FX:6 FX:7 FX:8 FX:10 FX:4 FX:6 FX:6 | full=FX FX FX FX FX FX FX FX | glass=FX | right=FX | timeout=—",
};
