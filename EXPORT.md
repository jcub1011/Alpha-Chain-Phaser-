# Exporting to KnockBox-Games

This game ships with a one-command exporter that assembles a **drop-in folder** for
the [KnockBox-Games](../../KnockBox-Games) platform. The platform discovers games by
scanning `games/*/GAME.json` and hot-reloads within ~1–2 seconds, so a fresh export
appears in the lobby without restarting the server.

## TL;DR

From this repo's root:

```sh
npm run export:game:install
```

That builds the game and writes `alpha-chain/` straight into the sibling
`../../KnockBox-Games/games` directory. Done — it shows up in the lobby.

## The commands

| Command | What it does |
| --- | --- |
| `npm run export:game:install` | Builds, then installs into `../../KnockBox-Games/games/alpha-chain/`. Use this to deploy. |
| `npm run export:game` | Builds, then writes to a local `dist-game/alpha-chain/` for inspection (doesn't touch KnockBox-Games). |
| `node scripts/export-game.mjs [--out <dir>] [--no-build]` | The underlying script. `--out` sets the target `games` dir; `--no-build` skips `vite build` and reuses the existing `dist/`. |

`export:game:install` is just `node scripts/export-game.mjs --out ../../KnockBox-Games/games`.
Because the two repos sit side by side under `…/source/repos/`, `../../KnockBox-Games/games`
resolves to `…/source/repos/KnockBox-Games/games`. If your checkout layout differs,
run the script directly with an explicit `--out` path.

The script wipes any existing `alpha-chain/` target before copying, so re-running it
cleanly re-exports.

## What gets produced

A self-contained folder whose **name equals the manifest `id`** (`alpha-chain`) — a
hard requirement of the platform, which serves the folder's contents at
`/games/alpha-chain/…`:

```
alpha-chain/
├── GAME.json        # manifest (from export/GAME.json)
├── thumb.svg        # lobby thumbnail (from export/thumb.svg)
├── index.html       # built entry point
└── assets/          # hashed JS/CSS bundles, words.txt, glyph SVGs
```

`scripts/export-game.mjs` runs `vite build` (output → `dist/`), then copies `dist/`
plus `export/GAME.json` and `export/thumb.svg` into the target folder. `vite.config.ts`
sets `base: "./"`, so every asset path is relative and works correctly when the game
is served from the `/games/alpha-chain/` subpath.

## The manifest

The manifest lives at [`export/GAME.json`](export/GAME.json) and is copied verbatim
into the export:

```json
{
  "id": "alpha-chain",
  "name": "Alpha Chain",
  "entry": "index.html",
  "thumbnail": "thumb.svg",
  "maxPlayers": 8
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique catalog key **and** URL segment. The export folder name must match this exactly. |
| `name` | Display name shown in the lobby browser. |
| `entry` | Relative path to the HTML entry file inside the folder. |
| `thumbnail` | Relative path to the lobby thumbnail image. |
| `maxPlayers` | Max players the platform allows into a lobby for this game. |

To change any of these, edit `export/GAME.json` (and `export/thumb.svg` for the
thumbnail) and re-export.

## Multiplayer works out of the box

The KnockBox SDK is **bundled into the build** — there is no external `/knockbox.js`
tag to add. When the shell embeds the game it passes a lobby ticket in the URL
fragment; `src/net/launch.ts` detects `#kbTicket=` and `src/net/knockBoxController.ts`
connects using that ticket and endpoint. Without a ticket the game runs standalone
(solo-vs-bots), or `?kbLocal=tab` opts into the no-server multi-tab test harness. So
the exported folder genuinely plays in a lobby — it isn't just a catalog listing.

## Verify the export

1. Run `npm run export:game:install`. It should finish with
   `✓ exported "Alpha Chain" → …\KnockBox-Games\games\alpha-chain`.
2. Confirm `KnockBox-Games/games/alpha-chain/` contains `GAME.json`, `thumb.svg`,
   `index.html`, and `assets/`.
3. Start the host (from the KnockBox-Games repo):
   `dotnet run --project KnockBox.Server --launch-profile http`. The catalog
   hot-reloads — no restart needed.
4. Open the shell (http://localhost:5114), confirm **Alpha Chain** appears in the
   lobby browser with its thumbnail, create a lobby, and launch. The game should load
   and run inside the iframe.
