# Exporting to KnockBox-Games

This game exports as a single drop-in **`.kbg` package** for the
[KnockBox-Games](https://github.com/jcub1011/KnockBox-Games) platform. An operator copies that one
file into the server's games directory and the server installs it — no unzipping, no CLI on the host,
no restart. The catalog hot-reloads within ~1–2 seconds.

Two KnockBox pieces are involved, and they are versioned independently of this game:

| Piece | What it is | How this repo gets it |
| --- | --- | --- |
| **`knockbox-cli`** | the packer (`knockbox pack`) | a `devDependency` — `npm ci` installs it |
| **`addons/knockbox/`** | the Phaser client the game bundles | installed by `knockbox addon`, recorded in `knockbox.json` |

Neither is copied by hand any more. See
[`docs/ADDONS.md`](https://github.com/jcub1011/KnockBox-Games/blob/main/docs/ADDONS.md) upstream.

## TL;DR

```sh
npm run export:game
```

Builds the game and writes `dist-game/jcub1011-Alpha-Chain.kbg`. Copy that file into the server's
games directory and it installs itself.

To write straight into a local platform checkout instead, point `KNOCKBOX_GAMES_DIR` at its `games/`
folder and omit `--out`:

```sh
KNOCKBOX_GAMES_DIR=../../KnockBox-Games/games npx knockbox pack \
  --build "npm run build" --in dist --manifest export/GAME.json
```

With neither `--out` nor `KNOCKBOX_GAMES_DIR`, the packer stops and says so rather than guessing —
it used to resolve a default relative to its own location, which quietly created a stray `games/`
folder inside whichever project it was installed in.

## The commands

| Command | What it does |
| --- | --- |
| `npm run export:game` | Builds, then writes `dist-game/jcub1011-Alpha-Chain.kbg`. |
| `npx knockbox addon check` | Verifies `addons/knockbox/` matches what was published, and reports available updates. Changes nothing. |
| `npx knockbox addon update` | Moves the bundled client to a newer version. **Re-export afterwards** — the client is compiled into the build. |

The export script is:

```
knockbox pack --build "npm run build" --in dist --manifest export/GAME.json --out dist-game/
```

`--build` runs this repo's own build first (`tsc --noEmit && vite build && vite build --config
vite.authority.config.ts`), so `dist/` is always fresh. Everything under `--in` goes into the
package, plus `export/GAME.json` and the thumbnail it names.

## What gets produced

A single `jcub1011-Alpha-Chain.kbg` file — a plain ZIP whose payloads are individually
Brotli-compressed at maximum effort, so the server copies those streams straight into its HTTP
serving cache instead of re-compressing on every cold boot. `unzip -l` can inspect it.

```
jcub1011-Alpha-Chain.kbg
├── KBG.json         # package header: formatVersion, id, files[], packedBy
├── GAME.json        # manifest (from export/GAME.json, plus the SDK stamp below)
├── thumb.svg        # lobby thumbnail
├── index.html       # built entry point
├── authority.js     # the server-authority module
├── words.txt / words-common.txt
└── assets/          # hashed JS/CSS bundles, glyph SVGs
```

`vite.config.ts` sets `base: "./"`, so every asset path is relative and works when the game is
served from the `/games/jcub1011-Alpha-Chain/…` subpath.

Packing is slow on purpose — Brotli at maximum effort. Pass `--quality 1` for a fast throwaway
build; the default is what you want for anything you publish.

## The manifest

[`export/GAME.json`](export/GAME.json) is copied into the package with one addition (below):

| Field | Meaning |
| --- | --- |
| `id` | Unique catalog key **and** URL segment. Names the installed folder. |
| `name` | Display name in the lobby browser. |
| `entry` | Relative path to the HTML entry file. |
| `thumbnail` | Relative path to the lobby thumbnail. |
| `maxPlayers` | Max players per lobby. |
| `version` | This game's build label. What the marketplace compares to decide whether an operator's copy is stale. |
| `serverAuthority` | The module the **server** runs, one sandboxed instance per lobby. |
| `authorityWords` | Word dictionaries the server loads once and shares across lobbies. |
| `description`, `tags`, `$schema` | Marketplace catalog fields. |

### The SDK stamp

The packer reads `knockbox.json` and records the client version the build was made against:

```json
{ "id": "jcub1011-Alpha-Chain", "…": "…", "sdk": { "phaser": "1.0.0" } }
```

`export/GAME.json` on disk is **not** modified — the stamp is generated into the package. The server
never validates it; the admin portal uses it to flag a game still running on an old client. Pass
`--no-sdk-stamp` to omit it.

## Multiplayer works out of the box

The KnockBox client is **bundled into the build** — there is no external `/knockbox.js` tag. When the
shell embeds the game it passes a lobby ticket in the URL fragment; `src/net/launch.ts` detects
`#kbTicket=` and `src/net/knockBoxController.ts` connects with it. Without a ticket the game runs
standalone (solo-vs-bots), and `?kbLocal=tab` opts into the no-server multi-tab harness.

Because the client is bundled, **updating the addon does nothing until you re-export.** That is the
one ordering rule worth remembering:

```sh
npx knockbox addon update      # get the new client
npm run export:game            # actually ship it
```

## Verify the export

1. `npm run export:game` → `✓ packed "Alpha Chain" → …\dist-game\jcub1011-Alpha-Chain.kbg`
2. Copy that file into the server's games directory (or use `KNOCKBOX_GAMES_DIR` above).
3. Start the host: `dotnet run --project KnockBox.Server --launch-profile http`. The catalog
   hot-reloads — no restart.
4. Open the shell (http://localhost:5114), confirm **Alpha Chain** appears with its thumbnail,
   create a lobby, and launch.
5. Optionally check the admin portal's **Game Catalog** (http://localhost:5116) — the game should
   show its SDK version, with no "SDK outdated" badge.

## CI

`.github/workflows/release.yml` wires this up via a manual workflow dispatch (`Actions` → `Release` → **Run workflow**):

- **Dynamic Tagging:** Sourced directly from `version` in `export/GAME.json` (e.g. `1.0.0` becomes `v1.0.0`).
- **Replace Existing Tag:** Overwrites an existing release and tag with the same version number if enabled. When `false` (the default), the workflow checks early and fails immediately if the tag already exists.
- **Draft:** Builds and packages the game and uploads the `.kbg` as a workflow build artifact without creating a git tag, creating a GitHub release, or updating the marketplace.

Add a `MARKETPLACE_TOKEN` secret (a PAT with write access to the catalog repo) to enable marketplace sync; without it that step is skipped, so a game you only ever hand to your own servers needs no extra setup.

