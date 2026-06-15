/*
 * The FX facade. Components never touch Phaser — they call this small imperative
 * API. Effects that belong on the canvas (particles, confetti) forward to the
 * FxScene; screen-shake is applied to the DOM app root (the canvas is a separate
 * layer, so shaking the camera wouldn't move the UI). This interface is the swap
 * boundary: the whole Phaser layer could be replaced behind it.
 */

import Phaser from "phaser";
import { COLORS, prefersReducedMotion } from "../../theme";
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

  /** Boot the Phaser FX game into the given parent element. */
  init(parentId: string): void {
    if (this.game) return;
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: parentId,
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      scene: [FxScene],
      // The canvas must never eat pointer events; the wrapper handles that too.
      input: { mouse: { preventDefaultWheel: false } },
      fps: { target: 60 },
    });
    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.scene = this.game!.scene.getScene("Fx") as FxScene;
    });
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

  confetti(durationMs?: number): void {
    if (!this.scene || prefersReducedMotion()) return;
    this.scene.confetti(durationMs);
  }

  /** Screen-shake the UI root. intensity 0..1. */
  shake(intensity = 0.5): void {
    const el = this.shakeTarget;
    if (!el || prefersReducedMotion()) return;
    const px = Math.round(3 + intensity * 12);
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
