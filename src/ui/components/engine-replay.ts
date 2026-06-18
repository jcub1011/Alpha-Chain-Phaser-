/*
 * Engine-replay walk for the score theater. The engine's mini-cards sit in an
 * overlapping fan on the LEFT and the running score on the RIGHT. The walk steps
 * left → right, lighting up each card in place (the existing `triggered` lift +
 * glow): as a card fires its point contribution pops off above it, a particle
 * burst plays, and the caller ramps the running total. Skipped cards still take a
 * beat but change nothing. Cards never move — the fan stays put and compresses to
 * fit, so the replay reads the same on mobile and desktop. The whole run is a
 * cancelable async sequencer — a new submission or phase change aborts it.
 */

import type { ScoreStep, Submission } from "../../game/types";
import { getCard } from "../../game/cards/library";
import { familyAccentColor, fmtScore } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";
import type { Rectish } from "../fx/fx";

export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Pop a contribution chip off the firing card — the point delta as the headline,
 *  the operator (×3 / +12 / FX) as a sub-label — floating up off the card and fading.
 *  Tied to the run's `signal`: aborting the walk (new submission / phase change) cancels
 *  and removes any chip still on screen, so they never linger into the next play. The
 *  hold duration scales with `stepMs` so fast (bot) pacing doesn't stack many long chips. */
function popChip(
  rect: Rectish,
  delta: number,
  op: string,
  color: string,
  stepMs: number,
  signal: AbortSignal,
): void {
  if (prefersReducedMotion() || signal.aborted) return;
  const headline = delta !== 0 ? `${delta > 0 ? "+" : ""}${fmtScore(delta)}` : op;
  // Only show the operator sub-label when it adds info (e.g. ×2 over a +54
  // headline); for additive cards the operator equals the delta, so skip it.
  const sub = delta !== 0 && op !== headline ? op : "";
  const el = document.createElement("div");
  el.className = "sr-chip";
  el.style.left = `${rect.left + rect.width / 2}px`;
  // Anchor at the card's top edge; the -100% Y in the keyframes lifts the chip
  // fully clear of the card (by its own height) so it reads ABOVE, not over it.
  el.style.top = `${rect.top}px`;
  el.style.color = color;
  el.innerHTML = `<span class="sr-chip-delta">${headline}</span>${
    sub ? `<span class="sr-chip-op">${sub}</span>` : ""
  }`;
  document.body.appendChild(el);
  // Hold long enough to read, but bounded by the step pacing so a fast walk doesn't
  // pile up many overlapping long-lived chips.
  const duration = Math.min(2200, Math.max(1000, stepMs * 3));
  const anim = el.animate(
    [
      { transform: "translate(-50%, calc(-100% + 2px)) scale(0.7)", opacity: 0, offset: 0 },
      { transform: "translate(-50%, calc(-100% - 10px)) scale(1.16)", opacity: 1, offset: 0.09 }, // pop in above card
      { transform: "translate(-50%, calc(-100% - 16px)) scale(1.0)", opacity: 1, offset: 0.8 }, // long hold (readable)
      { transform: "translate(-50%, calc(-100% - 48px)) scale(0.95)", opacity: 0, offset: 1 }, // float + fade
    ],
    { duration, easing: "cubic-bezier(0.2,0.8,0.2,1)" },
  );
  let backstop = 0;
  const cleanup = (): void => {
    window.clearTimeout(backstop);
    el.remove();
  };
  anim.onfinish = cleanup;
  // Backstop: if onfinish never fires (animation interrupted, node detached early),
  // force-remove shortly after the run would have ended so a chip can never linger
  // over the next play. el.remove() is idempotent, so racing onfinish is harmless.
  backstop = window.setTimeout(cleanup, duration + 400);
  // The walk is cancelable; if it aborts mid-flight, cancel the animation and pull
  // the chip rather than leaving it floating over the next submission's replay.
  signal.addEventListener(
    "abort",
    () => {
      anim.cancel();
      cleanup();
    },
    { once: true },
  );
}

/** A quick side-to-side wobble on a card that didn't activate, so a skip reads as a
 *  visible "nope" rather than only a gray-out. Plays on `.gc-flip` (where the lift /
 *  hover transforms live) and leaves no residual transform. */
function shakeCard(el: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const target = el.querySelector<HTMLElement>(".gc-flip") ?? el;
  target.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-4px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(-2px)" },
      { transform: "translateX(2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 360, easing: "ease-in-out" },
  );
}

export interface EngineReplayOpts {
  signal: AbortSignal;
  /** Per-step duration budget; controls the pacing of the walk. */
  stepMs: number;
  /** The fan element holding the engine's mini-cards (one `<ac-card>` per step). */
  fan: HTMLElement;
  /** Element to jolt on a big step (the scoring zone). Omit to skip the shake. */
  shakeTarget?: HTMLElement;
  /** Card `i` is now the active card — the caller lifts/glows it and raises it to
   *  the front. Returns once the highlight has rendered (so the rect is measurable). */
  onEnter: (index: number) => Promise<void> | void;
  /** Fired as a triggered card fires so callers can ramp their own running-score
   *  readout from prev → step. */
  onStep?: (step: ScoreStep, prevRunning: number, delta: number) => Promise<void> | void;
}

/** Walk the breakdown, lighting each card left → right in place. Returns once the
 *  last card has fired (the caller owns the taxed slam / final eruption). No-op
 *  under reduced motion — the caller settles the readout directly. */
export async function runEngineReplay(sub: Submission, opts: EngineReplayOpts): Promise<void> {
  if (prefersReducedMotion()) return;
  const { signal, stepMs, fan, shakeTarget, onEnter, onStep } = opts;
  const steps = sub.breakdown.steps;
  const total = Math.max(sub.breakdown.finalScore, sub.breakdown.finalBeforeTax, 1);
  let prev = sub.breakdown.seed;

  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) return;
    const step = steps[i];
    const def = getCard(step.cardId);
    const color = def ? `var(--ac-accent-${def.family})` : "var(--ac-accent-neutral)";
    const colorNum = familyAccentColor(def?.family ?? "neutral");

    // Light up the card and let the highlight render before we measure it.
    await onEnter(i);
    if (signal.aborted) return;

    if (step.triggered) {
      const card = fan.querySelectorAll<HTMLElement>("ac-card")[i];
      const at: Rectish = (card ?? fan).getBoundingClientRect();
      const delta = step.runningScore - prev;
      const intensity = Math.min(1, 0.3 + Math.abs(delta) / Math.max(40, total));
      popChip(at, delta, step.valueText, color, stepMs, signal);
      fx.burstAt(at, intensity, colorNum);
      if (shakeTarget && delta >= 60) fx.shake(Math.min(0.7, delta / 220), shakeTarget);
      // Ramp the score across the step rather than before it, so an activated card
      // takes the same wall-clock beat as a skipped one.
      await Promise.all([onStep?.(step, prev, delta), sleep(stepMs, signal)]);
      prev = step.runningScore;
    } else {
      // A skipped card still consumes a full step so the pacing stays uniform;
      // a small shake makes the non-activation read as a deliberate "nope".
      const card = fan.querySelectorAll<HTMLElement>("ac-card")[i];
      if (card) shakeCard(card);
      await sleep(stepMs, signal);
    }
  }
}
