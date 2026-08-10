# Picker Mode — Implementation Plan

> **Scope.** This document is the implementation plan for **Picker**, the play mode specified in
> [`../picker-gdd.md`](../picker-gdd.md). The GDD is authoritative for *design*; this document is
> authoritative for *build order*. Section references written `(§2.2)` point into the GDD.
>
> Line references (`match.ts:497`) were read from the build at the time of writing and are anchors
> for orientation, not guarantees — verify before relying on one.

---

## 1. Context

Picker replaces word *entry* with word *selection*: each turn the server offers the active player a
set of candidate words — **the Offer** — and they choose one. Everything downstream is unchanged:
the chosen word runs through the Engine Bay exactly as a typed word does, sets the next player's
Succession letter, and is subject to the Zero-Point Tax.

The motivation is that Classic's two barriers — vocabulary recall, and typing a long word accurately
on a phone keyboard against a shot clock — exclude the mode's two target audiences: dyslexic players
and mobile users, who are most of the audience. Picker trades recall and typing for **evaluation**:
reading several words and knowing which shape your engine pays best for. The consequence is that the
engine becomes the primary skill expression rather than the dictionary.

**Picker becomes the default mode** (§1.1). That is what makes this more than an alternate game mode:
the tutorial, the bots, the deal pool and both lobbies all have to treat Picker as what a new player
meets first, and Classic has to stay both discoverable and unregressed.

### 1.1 Decisions taken

These were left open in GDD §8 and are settled for the purposes of this plan.

| Question | Decision |
|---|---|
| Default Offer Dictionary | **Reduced** (9,884 common words). Full remains available as a host setting. |
| §4.4 card retuning | **Final milestone, per-mode values** — Picker gets retuned curves; Classic's numbers stay byte-identical. |
| Sequencing | **Playable slice first** — M1 ends with Picker playable solo-vs-bots. |
| Picker shot clock default | **25 s**, as a tunable constant. Genuinely a playtest answer; M1 is what makes it answerable. |
| Unsatisfiable-filter threshold (§3.2) | Implement the GDD's stated rule: skip any filter that would drop the pool below the Offer count. The partial-subset variant is not built. |
| Preference Card rarities | Proposed in M3; flagged for review, **not** asserted as balanced. |

---

## 2. Findings that shape the design

Each of these was verified against the build and changes what the implementation has to do.

### 2.1 The word service is index-based, and that is sufficient

`KbWords` (`src/server/authority.ts:32-38`) exposes only `has / count / pick / countOfLength /
pickOfLength`. There is **no** "words starting with letter" query, which at first looks fatal for
server-side succession-constrained generation.

However, `addons/knockbox/knockbox-local.js:455-471` builds each length bucket as
`Array.from(set).sort()` over lowercase ASCII, and the comment at `:446-449` records that this pick
ordering is **parity-pinned to the C# `WordPoolSet`** by a shared fixture test — *"length buckets
ascending, ordinal within a length, one contiguous global index."*

Therefore, within a length bucket, all words sharing a first letter occupy a **contiguous index
range**, discoverable by binary search over `pickOfLength`. This is the mechanism that makes
length-shaped, succession-constrained Offer generation possible host-side without shipping the
dictionary to clients or scanning it linearly.

### 2.2 The GDD's length-skew numbers are exact — and the Reduced list is already well-shaped

Measured:

| Pool | Words | Median length | ≥ 8 letters | ≥ 10 letters |
|---|---|---|---|---|
| Full (`public/assets/words.txt`) | 386,633 | 9 | **73.1 %** | **44.9 %** |
| Reduced (`reduced-dictionary.csv`) | 9,884 | ~6 | **34.4 %** | **13.6 %** |

The GDD's figures for the Full list are exact. The new fact is the second row: **Reduced is already
close to a healthy distribution**, with its mode at 5–6 letters.

**Consequence:** the length correction must be an **explicit target distribution**, not a curve
derived from the pool. A pool-relative correction would leave Full and Reduced playing as two
different games.

### 2.3 Letter starvation is real and quantified — the §2.2 lookahead is mandatory

Reduced-list words *starting* with each scarce letter:

```
x = 9     z = 21    y = 42    q = 46
k = 98    u = 125   j = 126   v = 186
```

An Offer whose chosen word ends in `x` leaves the next player a pool of **9**, before excluding
already-played words — it dies within about two turns. For comparison, the Full list has 528 words
starting with `x`.

The letters the lookahead must steer away from are cheap to avoid: only 10 Reduced words *end* in
`j`, 11 in `q`, 17 in `z`, 24 in `v`, 52 in `x` — roughly 1 % of the pool. So the constraint costs
almost nothing in Offer variety while being the thing that keeps the Reduced list viable at all.

### 2.4 The Reduced dictionary already exists

Located at:

```
<repos>\KnockBox\host\KnockBox.WordService\Data\reduced-dictionary.csv
```

Exactly **9,884** lines (84,955 bytes), one bare word per line, same format as `words.txt` despite
the `.csv` extension. The GDD notes the list "is not currently packaged"; packaging it is a copy job,
not a sourcing problem. (`ny-dictionary.csv` sits alongside it and is not used here.)

The list has to be **shipped**, not referenced — the platform exposes no built-in dictionary an
authority module can name. See §3.2 for the manifest evidence and why two separate copies are needed.

### 2.5 §3.3 — "Preference Cards invisible to bay-size scoring" has a single-point fix

`makeBayEvaluator` (`src/game/scoring.ts:110-165`) derives *every* size-sensitive quantity from the
one `bay` array it is handed:

- `cardsToRight` (`:145`), `bayLength` (`:147`), `slots` (`:149`), `bayCardIds` (`:152`)
- the Forgery / Catalyst leftward provider scans (`:121-141`) and the Magnifier registry (`:156`)

So filtering Preference Cards out of the array **before** it reaches the evaluator satisfies every
§3.3 clause at once — Dividend (`library.ts:804`, reads `bayLength`), Booster Pack (`cardsToRight` ×
`slots`), The Flywheel (`bayCardIds`), and "a Magnifying Glass can never target one" all become true
by construction rather than by special-casing.

**One exception:** `armedClockSeconds` (`scoring.ts:307-361`) must keep the **full** bay, because The
Wide Net's −15 % is a genuine `ClockModifier` and must still apply. This is safe: bubbling (§3.1) puts
every Preference Card to the left of every scoring card, so no Magnifier can ever sit to a Preference
Card's left and inflate its clock delta.

### 2.6 Seams that already exist and should be used rather than invented

| Need | Existing seam |
|---|---|
| Inject a word pool into the rules layer | `MatchDeps` (`match.ts:83-88`) — currently carries only `isWord` |
| Generate the Offer once per turn | `armCurrentTurn` (`match.ts:497-514`) — the single place a turn is armed |
| Reset The Winnower's once-per-turn charge | `services.fireTurnStarted` (`match.ts:501`, `roomServices.ts:141`) — documented as *"currently a no-op seam"* |
| A per-charge guard primitive | `EraGuard` (`roomServices.ts:23`) — copy its shape for a `TurnGuard` |
| Shape of the *select* / *commit* intents | `setDraft` / `submitWord` (`match.ts:722`, `:563`), and `draftWord`'s `return null` no-broadcast property (`authority.ts:245-249`) |
| Highlight which bay cards would fire | `ac-card`'s reflected `triggered` / `dimmed` props (`ac-card.ts:52-53`), already driven by the score replay |
| Touch reveal without hover | `ac-card`'s `revealed` prop (`ac-card.ts:48-50`) |
| Offer Card shape annotations | `analyzeWord` (`scoring.ts:43-78`) already computes the entire §2.3 set |
| A responsive one-tap choice grid | `.ban-grid` (`intermission.css:232-242`) — `auto-fit` grid under a sub-timer with per-cell disabled reasons |
| A five-method `KbWords` test stub | `makeWords()` in `authority.test.ts:28-37` |

### 2.7 Two GDD assumptions to correct before coding

**Offer determinism does not come from an injected RNG.** §3.2 states that Offer generation "runs
inside the server authority under an injected RNG". In fact `kb.rng` is **not provided in
production** — `authority.ts:194` reads `rng: kb.rng ?? Math.random`, and the local-tab emulation
injects no RNG either. Determinism across clients is guaranteed **structurally**: only the server
generates the Offer, and the result ships in the state snapshot, exactly as the per-era turn-order
shuffle does (`match.ts:468-475`). The injected-RNG convention still matters for **tests**, and the
real invariant to preserve is the one stated at `match.ts:472-474` — *no RNG-derived logic may run on
a client mirror*.

**`planBotBay` will actively fight Preference Cards.** In `bots.ts:197-234`, `OP_RANK` places FX at
rank 1 (mid-bay), which collides with the auto-bubble-left rule; and the probe-word marginal-value
loop scores a shape filter at 0, so it discards Preference Cards first, every time. M3 must teach it
about the family or bots will never keep one.

---

## 3. Milestone 1 — Picker playable solo vs bots

**Done when:** the solo lobby offers Picker, and a full match can be played against bots by selecting
words from an Offer, with annotations and engine-fire highlighting, on the Reduced list.

### 3.1 Settings and mode plumbing

Follow the five-stop path (§7). Four of the five stops are exhaustive maps, so an omission is a
compile error rather than a silent gap.

1. **`AlphaChainSettings`** — `src/game/types.ts:111` — add `gameMode: GameMode`
   (`"picker" | "classic"`), `offerCount`, `offerDictionary: DictionaryTier`
   (`"reduced" | "full"`), `pickerShotClockSeconds`, `highlightBannedLetters`.
2. **`DEFAULT_SETTINGS`** — `src/game/settings.ts:44` — `gameMode: "picker"`, `offerCount: 5`,
   `offerDictionary: "reduced"`, `pickerShotClockSeconds: 25`, `highlightBannedLetters: false`.
3. **`SETTINGS_VALIDATORS`** — `settings.ts:167` — enum membership for the two unions, `inRange` for
   the numbers. Values reject to default, never clamp. **Bounds must match the lobby steppers
   exactly** — see §8.
4. **`SETTINGS_VERSION`** — `settings.ts:76` — bump **3 → 4**, or stale saved blobs load with
   settings this build doesn't expect. Also bump the hand-synced mirror at **`settings.test.ts:43`**
   (`const VERSION = 3`), which otherwise starts silently testing the version gate instead of the
   validators.
5. **`SETTING_HINTS`** — `src/ui/views/settings-hints.ts:9` — one hint per new key.

Then both lobbies: `ac-lobby.ts` (`render()` from `:137`, reusing the `segmented` / `stepper` /
`toggle` row primitives at `:62-126`) and `ac-net-lobby.ts` (`:221`, whose new rows must stay
`?disabled=${ro}` for non-owners). **Put Game Mode first in the list** — §1.1 requires Classic stay
discoverable, and stored settings will load with Picker selected.

### 3.2 Package the Reduced dictionary

Mechanical, but it belongs in M1: Reduced is now the default, and the default must not point at a
pool that doesn't exist.

**Why the list must be shipped rather than referenced.** `kb.words` is a *service over data the game
declares*, not a library of dictionaries. The platform manifest type admits nothing but a file —
`KnockBox.Contracts/GameManifest.cs:63`:

```csharp
public sealed record AuthorityWordDeclaration(string File, bool CaseInsensitive = true);
```

There is no mode enum and no built-in-pool name. Note that the *old* Blazor host's
`KnockBox.WordService` does expose built-in pools (`WordPoolMode.NytStandard / ReducedDictionary /
FullDictionary`, the last two backed by the same `full-` / `reduced-dictionary.csv` files) — but the
platform's `AuthorityWordService` only **adapted that machinery**, not its data
(`KnockBox-Games/CLAUDE.md:207-209`). Those pools are unreachable from an authority module. This is
also why the existing 4.2 MB `words.txt` is already vendored here.

**The duplication is close to free, so don't try to optimise it away.**
`KnockBox.Server/Games/Words/AuthorityWordService.cs:39-53` dedups on **content hash**, not path —
`(contentHash | caseInsensitive) → WordPoolSet`, plus a stat memo `(path|mtime|length) → contentHash`
so an unchanged file is not re-read or re-hashed per lobby start. Byte-identical files share one
structure across games, the pool is reached through `ClrFunction`s so it never enters the JS heap, and
`AuthorityMaxWordFileBytes` is 32 MB against this file's 83 KB.

**Two copies, for two different reasons — both required.** `vite.authority.config.ts:10-12` already
documents this split for `words.txt`; do not collapse it.

| Copy | Consumer | Why it can't be dropped |
|---|---|---|
| `public/assets/words-common.txt` | browser `fetch`, solo + sandbox + local-tab | Solo play has no server; `main.ts` loads the client `Dictionary` directly |
| game-folder copy (via `dist/`) | server `kb.words` | Declared in `authorityWords`; **deliberately denied on the game origin**, so clients can never fetch it |

Steps:

- Copy `reduced-dictionary.csv` (§2.4) → `public/assets/words-common.txt` (line-delimited already;
  the `.csv` extension is cosmetic).
- `export/GAME.json` — add a second `authorityWords` entry, e.g.
  `"en-common": { "file": "words-common.txt", "caseInsensitive": true }`.
- `vite.authority.config.ts` — a second `copyFileSync` in `copyWordList()` (`:43-53`), targeting the
  server-only `dist/` path, *not* `assets/`.
- `src/net/knockboxPlugin.ts:61` — a second entry in the local-tab `words` map.
- `src/game/dictionary.ts` — add a tier concept (it currently exposes only `size`, `has`,
  `wordsStartingWith`), and have `src/main.ts:34-66` load the tier the settings ask for. Still
  solo/sandbox only — networked play never fetches a dictionary.

### 3.3 The `WordPool` abstraction

New `src/game/picker/wordPool.ts`. One interface the generator draws against, with two
implementations, so solo and server run **identical** generation code:

```ts
export interface WordPool {
  has(word: string): boolean;
  count(): number;
  pick(index: number): string | null;
  countOfLength(len: number): number;
  pickOfLength(len: number, index: number): string | null;
}
```

- `kbWordPool(kb.words, key)` — a thin adapter over the injected capability; used by `authority.ts`.
- `dictionaryWordPool(dict)` — sorts each length bucket the way `buildLocalWordPool`
  (`knockbox-local.js:455-471`) does, so ordering matches; used by `LocalController`.
- **A parity test** asserting both adapters agree on `pickOfLength` ordering over a shared fixture.
  This is the assumption the binary search rests on, and a divergence would silently return wrong
  ranges rather than failing — so it must be pinned.

Thread it through `MatchDeps` (`match.ts:83`) beside `isWord`, supplied at `authority.ts:192-197`
and `localController.ts:40-50`.

### 3.4 The Offer generator

New `src/game/picker/offer.ts` — pure, RNG-injected, no I/O, no `Date`. This is the substantive new
code in M1.

**Letter-range lookup.** For required letter `L` and length `ℓ`, binary-search `pickOfLength(ℓ, ·)`
for the lower bounds of `L` and of the next letter, comparing first character only. About
2·log₂(n) probes — ≤ ~34 for the worst Full-list bucket. Cache per `ℓ` for the turn.

**Length shaping.** An explicit target distribution constant, not one derived from the pool (§2.2).
Starting table, to be tuned:

```
3–4: 15 %   5–6: 30 %   7–8: 30 %   9–10: 18 %   11+: 7 %
```

Draw `offerCount` target lengths, remapping any length whose `(L, ℓ)` range is empty to the nearest
non-empty one. Pin the **aggregate** property in tests — "P(Offer contains a 10+ word) sits in a
target band" — rather than asserting exact per-card frequencies, which would make the table
untunable.

**Ending-letter lookahead (§2.2).** Maintain `remainingByStart: Map<letter, number>`, seeded once per
match from the pool's per-letter start counts and decremented as words are used. Reject any candidate
whose last letter has `remainingByStart[last] < offerCount`. Exact, O(1) per candidate, and directly
answers the `x = 9` case in §2.3.

**Guarantees.** Sample uniformly within the `(L, ℓ)` range; reject already-played words, words already
in this Offer, and lookahead failures, with a bounded attempt count and a widen-then-relax fallback
ladder. The first accepted word satisfies Succession and uniqueness by construction, which is §2.2's
*"the Offer always contains at least one legal word"*.

**Bans are never a generation filter** (§2.2). A word carrying the era Banned Letter, a personal ban
or a hijack appears in the Offer unannounced and scores 0 when the Tax fires. Legality here means
*playable*, not *safe*.

### 3.5 Match state, select, and commit

- **`MatchState`** — `types.ts:300` — add `offer: string[]`, and default it in **`emptyMatchState`**
  (`types.ts:347`) — the single mandated defaulting point, shared by the authority and the guest
  mirror so the two cannot drift. A plain `string[]` is JSON-safe, so `src/net/serialize.ts` needs
  **no** change (contrast `usedWords`, its one hand-rolled `Set` round-trip).
- **Keep the selection transient** on the controller (`currentSelection`, mirroring `currentDraft` at
  `match.ts:128`) — **not** on `MatchState`. Nothing in the GDD requires publishing an opponent's
  in-progress selection, and this keeps the authority in broadcast mode with no new wire state.
- **`armCurrentTurn`** (`match.ts:497`) generates the Offer and arms `pickerShotClockSeconds`.
- **`commitSelection`** reuses `submitWord`'s pipeline with one added check: the word must be in the
  current Offer. Succession, uniqueness and dictionary membership already hold by construction but
  stay enforced — they are cheap and they are the trust boundary.
- **Timeout (§2.4):** commit the current selection; if none is selected, commit one at random. **There
  is no timeout point penalty in Picker** — `BASE_TIMEOUT_PENALTY` (`settings.ts:144`) and every
  card's `timeoutFold` are inert. A clock expiry with **no selection made** is a **no-show**, and
  Survival (`match.ts:791`) eliminates on the no-show rather than the timeout — otherwise Survival
  could never eliminate anyone in Picker.
- **The Wildcard (§4.1):** reframed from "one word per era may ignore Succession" to "once per era,
  your Offer ignores the required letter". Same `wildcardGuard`, same per-era re-arm; the charge is
  consumed when the free-letter Offer is generated.

### 3.6 `<ac-offer-grid>`

New `src/ui/components/ac-offer-grid.ts`, swapped in for `<ac-word-entry>` at its single mount site,
**`ac-hud.ts:182`**, when the mode is Picker.

- A wrapping `auto-fit` grid modelled on `.ban-grid` (`intermission.css:232-242`), sized through the
  existing `--gc-w` / `--gc-h` cascade so card size scales to the count — one row on desktop, two on
  a phone. **Offer Cards must never be scrolled off-screen** (§2.1); horizontal scrolling is a
  fallback beyond **8** cards only.
- **Selection is a distinct state from submission** (§2.1): first tap selects, second tap or the GO
  button commits. Required because touch devices have no hover.
- **Annotations (§2.3)** — letter count, vowel count, rare letters, ends-in-vowel — sourced from
  `analyzeWord` (`scoring.ts:43`). These are an accessibility *requirement*, not polish (§5): they let
  a player evaluate a card without fully decoding the word. One new helper is needed for *contains* a
  rare letter, since `RARE_START` (`card.ts:201`) concerns the *starting* letter.
- **Engine-fire highlighting (§2.3):** dry-run `scoreWord(candidate, bay, opts)` and map
  `steps[].triggered` onto the bay cards' existing `triggered` prop — the same mechanism
  `ac-score-replay.ts:157,301` already uses. **Discard the number: the projected score is never
  shown.** A displayed figure turns the decision into a lookup, and the uncertainty is the game.
- Reuse the `clockTick <= 0` seam at `ac-word-entry.ts:80-82` for the auto-commit, which fires
  synchronously before the engine's own timeout check.

### 3.7 Bots

- Extract the ranking half of `chooseBotWordScored` (`bots.ts:160-177`) as
  `bestScoredCandidate(candidates, opts, rng)`. A mechanical lift — it already depends only on
  `candidates`, `bay`, `scoreOpts`, `bannedLetter` and `rng`. This is exactly §7's instruction.
- In Picker, bots rank the Offer instead of walking the dictionary; `bots.ts:147-159` is the gathering
  half the Offer replaces.
- Bots must play Picker at launch (§1.1), since solo-vs-bots is the default first-run experience.
  Bots remain solo-only — `authority.ts:179-181` seeds `isBot: false` for every roster member.

### 3.8 Tests

`src/game/picker/offer.test.ts`: length distribution lands in band; Succession always satisfied;
already-played words never offered; the ending-letter lookahead refuses the `x = 9` trap; the Offer is
always served at full size; generation is deterministic under a fixed RNG. Plus the §3.3 adapter
parity test, and Picker cases in `match.test.ts` for the no-penalty timeout and the
no-show/Survival split.

---

## 4. Milestone 2 — Multiplayer and the mode-filtered deal pool

**Done when:** two local-tab clients play a Picker match with byte-identical Offers, and the lobby's
deal-capacity warning reflects the per-mode pool.

### 4.1 The two new intents (§7)

- **`Intent`** — `src/net/messages.ts:14` — add `{ kind: "selectOffer"; index: number }` and
  `{ kind: "commitSelection" }`.
- **`applyIntent`** — `authority.ts:241-280`:
  - `selectOffer` mirrors `draftWord` and must **`return null`** — no state change, no event, no
    broadcast. This matters more than it looks: there is no server-side rate limiter anywhere in the
    build, and the authority's only defence is that a null-returning intent cannot make the server fan
    out state. A broadcasting select intent would be a trivial amplification vector.
  - `commitSelection` mirrors `submit`, using `drainPatch(false)` so a rejected commit costs one
    `rejected` event rather than a forced full snapshot.
- No new identity check is needed: `fromId` is supplied by the transport, and the engine already
  rejects off-turn actors (`match.ts:565`, `:723`).
- Surface the pair on `MatchLike` / `GameController` (`src/net/controller.ts:18-75`), `NetMatch`
  (`netMatch.ts:192-223`, whose mutators route to intents), `ServerController` and `LocalController`.
- Throttle select client-side, copying `ac-word-entry.ts:174-191` — 120 ms with a guaranteed trailing
  send.

### 4.2 Mode-filtered deal pool (§7)

`DEALABLE_CARD_IDS` (`library.ts:815`), `RARITY_CARD_COUNTS` (`:821`), `rarityDealShare` (`:843`) and
`dealPoolCapacity` (`:863`) are all module-level and mode-blind. Make them mode-aware — a
`dealableCardIds(mode)` helper plus a mode parameter on the two pure functions — then update every
reader:

- `dealCards`'s per-draw pool predicate (`match.ts:1026-1032`), preserving its exactly-one-`rng()`-
  call-per-card property, which the deal's determinism depends on;
- the lobby warning and its capacity maths in `rarity-weights.ts:76-99`. **If the dealer and the
  readout disagree, the warning is simply wrong** — that is the failure this step exists to prevent.

Add a per-card mode restriction and populate the §4.4 disabled list: **The Blindfold** (masks an input
box that does not exist in Picker) and **Insurance** (negates a timeout penalty Picker does not have)
become Classic-only.

### 4.3 Tests

Extend `authority.test.ts`, whose `ServerHub` harness (`:46-136`) already runs the real
`createAuthority(kb)` over the real wire contract with an injected fake clock and
`rng: orderPreservingRng`. Model the new suite on *"authority — rarity-weighted dealing through the
server"* (`:598-662`), which already asserts that both client mirrors carry byte-identical bays — the
same shape proves both mirrors carry byte-identical Offers.

---

## 5. Milestone 3 — Preference Cards

**Done when:** the seven §3.4 cards are dealable in Picker, bubble correctly, shape the Offer, and are
provably invisible to bay-size scoring.

### 5.1 The family

Add a `preference` marker to `ModifierCard` (`card.ts:103`) plus a shape-filter hook the generator
consumes. All seven are **FX** (`op: CardOp.Fx`), scoring-inert at base ×1.0, and dealt from the same
pool at the same Intermission as every other Modifier.

**They occupy Engine Bay slots. There is no second engine.** This is the family's load-bearing
decision: a separate picker engine would be a strip of pure upside, and pure upside is not a decision.
Sharing the bay makes the family an extension of the Intermission Dilemma.

The seven (§3.4):

| Card | Effect | Cost |
|---|---|---|
| **The Sieve** | Offer contains only 6+ letter words | Can never duck a Banned Letter with a short word |
| **The Winnower** | Redraw the whole Offer, once per turn | 30 % of armed shot clock |
| **The Wide Net** | +2 Offer Cards | −15 % shot clock |
| **Tunnel Vision** | ×1.4 always | −2 Offer Cards |
| **The Prospector** | ≥1 card contains Q, X, Z or J | An Offer slot spent on a word you may not want |
| **The Tide** | Offer drawn vowel-heavy where the pool allows | Narrower pool → more repeats, thinner ending-letter graph |
| **The Sentinel** | ≥1 card guaranteed clean of every ban against you | An Offer slot spent on safety, not ceiling |

**Design guardrail (§3):** these are shape constraints with a cost, not alignment buffs. Any
Preference Card that is strictly good for its owner is mis-designed.

**Proposed rarities — for review, not asserted as balanced.** §8 leaves these open, and because the
cards compete with scoring cards for slots, their deal rate directly controls how often the mode's
central dilemma is actually posed:

> Sieve *Common* · Wide Net *Common* · Tide *Uncommon* · Prospector *Uncommon* ·
> Winnower *Rare* · Sentinel *Rare* · Tunnel Vision *Legendary*

Restrict all seven to Picker through §4.2's mechanism.

**The Winnower's once-per-turn charge:** add a `TurnGuard` beside `EraGuard` (`roomServices.ts:23`),
reset in `fireTurnStarted` (`roomServices.ts:141`) — the no-op seam that already exists for exactly
this.

### 5.2 Placement and bubbling (§3.1)

Enforce "auto-bubble to the leftmost position that is not already a Preference Card" in
`setPlayerBay` (`match.ts:1081-1107`), which today accepts **any** permutation of owned uids. This is
a genuinely new invariant, not a tightening of an existing one.

It is not cosmetic: the Magnifying Glass magnifies the card immediately to its right, so a
manually-placed Preference Card would silently waste it. Bubbling makes that interaction impossible
rather than punishing. Preference Cards must **not** shift the relative order of scoring cards, so
bubbling never changes what a word scores. Mirror the rule in the optimize UI
(`ac-intermission.ts:93-102`, `:233-282`) so the client cannot present an order the authority will
reject.

### 5.3 Scoring invisibility (§3.3)

Add a `scoringBay(bay)` helper and pass it wherever a bay reaches `makeBayEvaluator` / `scoreWord` /
`scoreTimeout`. Per §2.5 this satisfies every §3.3 clause at once. **Keep the full bay for
`armedClockSeconds`** so The Wide Net's clock delta still applies.

**One judgement call, flagged.** §3.3 names *bay length* and *cards to the right* but not *slots*.
Booster Pack scales by slot **capacity**, which is unchanged by what occupies it — so a player with 5
slots and 2 Preference Cards gets Booster Pack scaling by 5 while seeing only 2 cards to its right.
That follows the GDD literally, but it is worth a balance look.

### 5.4 Composition and unsatisfiable filters (§3.2)

Filters compose left → right and intersect; their order relative to each other is player-controlled
and meaningful. **A filter that would drop the candidate pool below the configured Offer count is
skipped entirely, not partially applied** — so the picker can never soft-lock, and the Offer is always
served at full size. Skipping must be deterministic.

### 5.5 Bots

Teach `planBotBay` (`bots.ts:197-234`) about the family, per §2.7 — otherwise bots discard every
Preference Card on their first optimize. Needs a Preference-aware `OP_RANK` treatment (so FX rank
doesn't fight bubbling) and a marginal-value loop that doesn't value a shape filter at 0.

### 5.6 Tests

Per-card suites in the `library.test.ts` idiom (one `describe` per card), plus explicit regression
tests that **Dividend and Booster Pack do not inflate** with Preference Cards in the bay, that a
Magnifying Glass can never target one, and that an unsatisfiable filter is skipped deterministically.
Note `library.test.ts:330-343` pins the current 18/15/11/3 rarity distribution and will need updating.

---

## 6. Milestone 4 — Accessibility, tutorial, and copy

- **Banned-letter highlighting** (§5) — the `highlightBannedLetters` setting from §3.1, **off by
  default**. Highlights occurrences of an active Banned Letter inside Offer words. Purely a rendering
  change: no rules, balance or network effect, and it leaks nothing the HUD has not already published.
  Competitive tables leave it off and keep the surprise of §2.2.
- **The Offer tutorial** (§1.1) — `TutorialKind` (`types.ts:172`) gains `offer`, plus a
  `pickerTimeout` variant, because `timeout` changes meaning entirely in Picker (§2.4) while
  **Classic must keep its existing walkthrough byte-identical**. Each new kind needs:
  - a `SCRIPTS` entry (`ac-tutorial.ts:26`),
  - a `renderStage` case (`:122-198`),
  - a `TUTORIAL_DWELL` entry (`match.ts:56`)

  — all three exhaustive, so omissions are compile errors — **and** an entry in `PREGAME_TUTORIALS`
  (`match.ts:68`), which is **not** exhaustive and is therefore the one that is easy to forget. Select
  the pre-game list by mode.
- **Player-facing copy** (§7) — `README.md:3-6` describes typed play as the game. Also stale: `:8-10`
  ("~12 cards" vs the shipped 47), `:44-45` (Phaser scenes and `src/scenes/`, which no longer exist —
  gameplay is Lit components), `:58` (lists tutorials as unbuilt). Plus the solo lobby's rules blurb
  at `ac-lobby.ts:295-298`.
- A Picker affordance in the Testing Bay (`ac-sandbox.ts`, `bench.ts`).

---

## 7. Milestone 5 — Per-mode retuning (playtest-gated)

Picker changes the clock economy: committing a selection is far faster than typing a word, so every
card reading "time left on the clock" pays closer to its ceiling, and every card whose downside is a
timeout drain loses that downside entirely.

**These carry per-mode values. Classic's numbers stay byte-identical.**

- **Panic Button**, **Speedracer** — multipliers scaling with remaining clock; both approach their
  caps routinely in Picker. Retune the curves, not the caps.
- **Chrono Syphon** — banks per whole second left on an opponent's clock. Fast commits inflate this
  substantially; the most affected card in the catalogue.
- **The Vault**, **Redline** — clock costs still bite (evaluation genuinely takes time), but their
  timeout drains never fire. Both are net buffed and should be re-costed.
- **The Sniper** — its leader clock-shave is stronger in Picker. No change expected, but it is the one
  aggression card whose value moves.

Explicitly checked as unaffected (§4.4): **Scavenger** and **The Blueprint** (both read submission
history and previous word length, intact), the entire tax and siphon economy, and every card whose
trigger is purely a property of the word's shape.

**This milestone should not begin before M1 yields real play data.** The GDD defers these curves to
playtest, and guessing them is the one change in this plan that could regress Classic.

---

## 8. Pre-existing issue found (not in scope)

The validator comment at `settings.ts:165` claims *"Ranges mirror the lobby limits"*, but two do not:

| Setting | Lobby max | Validator |
|---|---|---|
| `eraCount` | **50** (`ac-lobby.ts:201-202`, `ac-net-lobby.ts:307-308`) | `inRange(1, 20)` (`settings.ts:177`) |
| `eraInterval` | **50** (`ac-lobby.ts:208-209`) | `inRange(1, 20)` (`settings.ts:176`) |

A host who sets 30 eras has it saved, then **silently reset to 4 on reload**, and sanitized away
server-side at `authority.ts:178`. Not caused by this work and not fixed by it — recorded here so the
pattern is not mistaken for intent. Picker's new settings are given matching lobby and validator
bounds (§3.1) so they do not join it.

---

## 9. Verification

### 9.1 Automated

`npm test` (Vitest, `src/**/*.test.ts`, co-located) and `npm run build`
(`tsc --noEmit && vite build && npm run build:authority`).

The build is a real gate here, not a formality: the authority bundle must remain a **single
import-free ESM file** with no `Date`, `fetch` or DOM, so a stray import in the picker module fails
`build:authority`.

New coverage by milestone:

| Milestone | Coverage |
|---|---|
| M1 | `offer.test.ts` (distribution, succession, uniqueness, lookahead, full-size, determinism) + the `WordPool` adapter parity test |
| M2 | Picker suites in `authority.test.ts`'s `ServerHub`, proving identical Offers on both mirrors |
| M3 | Per-card suites + the Dividend / Booster Pack non-inflation regressions |
| M4 | A Picker tutorial test in the `tutorial.test.ts` shape |

### 9.2 Manual

1. **Solo vs bots** — the default launch. Play a full match and confirm: the Offer renders unscrolled
   at counts 3–8; two-stage commit works with both a mouse and touch emulation; annotations are
   correct; selecting highlights the right bay cards; **no score is ever displayed**; a timeout
   commits rather than penalises. Resize to phone width to check the two-row layout and the
   `60rem` / `30rem` breakpoints.
2. **Multiplayer** — local-tab authority mode (`?kbLocal=tab`) with two clients: both see the same
   Offer, only the active player can commit, and a late-joining client's snapshot carries the Offer.
   This path also runs the emulation's `PoisonDate` fidelity check, so it catches any accidental
   `Date` use in the generator.
3. **Classic unregressed** — switch to Classic and play a match: typed entry, the timeout penalty,
   Blindfold and Insurance still dealt and working, tutorial walkthrough unchanged.
4. **Sandbox** (`?sandbox`) — force specific Preference Cards into a bay and confirm bubbling, filter
   composition, and that Dividend / Booster Pack totals are unchanged by their presence.
5. **Settings** — set every new value, reload, confirm persistence; confirm the version bump discards
   a stale v3 blob rather than loading out-of-range values.
