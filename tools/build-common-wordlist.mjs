/*
 * Generates public/assets/words-common.txt — the "Reduced" Offer dictionary for Picker mode.
 *
 * WHY THIS EXISTS RATHER THAN A PLAIN COPY.
 * The source list (KnockBox.WordService/Data/reduced-dictionary.csv, 9,884 bare words despite the
 * .csv extension) is NOT a subset of the full list this game already ships: 613 of its entries are
 * absent from public/assets/words.txt. That matters because MatchController.submitWord validates
 * every commit through `isWord`, which is bound to the FULL list in both game modes — so an offered
 * word missing from Full would be rejected as "not-a-word", including the random pick a Picker
 * timeout commits. Taking the intersection removes that failure by construction.
 *
 * The dropped entries are also the least decodable ones in the list — web/brand noise like `aol`,
 * `api`, `asn`, `apnic`, `adidas`, `adware` and the misspelling `alot` — which cuts against the whole
 * point of the Reduced pool (whole-word recognition for dyslexic readers). Words under 3 letters go
 * too: match.ts rejects anything shorter than 2, and 2-letter words are never drawn by the Offer
 * generator's length bands.
 *
 * NOT WIRED INTO `npm run build`. It reads a path outside this repository, so a clean checkout would
 * break. The output is committed; re-run this by hand only when the source list changes.
 *
 *   node tools/build-common-wordlist.mjs [--source <path>] [--check]
 *
 *   --check  Verify the committed asset matches what this script would emit; exit 1 if it drifted.
 *            Writes nothing. Useful after touching words.txt.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const DEFAULT_SOURCE = path.resolve(
  repo,
  "../../KnockBox/host/KnockBox.WordService/Data/reduced-dictionary.csv",
);
const FULL = path.resolve(repo, "public/assets/words.txt");
const OUT = path.resolve(repo, "public/assets/words-common.txt");

/** Shortest word the Offer generator may serve. See the header note. */
const MIN_LENGTH = 3;

/** Split on either line ending, trim, lowercase, drop blanks. Mirrors Dictionary.load. */
function readWords(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const sourceArg = args.indexOf("--source");
const source = sourceArg >= 0 ? path.resolve(args[sourceArg + 1]) : DEFAULT_SOURCE;

const full = new Set(readWords(FULL));
const reduced = readWords(source);

const dropped = { notInFull: 0, tooShort: 0, notAlpha: 0, duplicate: 0 };
const kept = new Set();
for (const w of reduced) {
  if (!/^[a-z]+$/.test(w)) dropped.notAlpha++;
  else if (w.length < MIN_LENGTH) dropped.tooShort++;
  else if (!full.has(w)) dropped.notInFull++;
  else if (kept.has(w)) dropped.duplicate++;
  else kept.add(w);
}

// Sorted so the file is stable and diffable across regenerations. Plain ASCII sort matches the
// ordering the platform's WordPoolSet and the local kb.words emulation both use.
const out = [...kept].sort().join("\n") + "\n";

console.log(`source   ${source}`);
console.log(`  read       ${reduced.length}`);
console.log(`  -notInFull ${dropped.notInFull}`);
console.log(`  -tooShort  ${dropped.tooShort} (< ${MIN_LENGTH} letters)`);
if (dropped.notAlpha) console.log(`  -notAlpha  ${dropped.notAlpha}`);
if (dropped.duplicate) console.log(`  -duplicate ${dropped.duplicate}`);
console.log(`  = kept     ${kept.size}`);

if (checkOnly) {
  let current = null;
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`\nFAIL ${OUT} does not exist — run without --check to generate it.`);
    process.exit(1);
  }
  if (current !== out) {
    console.error(`\nFAIL ${OUT} is stale — re-run without --check to regenerate.`);
    process.exit(1);
  }
  console.log(`\nOK ${path.relative(repo, OUT)} is up to date.`);
} else {
  writeFileSync(OUT, out, "utf8");
  console.log(`\nwrote ${path.relative(repo, OUT)} (${kept.size} words)`);
}
