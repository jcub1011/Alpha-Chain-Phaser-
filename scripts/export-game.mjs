/*
 * Assembles the drop-in KnockBox game folder.
 *
 *   node scripts/export-game.mjs [--out <gamesDir>] [--no-build]
 *
 * Runs `vite build`, then copies the built `dist/` plus the `export/GAME.json`
 * manifest and `export/thumb.svg` into `<gamesDir>/alpha-chain/`. The folder
 * name MUST equal the manifest id ("alpha-chain") so the platform serves assets
 * at /games/alpha-chain/…. With no --out it writes to `dist-game/`.
 *
 * Drop the result into KnockBox-Games/games/ and it appears in the lobby within
 * a second (catalog hot-reload) — no server restart.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const gamesDir = outFlag >= 0 ? resolve(args[outFlag + 1]) : join(root, "dist-game");
const doBuild = !args.includes("--no-build");

const manifest = JSON.parse(readFileSync(join(root, "export", "GAME.json"), "utf8"));
const id = manifest.id;
if (!id || !manifest.name || !manifest.entry) {
  throw new Error("export/GAME.json must define id, name, and entry.");
}

if (doBuild) {
  console.log("• building (vite build)…");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
}

const dist = join(root, "dist");
if (!existsSync(join(dist, manifest.entry))) {
  throw new Error(`Built entry not found: dist/${manifest.entry}. Did the build run?`);
}

const target = join(gamesDir, id); // folder name === manifest id (platform requirement)
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// Built bundle (index.html + hashed JS/CSS + assets/), then the manifest + thumbnail.
cpSync(dist, target, { recursive: true });
cpSync(join(root, "export", "GAME.json"), join(target, "GAME.json"));
if (manifest.thumbnail) {
  cpSync(join(root, "export", manifest.thumbnail), join(target, manifest.thumbnail));
}

console.log(`✓ exported "${manifest.name}" → ${target}`);
console.log(`  drop ${id}/ into KnockBox-Games/games/ (it hot-reloads).`);
