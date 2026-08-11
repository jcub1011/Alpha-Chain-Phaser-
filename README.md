# Alpha Chain

A word-chain game (Shiritori succession) fused with a strategic engine-builder, ported from the
.NET Blazor original. Each word must start with the previous word's last letter, while a
left-to-right "Engine Bay" of modifier cards multiplies your score. Portrait-first; plays on
desktop and mobile, solo against bots or in a real multiplayer lobby.

## Two ways to play

**Picker** (the default). Each turn the server offers you a handful of candidate words and you
choose one. Everything downstream is identical to typed play — the word runs through your Engine
Bay, sets the next player's letter, and is subject to the Zero-Point Tax.

Picker exists because Classic asks for two things that have nothing to do with the strategy:
recalling a word on demand, and typing it accurately on a phone against a shot clock. Both are hard
walls for dyslexic players and for mobile users. Picker trades them for **evaluation** — reading
several words and knowing which shape your engine pays best for — so the engine becomes the primary
skill rather than the dictionary. Offer Cards are annotated with the features the engine scores on
(length, vowels, rare letters), selecting one highlights the bay cards it would fire, and the
projected score is deliberately never shown.

**Classic.** Type the word yourself, against the clock. Unchanged.

Seven **Preference Cards** are dealt in Picker only. They shape the Offer instead of scoring the
word — narrowing it to long words, guaranteeing a rare letter or a ban-free option, widening or
shrinking it, buying a redraw — and they occupy Engine Bay slots to do it, so every one is a trade
against raw scoring power rather than a free upgrade.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle + authority module
npm test           # vitest unit + integration tests
npm run lint       # eslint
```

`?sandbox` opens the Testing Bay: stack any bay from the full catalogue, switch modes, submit or
pick words, and inspect every card's contribution step by step. `?kbLocal=tab` opens the no-server
multi-tab harness, which runs the real server-authority module in-process — open it in two tabs for
a genuine multiplayer session.

To package the game as a drop-in folder for the KnockBox-Games platform, run
`npm run export:game:install`. See [EXPORT.md](EXPORT.md) for details.

## Architecture

Pure game logic is fully decoupled from the UI, so it is deterministic and unit-testable — and it
runs unchanged inside the server-authoritative authority module (`src/server/authority.ts`), which
the KnockBox server executes sandboxed, one instance per lobby. That module must stay a single
import-free ESM file with no `Date`, `fetch` or DOM; `npm run build:authority` enforces it.

- `src/game/` — engine-agnostic core (no rendering imports)
  - `match.ts` — the FSM + single source of truth (`Setup → Countdown → Round → Intermission → … → GameOver`)
  - `scoring.ts` — the left→right Engine Bay fold
  - `cards/` — the `ModifierCard` interface + the 54-card library
  - `picker/` — Picker's Offer generator (`offer.ts`), the Preference Card family
    (`preference.ts`), and the word-source abstraction shared by solo and server (`wordPool.ts`)
  - `dictionary.ts` — the bundled word lists
  - `bots.ts` — difficulty-tuned opponents, who play both modes
- `src/net/` — the gameplay/transport seam
  - `controller.ts` — the `GameController` interface both modes of play talk to
  - `localController.ts` — solo-vs-bots (non-networked)
  - `serverController.ts` — networked: sends intents to, and renders the state broadcast by, the
    server authority module (`addons/knockbox/`)
  - `netMatch.ts` — the read-only mirror every networked client renders from
- `src/server/authority.ts` — the server-authoritative rules module (bundled to `authority.js`)
- `src/ui/` — Lit web components: `app/` (shell), `views/` (lobby, HUD, intermission, tutorial,
  sandbox), `components/` (cards, shot clock, word entry, offer grid)
- `src/theme.ts`, `src/styles/` — neon-noir palette + animations ported from the original CSS

## Reused assets

- `public/assets/words.txt` — the full 386k list, from `KnockBox.WordService/Data/full-dictionary.csv`
- `public/assets/words-common.txt` — the ~9k common-word list Picker draws Offers from, generated
  by `tools/build-common-wordlist.mjs` (see that file for why it is an intersection, not a copy)
- `public/assets/cards.svg` — card icons (symbol ids match card ids)
- Color/animation spec from the original `alpha-chain-theme.css`

## What's next

- Per-mode card retuning. Picker changes the clock economy — committing a selection is far faster
  than typing a word — so every card that reads "time left on the clock" pays closer to its ceiling,
  and every card whose downside is a timeout drain loses that downside. Deliberately deferred until
  Picker has real play data; Classic's numbers stay untouched.
- A balance pass on the Preference Cards' rarities, which are first proposals rather than tuned.
