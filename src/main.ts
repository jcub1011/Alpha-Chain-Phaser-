/*
 * Bootstrap. Loads the bundled lexicon + card sprite, mounts the DOM UI, and
 * boots the Phaser FX overlay. No Phaser scenes drive gameplay any more — the
 * game loop runs from <ac-app>, and the FX canvas is purely decorative.
 */

import "./styles/index.css";
import { Dictionary } from "./game/dictionary";
import { DEFAULT_SETTINGS } from "./game/settings";
import { detectLaunch } from "./net/launch";
import { fx } from "./ui/fx/fx";
// Side-effect import registers <ac-app>; the type import is erased at build.
import "./ui/app/ac-app";
import type { AcApp } from "./ui/app/ac-app";

async function boot(): Promise<void> {
  // 0. Resolve the launch mode ONCE, up front. The KnockBox plugin scrubs the
  //    ticket out of location.hash the moment it starts, so detectLaunch() is only
  //    reliable before the Phaser game boots — capture it here and thread it down.
  const launchMode = detectLaunch();

  // 1. Lexicon (the large download) + card icon sprite, in parallel.
  const [wordsRes, spriteRes] = await Promise.all([
    fetch("assets/words.txt"),
    fetch("assets/cards.svg"),
  ]);
  const [wordsText, spriteText] = await Promise.all([wordsRes.text(), spriteRes.text()]);

  const dict = new Dictionary(
    wordsText
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0),
  );

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

  // 4. Hand the dictionary + settings to the app shell.
  const app = document.querySelector("ac-app") as AcApp;
  app.launchMode = launchMode;
  app.dict = dict;
  app.settings = { ...DEFAULT_SETTINGS };
  fx.setShakeTarget(app);

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

void boot();
