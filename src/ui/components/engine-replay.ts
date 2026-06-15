/*
 * Shared engine-replay walk. Animates a score breakdown left → right over the
 * real <ac-card> elements inside a bay: each triggered card lifts and bursts and
 * pops a value chip showing its actual point contribution; skipped cards dim.
 * Both the human spotlight (<ac-score-replay>) and each opponent bay
 * (<ac-engine-bay live>) drive this; callers layer their own number readout via
 * the onStep hook and handle the taxed slam / final flourish themselves.
 */

import type { ScoreStep, Submission } from "../../game/types";
import { getCard } from "../../game/cards/library";
import { familyAccentColor, fmtScore } from "../app/util";
import { prefersReducedMotion } from "../../theme";
import { fx } from "../fx/fx";

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

/** The <ac-card> elements inside a bay (or `.bay-slots`) element, in order. */
export const bayCards = (bayEl: Element): HTMLElement[] =>
  Array.from(bayEl.querySelectorAll("ac-card"));

/** Clear any triggered/dimmed replay states left on a bay's cards. */
export function resetBayCards(bayEl: Element): void {
  for (const c of bayEl.querySelectorAll("ac-card")) {
    c.removeAttribute("triggered");
    c.removeAttribute("dimmed");
  }
}

/** Pop a contribution chip off a card's center — the point delta as the headline,
 *  the operator (×3 / +12 / FX) as a sub-label — floating up and fading. */
function popChip(rect: DOMRect, delta: number, op: string, color: string, compact: boolean): void {
  if (prefersReducedMotion()) return;
  const headline = delta !== 0 ? `${delta > 0 ? "+" : ""}${fmtScore(delta)}` : op;
  // Only show the operator sub-label when it adds info (e.g. ×2 over a +54
  // headline); for additive cards the operator equals the delta, so skip it.
  const sub = delta !== 0 && op !== headline ? op : "";
  const el = document.createElement("div");
  el.className = `sr-chip${compact ? " is-compact" : ""}`;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top + rect.height * 0.3}px`;
  el.style.color = color;
  el.innerHTML = `<span class="sr-chip-delta">${headline}</span>${
    sub ? `<span class="sr-chip-op">${sub}</span>` : ""
  }`;
  document.body.appendChild(el);
  const anim = el.animate(
    [
      { transform: "translate(-50%, 0) scale(0.6)", opacity: 0 },
      { transform: "translate(-50%, -10px) scale(1.12)", opacity: 1, offset: 0.25 },
      { transform: "translate(-50%, -46px) scale(1)", opacity: 0 },
    ],
    { duration: compact ? 760 : 900, easing: "cubic-bezier(0.2,0.8,0.2,1)" },
  );
  anim.onfinish = () => el.remove();
}

export interface EngineReplayOpts {
  signal: AbortSignal;
  /** Per-step duration budget; controls the pacing of the walk. */
  stepMs: number;
  /** Compact opponent bays use lighter particle bursts and faster chips. */
  compact?: boolean;
  /** Fired on each triggered step (after the chip/burst, before the rest beat)
   *  so callers can ramp their own running-score readout from prev → step. */
  onStep?: (step: ScoreStep, prevRunning: number, delta: number) => Promise<void> | void;
}

/** Walk the breakdown over `bayEl`'s cards. Returns once the walk finishes (the
 *  caller owns the taxed slam / final eruption). No-op under reduced motion. */
export async function runEngineReplay(
  bayEl: Element,
  sub: Submission,
  opts: EngineReplayOpts,
): Promise<void> {
  if (prefersReducedMotion()) return;
  const { signal, stepMs, compact = false, onStep } = opts;
  const cards = bayCards(bayEl);
  const steps = sub.breakdown.steps;
  const total = Math.max(sub.breakdown.finalScore, sub.breakdown.finalBeforeTax, 1);
  let prev = sub.breakdown.seed;

  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) return;
    const step = steps[i];
    const card = cards[i];
    const def = getCard(step.cardId);
    const color = def ? `var(--ac-accent-${def.family})` : "var(--ac-accent-neutral)";
    const colorNum = familyAccentColor(def?.family ?? "neutral");

    if (!step.triggered) {
      card?.setAttribute("dimmed", "");
      await sleep(stepMs * 0.5, signal);
      continue;
    }

    card?.setAttribute("triggered", "");
    const rect = card?.getBoundingClientRect();
    const delta = step.runningScore - prev;
    const intensity = Math.min(1, 0.3 + Math.abs(delta) / Math.max(40, total));
    if (rect) {
      popChip(rect, delta, step.valueText, color, compact);
      fx.burstAt(rect, intensity * (compact ? 0.6 : 1), colorNum);
    }
    if (!compact && delta >= 60) fx.shake(Math.min(1, delta / 200));
    await onStep?.(step, prev, delta);
    prev = step.runningScore;
    await sleep(stepMs * 0.3, signal);
    card?.removeAttribute("triggered");
  }
}
