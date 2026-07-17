/*
 * Bootstrap. Loads the bundled lexicon + card sprite, mounts the DOM UI, and
 * boots the Phaser FX overlay. No Phaser scenes drive gameplay any more — the
 * game loop runs from <ac-app>, and the FX canvas is purely decorative.
 */

import "./styles/index.css";
import { Dictionary } from "./game/dictionary";
import { loadSettings } from "./game/settings";
import { attachKnockBoxSink, createLogger } from "./log";
import { detectLaunch } from "./net/launch";
import { fx } from "./ui/fx/fx";
// Side-effect import registers <ac-app>; the type import is erased at build.
import "./ui/app/ac-app";
import type { AcApp } from "./ui/app/ac-app";

const log = createLogger("boot");

/** Surface otherwise-silent runtime failures (uncaught errors, rejected promises). */
function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    log.critical(`uncaught error: ${e.message}`, e.error ?? e);
  });
  window.addEventListener("unhandledrejection", (e) => {
    log.error(`unhandled promise rejection: ${String(e.reason)}`, e.reason);
  });
}

async function boot(): Promise<void> {
  // 0. Resolve the launch mode ONCE, up front. The KnockBox plugin scrubs the
  //    ticket out of location.hash the moment it starts, so detectLaunch() is only
  //    reliable before the Phaser game boots — capture it here and thread it down.
  const launchMode = detectLaunch();
  // The ~4 MB lexicon is only needed on the CLIENT for offline play: solo-vs-bots and
  // the dev Testing Bay. In server-authoritative networked play the server owns the
  // dictionary (the word service), so the client skips the download entirely — it never
  // touches the wire, keeping networked load fast.
  const isSandbox = new URLSearchParams(location.search).has("sandbox");
  const needsDict = launchMode === "solo" || isSandbox;
  log.info(`booting (launch=${launchMode}, lexicon=${needsDict ? "loading" : "skipped (server-side)"})`);

  // 1. Card icon sprite (always) + the lexicon (only when the client needs it), in parallel.
  const spritePromise = fetch("assets/cards.svg");
  const wordsPromise = needsDict ? fetch("assets/words.txt") : null;
  const spriteRes = await spritePromise;
  if (!spriteRes.ok) {
    // Fail fast: reading .text() off a non-OK response would feed error-page HTML in as garbage.
    throw new Error(`sprite fetch failed (${spriteRes.status})`);
  }
  const spriteText = await spriteRes.text();

  let dict: Dictionary | undefined;
  if (wordsPromise) {
    const wordsRes = await wordsPromise;
    if (!wordsRes.ok) throw new Error(`words fetch failed (${wordsRes.status})`);
    const wordsText = await wordsRes.text();
    dict = new Dictionary(
      wordsText
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0),
    );
    log.info(`dictionary loaded (${dict.size} words)`);
  }

  // 2. Inject the SVG <symbol> sprite once so <use href="#id"> resolves anywhere.
  const sprite = document.createElement("div");
  sprite.id = "ac-sprite";
  sprite.style.display = "none";
  sprite.setAttribute("aria-hidden", "true");
  sprite.innerHTML = spriteText;
  document.body.appendChild(sprite);

  // 3. Boot the Phaser FX overlay into #fx, registering the KnockBox networking
  //    plugin when launched for multiplayer (platform ticket or ?kbLocal=tab).
  fx.init("fx", launchMode);

  // 3a. Route logs to the KnockBox server logger once the plugin is attached.
  //     The getter is resolved lazily per log call, so the plugin's async startup
  //     and solo mode (no plugin → undefined) are both handled transparently.
  attachKnockBoxSink(() => fx.knockbox()?.log);

  // 4. Hand the dictionary + settings to the app shell.
  const app = document.querySelector("ac-app") as AcApp;
  app.launchMode = launchMode;
  app.dict = dict;
  app.settings = loadSettings();
  fx.setShakeTarget(app);
  log.info("app shell mounted");

  // 5. Dismiss the loading screen.
  const bootEl = document.getElementById("boot");
  if (bootEl) {
    bootEl.classList.add("is-done");
    window.setTimeout(() => bootEl.remove(), 600);
  }

  if (import.meta.env.DEV) {
    (window as unknown as { __fx?: unknown; __app?: unknown }).__fx = fx;
    (window as unknown as { __fx?: unknown; __app?: unknown }).__app = app;
  }
}

/** Surface a fatal boot failure in the first-paint loading screen rather than
 *  leaving the user on a blank / forever-shimmering screen. */
function showBootFailure(): void {
  const bootEl = document.getElementById("boot");
  if (!bootEl) return;
  bootEl.classList.remove("is-done"); // keep it visible
  const sub = bootEl.querySelector(".boot-sub");
  if (sub) sub.textContent = "couldn't load — please reload";
  // Drop the indeterminate shimmer so it no longer implies progress is happening.
  bootEl.querySelector(".boot-bar")?.remove();
}

installGlobalErrorHandlers();
boot().catch((err: unknown) => {
  log.critical(`boot failed: ${String(err)}`, err);
  showBootFailure();
});
