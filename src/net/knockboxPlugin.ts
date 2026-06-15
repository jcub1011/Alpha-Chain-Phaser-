/*
 * Bridges the shipped KnockBox addon (UMD .js, no ESM exports) into the typed
 * app. The UMD files have no importable exports, so we run them as SIDE EFFECTS:
 * in the browser their global branch assigns the classes onto `globalThis`
 * (KnockBoxPlugin / KnockBoxLocalPlugin), reading `globalThis.Phaser` + the
 * KnockBoxCore global. `./phaserGlobal` must be imported first so Phaser is on
 * the global before the addon wrappers evaluate.
 *
 * The real KnockBoxPlugin opens a WebSocket from the URL ticket; the
 * KnockBoxLocalPlugin is a no-server multi-tab drop-in with the identical API.
 */

import "./phaserGlobal";
// @ts-ignore — UMD side-effect module (sets globalThis.KnockBoxCore).
import "../../addons/knockbox/kb-core.js";
// @ts-ignore — UMD side-effect module (sets globalThis.KnockBoxPlugin).
import "../../addons/knockbox/knockbox-plugin.js";
// @ts-ignore — UMD side-effect module (sets globalThis.KnockBoxLocalPlugin / Peer).
import "../../addons/knockbox/knockbox-local.js";
import type { LaunchMode } from "./launch";

interface KnockBoxGlobals {
  KnockBoxPlugin?: unknown;
  KnockBoxLocalPlugin?: unknown;
}

/** Phaser global-plugin config for the launch mode (null in solo mode). */
export function knockboxPluginConfig(mode: LaunchMode): Record<string, unknown> | null {
  if (mode === "solo") return null;
  const g = globalThis as unknown as KnockBoxGlobals;
  const plugin = mode === "local-tab" ? g.KnockBoxLocalPlugin : g.KnockBoxPlugin;
  if (!plugin) return null;
  const data = mode === "local-tab" ? { mode: "tab" } : undefined;
  return { key: "KnockBox", plugin, start: true, mapping: "knockbox", data };
}
