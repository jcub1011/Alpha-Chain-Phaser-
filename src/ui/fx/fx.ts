/*
 * The FX facade. Components never touch Phaser — they call this small imperative
 * API. Effects that belong on the canvas (particles, confetti) forward to the
 * FxScene; screen-shake is applied to the DOM app root (the canvas is a separate
 * layer, so shaking the camera wouldn't move the UI). This interface is the swap
 * boundary: the whole Phaser layer could be replaced behind it.
 */

import Phaser from "phaser";
import { COLORS, prefersReducedMotion } from "../../theme";
import type { LaunchMode } from "../../net/launch";
import { knockboxPluginConfig } from "../../net/knockboxPlugin";
import type { NetPeer } from "../../net/knockBoxController";
import { FxScene } from "./FxScene";

export interface Rectish {
  left: number;
  top: number;
  width: number;
  height: number;
}

class Fx {
  private game?: Phaser.Game;
  private scene?: FxScene;
  private shakeTarget?: HTMLElement;

  /** Boot the Phaser FX game into the given parent element. The KnockBox global
   *  plugin (real or local-tab) is registered here when launched for multiplayer;
   *  in solo mode no plugin is added. */
  init(parentId: string, mode: LaunchMode = "solo"): void {
    if (this.game) return;
    const net = knockboxPluginConfig(mode);
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: parentId,
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      scene: [FxScene],
      ...(net ? { plugins: { global: [net] } } : {}),
      // The canvas must never eat pointer events; the wrapper handles that too.
      input: { mouse: { preventDefaultWheel: false } },
      fps: { target: 60 },
    });
    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.scene = this.game!.scene.getScene("Fx") as FxScene;
    });
  }

  /** The KnockBox networking peer (the registered global plugin), if any. */
  knockbox(): NetPeer | undefined {
    const plugins = this.game?.plugins as unknown as
      | { get(key: string): unknown }
      | undefined;
    return (plugins?.get("KnockBox") as NetPeer | undefined) ?? undefined;
  }

  /** Element whose transform is nudged for screen-shake (the UI root). */
  setShakeTarget(el: HTMLElement): void {
    this.shakeTarget = el;
  }

  private center(r: Rectish): [number, number] {
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** Particle burst centered on a screen point or DOM rect. intensity 0..1. */
  burstAt(target: Rectish | [number, number], intensity = 0.5, color: number = COLORS.cyan): void {
    if (!this.scene || prefersReducedMotion()) return;
    const [x, y] = Array.isArray(target) ? target : this.center(target);
    this.scene.burstAt(x, y, intensity, color);
  }

  /** Big celebratory burst for a final/large score. */
  eruption(target: Rectish | [number, number], intensity = 1): void {
    if (!this.scene || prefersReducedMotion()) return;
    const [x, y] = Array.isArray(target) ? target : this.center(target);
    this.scene.eruption(x, y, intensity);
  }

  /** Full-screen confetti rain — reserved for the game-over win celebration. */
  confetti(durationMs?: number): void {
    if (!this.scene || prefersReducedMotion()) return;
    this.scene.confetti(durationMs);
  }

  /** Confetti chips exploding outward from a point or DOM rect (the scoring
   *  engine), then tumbling down — not a full-screen rain. intensity 0..1. */
  confettiAt(target: Rectish | [number, number], intensity = 1): void {
    if (!this.scene || prefersReducedMotion()) return;
    const [x, y] = Array.isArray(target) ? target : this.center(target);
    this.scene.confettiBurst(x, y, intensity);
  }

  /** Shake an element. intensity 0..1. Defaults to the UI root, but callers
   *  pass a specific element (e.g. the scoring-engine theater) so only that
   *  region jolts. Softer range than a full-screen jolt. */
  shake(intensity = 0.5, target?: HTMLElement): void {
    const el = target ?? this.shakeTarget;
    if (!el || prefersReducedMotion()) return;
    const px = Math.round(2 + intensity * 7);
    el.style.setProperty("--shake", `${px}px`);
    el.classList.remove("is-shaking");
    // Force reflow so the animation can restart if shakes stack.
    void el.offsetWidth;
    el.classList.add("is-shaking");
    window.setTimeout(() => el.classList.remove("is-shaking"), 420);
  }
}

/** Singleton FX facade shared by every component. */
export const fx = new Fx();
