/*
 * Responsive layout. With Scale.RESIZE the canvas matches the window, so scenes
 * compute their regions from the live size and reflow on resize. Two modes:
 *   - portrait (mobile / narrow): a single vertical column.
 *   - wide (desktop): left rail (standings) · center play column · right rail
 *     (recent words), with the engine bay as a full-width strip along the bottom.
 */

export const REGISTRY = {
  dict: "ac:dict",
  settings: "ac:settings",
  controller: "ac:controller",
} as const;

/** Fallback design size (used only before the real window size is known). */
export const DESIGN = { width: 720, height: 1280 } as const;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export interface GameLayout {
  mode: "portrait" | "wide";
  w: number;
  h: number;
  unit: number; // base scale unit for font/spacing (px)
  header: Region;
  center: Region; // clock, required letter, turn label, word input
  leftRail: Region; // standings
  rightRail: Region; // recent words
  bay: Region; // engine bay strip
}

const region = (x: number, y: number, w: number, h: number): Region => ({
  x,
  y,
  w,
  h,
  cx: x + w / 2,
  cy: y + h / 2,
});

export function isWide(w: number, h: number): boolean {
  return w >= 820 && w / h >= 1.05;
}

export function computeGameLayout(w: number, h: number): GameLayout {
  const margin = Math.round(Math.min(w, h) * 0.03) + 8;
  const headerH = Math.round(Math.max(56, Math.min(96, h * 0.075)));
  const header = region(0, 0, w, headerH);

  if (isWide(w, h)) {
    const unit = Math.min(w / 64, h / 40);
    const top = headerH + margin;
    const bayH = Math.round(Math.min(h * 0.26, 240));
    const bandH = h - top - bayH - margin * 2;
    const railW = Math.round(Math.min(380, (w - margin * 4) * 0.26));
    const gap = margin;
    const centerW = w - margin * 2 - railW * 2 - gap * 2;
    const leftRail = region(margin, top, railW, bandH);
    const center = region(margin + railW + gap, top, centerW, bandH);
    const rightRail = region(w - margin - railW, top, railW, bandH);
    const bay = region(margin, h - bayH - margin, w - margin * 2, bayH);
    return { mode: "wide", w, h, unit, header, center, leftRail, rightRail, bay };
  }

  // Portrait: a single centered column, regions stacked top→bottom.
  const colW = Math.min(w - margin * 2, 620);
  const colX = (w - colW) / 2;
  const unit = Math.min(colW / 26, h / 42);
  const bayH = Math.round(Math.min(h * 0.2, 240));
  const top = headerH;
  const avail = h - top - bayH;
  const centerH = Math.round(avail * 0.46);
  const rightH = Math.round(avail * 0.29);
  const leftH = avail - centerH - rightH;
  const center = region(colX, top, colW, centerH);
  const rightRail = region(colX, top + centerH, colW, rightH);
  const leftRail = region(colX, top + centerH + rightH, colW, leftH);
  const bay = region(colX, h - bayH, colW, bayH);
  return { mode: "portrait", w, h, unit, header, center, leftRail, rightRail, bay };
}
