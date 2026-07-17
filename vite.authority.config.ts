/*
 * Build for the server authority module (src/server/authority.ts → dist/authority.js).
 *
 * The KnockBox server runs this file sandboxed (Jint), so it must be a SINGLE
 * import-free ES module ≤ 1 MB with no browser/ambient APIs. This config:
 *   - bundles the whole rules layer (MatchController + deps) into one ESM file
 *     (inlineDynamicImports), target es2020;
 *   - aliases every `../log` import to src/server/serverLog.ts so the rules layer's
 *     logging routes to kb.log instead of console / import.meta.env (absent in Jint);
 *   - copies the word list to dist/words.txt — a path DISTINCT from the client-served
 *     assets/words.txt, because the game origin denies the authorityWords file (see
 *     GAME.json authorityWords) while solo mode still fetches assets/words.txt.
 *
 * Runs AFTER the client `vite build` (emptyOutDir:false), appending to dist/.
 * Wired into `npm run build` / `export:game` (package.json).
 */

import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { copyFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const realLog = path.resolve(here, "src/log.ts");
const shimLog = path.resolve(here, "src/server/serverLog.ts");

/** Redirect the browser logger (src/log.ts) to the sandbox-safe kb.log shim. Matches by
 *  RESOLVED id, so it catches every `../log` / `../../log` import regardless of depth. */
function aliasLogToShim(): Plugin {
  return {
    name: "alias-log-to-server-shim",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || path.resolve(importer) === shimLog) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved && path.resolve(resolved.id) === realLog) return shimLog;
      return null;
    },
  };
}

/** Copy the dictionary to the server-only authority path after the bundle is written. */
function copyWordList(): Plugin {
  return {
    name: "copy-authority-word-list",
    closeBundle() {
      copyFileSync(
        path.resolve(here, "public/assets/words.txt"),
        path.resolve(here, "dist/words.txt"),
      );
    },
  };
}

export default defineConfig({
  plugins: [aliasLogToShim(), copyWordList()],
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: false, // append to the client build, don't wipe it
    minify: false, // readable + well under the 1 MB module limit without the dictionary
    // Single self-contained chunk — the sandbox has no module loader. Lib mode with a
    // single entry and only static imports already emits one file.
    lib: {
      entry: path.resolve(here, "src/server/authority.ts"),
      formats: ["es"],
      fileName: () => "authority.js",
    },
  },
});
