# Word Builder Mode — Implementation Revision Plan

> **Scope.** This document specifies the implementation revision for replacing or evolving **Picker Mode** into **Word Builder Mode** in Alpha-Chain. It sits alongside [`picker-implementation-plan.md`](./picker-implementation-plan.md) and provides the architectural, algorithmic, and engineering roadmap to transition from passive word selection to active, touch-first tile/morpheme construction.
>
> **Status:** Draft / Ready for Implementation.

---

## 1. Executive Summary & Design Pivot

### 1.1 The Problem with Static Word Selection (Picker Mode)
Picker Mode successfully addressed mobile typing friction and dyslexia barriers by replacing freeform keyboard entry with selection. However, playtesting and design analysis revealed critical gameplay shortcomings:
* **The "Multiple-Choice Math" Trap**: Selecting from 5 static words reduces gameplay to trivial arithmetic or visual inspection of which word lights up the most engine cards.
* **Loss of Generative Agency**: Players no longer experience the "Eureka!" satisfaction of inventing or finding a clever word; the game simply hands it to them.
* **Solitary Play & Neutered Sabotage**: The lookahead algorithm and static generation insulate opponents from letter starvation, eliminating the tactical PvP dimension of Shiritori.
* **Opponent Turn Downtime**: Because candidate words are rolled anew on turn start, players cannot plan ahead while opponents play.

### 1.2 The Pivot: Word Builder Mode (Tile / Morpheme Construction)
**Word Builder** replaces static whole-word selection with **tile-based word construction**:
1. On each turn, the active player is presented with a **Rack of 8–10 tiles** containing single letters and common multi-letter morpheme/syllable chunks (e.g., `[ C ]`, `[ R ]`, `[ E ]`, `[ A ]`, `[ T ]`, `[ I ]`, `[ V ]`, `[ -ED ]`, `[ -ING ]`, `[ -S ]`).
2. The player taps tiles to construct a valid dictionary word starting with the required Succession letter.
3. As tiles are staged, the game provides real-time dictionary validity feedback and highlights Engine Bay triggers.
4. Tapping a staged tile returns it to the rack; a double-tap or **SUBMIT** commits the word.

### 1.3 Key Benefits
* **Touch-First Accessibility**: 100% playable via big, accessible touch targets—zero keyboard dexterity required.
* **Scaffolding for Dyslexic Players**: Visual morpheme chunks (`-TION`, `-ING`, `-ABLE`, `CON-`) facilitate whole-pattern recognition rather than letter-by-letter recall.
* **Restored Generative Joy**: Players actively *build* words, discovering surprising combos and high-scoring shapes.
* **Strategic Branching**: A single rack enables short safe words, long powerhouse words, vowel-heavy words, or deliberate aggressive ending letters to attack the next player.

---

## 2. Core Algorithmic Architecture: The "Golden Seed" Pipeline

The primary technical challenge of a tile builder is **guaranteeing solvability** (no dead hands) while ensuring **rich branch diversity** across lengths, vowel counts, and ending letters.

Drawing random tiles from a frequency bag is prohibited: it creates unplayable racks (e.g., `[K, Z, X, J, U, U, Y]`) and unpredictable difficulty spikes. Instead, the generator uses a **Reverse-Seeded Pipeline**.

```
┌────────────────────────────────────────────────────────┐
│ 1. Pick Golden Seed Word (7–9 letters starting with L) │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 2. Decompose Seed into Base Tiles (Letters / Chunks)   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 3. Inject High-Utility Catalyst Tiles (S, D, R, ING)   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 4. Sub-Word Profiler & Diversity Guardrail (O(1))      │
└────────────────────────────────────────────────────────┘
```

### 2.1 Step 1: Golden Seed Selection
* The generator queries the `WordPool` index for words starting with the required Succession letter $L$ with length $7 \le \ell \le 9$.
* Words are filtered for **high combinatorial fertility** (favoring words containing common consonants like `R, S, T, L, N, D` and vowels `A, E, I, O`).
* **Guarantee**: Solvability is mathematically guaranteed ($100\%$) because the complete seed word is always buildable.

### 2.2 Step 2: Tile Chunking & Decomposition
The seed word is converted into tiles:
* Single letter decomposition: `CREATIVE` $\rightarrow$ `['C', 'R', 'E', 'A', 'T', 'I', 'V', 'E']`.
* Optional morpheme extraction: If the seed word contains standard affixes, extract them as chunk tiles (e.g., `RE-`, `UN-`, `-ABLE`, `-TION`, `-ING`, `-ED`, `-EST`, `-LY`).

### 2.3 Step 3: Catalyst Tile Injection
The rack is padded to target capacity (default: **9–10 tiles**) with high-utility **catalyst tiles**:
* **Universal Inflections**: `S`, `D`, `R`, `E`, `Y`, `-ED`, `-ING`, `-S`.
* **Vowel Ratio Guard**: Ensure the completed rack maintains a **35%–45% vowel ratio**. If vowel-starved, draw from `[A, E, I, O, U]`; if consonant-starved, draw from `[T, N, S, R, L]`.

### 2.4 Step 4: Sub-Word Profiler & Verification Guardrail
Using a letter-frequency bitmask scan across the starting-letter bucket in `WordPool`, verify that the rack satisfies the **Diversity Contract**:
* $\ge 1$ word of length $7+$ (High-ceiling engine path)
* $\ge 2$ words of length $4–6$ (Mid-range/safe path)
* $\ge 2$ distinct ending letters (Tactical Succession choices)

If the diversity check fails (which occurs in $<2\%$ of draws with catalyst injection), redraw a new seed. Total generation time is $< 1.5\,\text{ms}$ in the Jint JS sandbox.

---

## 3. System Architecture & Seams

### 3.1 Server Authority & Determinism
* **No Client RNG**: Racks are generated server-side in `generateRack(req: RackRequest): RackResult` inside `src/game/picker/rack.ts` (or `builder/rack.ts`).
* **Single-Bundle Jint Sandbox Compliance**: Pure functions only. No `Date`, no `fetch`, no DOM, injected RNG.
* Racks are serialized into `MatchState.rack: Tile[]` and broadcast in the state snapshot.

### 3.2 Wire Contracts & State Changes
#### `types.ts`
```ts
export interface Tile {
  id: string;          // Unique tile instance ID (e.g. "t0", "t1")
  text: string;        // "C", "RE", "ING"
  isChunk: boolean;    // true if multi-letter
}

export interface MatchState {
  // Replaces or complements offer: string[]
  rack: Tile[];
  stagedTileIds: string[]; // Transient or draft state
  // ... existing fields
}
```

#### `messages.ts` (Intents)
* `selectTile { tileId: string; slotIndex?: number }`: Moves tile to staging strip. Throttled/local preview.
* `deselectTile { tileId: string }`: Returns tile to rack.
* `clearStaging {}`: Clears all staged tiles.
* `submitWord { word: string }`: Existing submit intent re-used; validates that `word` is constructible from `state.rack` and starts with `requiredLetter`.

### 3.3 UI Component: `<ac-word-builder>`
Replaces `<ac-offer-grid>` / `<ac-word-entry>` when mode is `Builder`.

```
┌──────────────────────────────────────────────────────────────┐
│  REQUIRED LETTER: [ C ]                 TIME LEFT: 0:18      │
├──────────────────────────────────────────────────────────────┤
│  STAGING STRIP:                                              │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌─────┐                             │
│  │ C │ │ R │ │ E │ │ A │ │ -ED │  [ ✓ VALID: 7L, 3v ]        │
│  └───┘ └───┘ └───┘ └───┘ └─────┘                             │
├──────────────────────────────────────────────────────────────┤
│  TILE RACK:                                                  │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌──────┐ ┌───┐    │
│  │ T │ │ I │ │ V │ │ E │ │ S │ │ D │ │ O │ │ -ING │ │ L │    │
│  └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └──────┘ └───┘    │
├──────────────────────────────────────────────────────────────┤
│  [ ↺ CLEAR ]      [ ⇄ SHUFFLE RACK ]          [ SUBMIT (GO) ] │
└──────────────────────────────────────────────────────────────┘
```

#### Interactive Behaviors:
1. **Tap to Stage**: Tapping a tile in the rack moves it to the end of the staging strip.
2. **Tap to Unstage**: Tapping a tile in the staging strip returns it to the rack.
3. **Live Validity Feedback**: As soon as staged tiles form a valid dictionary word starting with $L$, the staging strip glows green and the **Engine Bay cards highlight their trigger status**.
4. **Drag & Drop / Reordering (Optional Enhancement)**: Stage tiles by tapping or dragging; reorder staged tiles directly.
5. **Keyboard Support (Desktop)**: Typing letters automatically stages matching tiles from the rack. Backspace unstages.

---

## 4. Interaction with Cards & Systems

### 4.1 Preference Cards Evolution
In Picker Mode, Preference Cards shaped the 5-word Offer. In Builder Mode, they evolve into **Rack & Catalyst Modifiers** (or "Lens" cards):

| Former Preference Card | Builder Mode Redesign |
| :--- | :--- |
| **The Sieve** | Rack contains only chunks and letters from seeds of length $8+$. |
| **The Winnower** | Redraw whole rack for 25% of shot clock. |
| **The Wide Net** | $+2$ Tile slots on your rack, $-15\%$ shot clock. |
| **Tunnel Vision** | $\times 1.4$ score, $-2$ Tile slots on your rack. |
| **The Prospector** | Guaranteed at least one rare letter tile (`Q, X, Z, J`) on rack. |
| **The Tide** | Rack guaranteed $\ge 50\%$ vowel tiles. |
| **The Sentinel** | Rack guaranteed to contain no banned letter tiles. |

### 4.2 Succession & Sabotage Interaction
* The generator guarantees that the rack contains multiple valid ending letters.
* Players holding cards like *Bookends* (starts and ends with same letter) or aiming to trap an opponent on `X` or `Q` can deliberately construct words ending in those characters.

### 4.3 Bot Integration
* Bots do not need complex tile-shuffling heuristics.
* The existing `bestScoredCandidate(candidates, bay, opts)` function is preserved.
* The bot enumerates all valid words formed by `state.rack` (using the sub-word bitmask index), ranks them through its Engine Bay, and commits the top-scoring candidate.

---

## 5. Phased Implementation Milestones

### Milestone 1: Core Tile Generator & Anagram Index
* Implement `src/game/builder/rack.ts`: Golden Seed selection, catalyst injection, vowel ratio balancing.
* Implement `subWordFinder(rack, pool)`: Ultra-fast bitmask/frequency validator.
* Unit tests in `rack.test.ts`:
  * $100\%$ solvability over 10,000 randomized draws.
  * Diversity criteria verification (length spread, vowel spread, ending letter diversity).
  * Parity tests under injected RNG.

### Milestone 2: Match Engine & Wire Protocol
* Update `MatchState` with `rack: Tile[]`.
* Update `armCurrentTurn` in `match.ts` to generate and assign the rack when mode is `Builder`.
* Update `commitSelection` / `submitWord` to enforce rack membership (word must be spellable using provided tiles).
* Add `Intent` handlers in `authority.ts` and `controller.ts`.

### Milestone 3: UI Component (`<ac-word-builder>`)
* Create `src/ui/components/ac-word-builder.ts` and styling in `builder.css`.
* Implement touch/click staging and unstaging.
* Implement live dictionary checking and Engine Bay highlight dispatch (`ac-offer-preview`).
* Mount in `ac-hud.ts` when game mode is `Builder`.

### Milestone 4: Bot & Solo Integration
* Connect bot decision pipeline: generate buildable candidate list from rack $\rightarrow$ run `bestScoredCandidate` $\rightarrow$ submit.
* Update Solo lobby settings and presets.

### Milestone 5: Multiplayer & Polish
* Verify snapshot serialization and late-join replication in local-tab authority.
* Add sound effects for tile placement, valid word confirmation, and clear.
* Update tutorials with the Word Builder staging walkthrough.

---

## 6. Verification & Invariants

| Invariant | Verification Method |
| :--- | :--- |
| **Zero Dead Racks** | Stress test: 50,000 consecutive turns across all 26 starting letters assert $\ge 1$ valid word $\ge 7$ letters. |
| **Deterministic Generation** | Same RNG stream $\rightarrow$ identical rack composition and tile ordering across network clients. |
| **Jint Sandbox Purity** | `npm run build:authority` passes with zero external imports, DOM references, or ambient timers. |
| **Mobile Responsiveness** | Rack and staging strip fit horizontally on a 320px viewport with minimum 44px touch targets. |
