# Alpha Chain — Phaser port

A Phaser 4 + TypeScript port of the .NET Blazor game **Alpha Chain**: a high-velocity
word-chain game (Shiritori succession) fused with a strategic engine-builder. Each word
must start with the previous word's last letter, while a left-to-right "Engine Bay" of
modifier cards multiplies your score. Portrait-first; plays on desktop and mobile.

This is a **vertical slice**: the full game loop vs. AI opponents with a representative
subset of ~12 cards. It is architected to expand to all 40 cards and to drop in the
KnockBox networking layer for real multiplayer later.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle
npm test           # vitest unit + integration tests
```

To package the game as a drop-in folder for the KnockBox-Games platform, run
`npm run export:game:install`. See [EXPORT.md](EXPORT.md) for details.

## Architecture

Pure game logic is fully decoupled from Phaser, so it is deterministic and unit-testable —
and it runs unchanged inside the server-authoritative authority module (`src/server/authority.ts`),
which the KnockBox server executes sandboxed, one instance per lobby.

- `src/game/` — engine-agnostic core (no Phaser imports)
  - `match.ts` — the FSM + single source of truth (`Setup → Countdown → Round → Intermission → … → GameOver`)
  - `scoring.ts` — the left→right Engine Bay fold (port of `EngineEvaluator`)
  - `cards/` — `ModifierCard` interface + the slice card library
  - `dictionary.ts` — the bundled 386k-word list (validation Set + first-letter index for bots)
  - `bots.ts` — difficulty-tuned opponent word selection
- `src/net/` — the gameplay/transport seam
  - `controller.ts` — `GameController` interface
  - `localController.ts` — solo-vs-bots implementation (non-networked)
  - `serverController.ts` — networked implementation: sends intents to, and renders the
    authoritative state broadcast by, the server authority module (`addons/knockbox/`)
  - `netMatch.ts` — the read-only mirror every networked client renders from
- `src/server/authority.ts` — the server-authoritative rules module (bundled to `authority.js`);
  validates words via the server word service (`kb.words`) so clients can't submit fake words
- `src/ui/` — reusable Phaser widgets (`Card`, `ShotClockRing`, `WordInput`, panels/buttons, icons)
- `src/scenes/` — `Boot → Lobby → Game → Intermission → GameOver`
- `src/theme.ts` — neon-noir palette + animation factories ported from the original CSS

## Reused assets

- `public/assets/words.txt` — dictionary from `KnockBox.WordService/Data/full-dictionary.csv`
- `public/assets/cards.svg` — card icons (symbol ids match card ids), baked into tinted textures
- Color/animation spec from the original `alpha-chain-theme.css`

## What's next (to reach full parity)

- The remaining 28 cards (reactive economy, automated aggression, the shield, glass-cannon
  clock/UI effects) plug into the same `ModifierCard` interface + match hooks.
- Survival mode, tutorials, personal bans.
- Server-authoritative multiplayer via `src/server/authority.ts` (done): predictable latency,
  the session survives the owner leaving, and rules run where clients can't tamper.
