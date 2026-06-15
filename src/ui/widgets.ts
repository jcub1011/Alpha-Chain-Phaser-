/*
 * Shared neon-noir UI primitives: panels with the house hard-shadow + glow,
 * neon text, and pill buttons with juicy press animations. Built on Phaser
 * Graphics/Text so they scale crisply with Scale.FIT.
 */

import Phaser from "phaser";
import { COLORS, CSS, FONTS, prefersReducedMotion } from "../theme";

export interface PanelOptions {
  fill?: number;
  fillAlpha?: number;
  border?: number;
  borderAlpha?: number;
  borderWidth?: number;
  radius?: number;
  shadow?: boolean;
  shadowOffset?: number;
  glow?: number; // accent color to glow with (0 = none)
}

/** Draw a rounded panel with the hard black drop shadow into a Graphics object. */
export function drawPanel(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  o: PanelOptions = {},
): void {
  const {
    fill = COLORS.panelSolid,
    fillAlpha = 0.92,
    border = COLORS.cyan,
    borderAlpha = 0.5,
    borderWidth = 2,
    radius = 14,
    shadow = true,
    shadowOffset = 6,
  } = o;
  g.clear();
  if (shadow) {
    g.fillStyle(0x000000, 1);
    g.fillRoundedRect(x + shadowOffset, y + shadowOffset, w, h, radius);
  }
  g.fillStyle(fill, fillAlpha);
  g.fillRoundedRect(x, y, w, h, radius);
  if (borderWidth > 0) {
    g.lineStyle(borderWidth, border, borderAlpha);
    g.strokeRoundedRect(x, y, w, h, radius);
  }
}

/** A reusable panel as its own Graphics game object, top-left anchored. */
export function panel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  o: PanelOptions = {},
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  drawPanel(g, x, y, w, h, o);
  return g;
}

export interface TextOptions {
  size?: number;
  color?: string;
  font?: string;
  weight?: "400" | "600" | "700" | "800";
  align?: "left" | "center" | "right";
  glow?: string; // shadow color for a soft glow
  glowBlur?: number;
}

export function neonText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  o: TextOptions = {},
): Phaser.GameObjects.Text {
  const {
    size = 24,
    color = CSS.ink,
    font = FONTS.display,
    weight = "700",
    align = "left",
    glow,
    glowBlur = 12,
  } = o;
  const t = scene.add.text(x, y, text, {
    fontFamily: font,
    fontSize: `${size}px`,
    color,
    fontStyle: weight === "400" ? "normal" : "bold",
    align,
  });
  if (glow) t.setShadow(0, 0, glow, glowBlur, true, true);
  return t;
}

/** A pill button with hover/press scale + glow. Returns the container. */
export function pillButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  onClick: () => void,
  accent: number = COLORS.cyan,
): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  const g = scene.add.graphics();
  const draw = (pressed: boolean) => {
    g.clear();
    g.fillStyle(0x000000, 1);
    g.fillRoundedRect(-w / 2 + 5, -h / 2 + 5, w, h, h / 2);
    g.fillStyle(accent, pressed ? 0.85 : 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  };
  draw(false);
  // Pick legible text: dark on bright accents, light on dark accents.
  const col = Phaser.Display.Color.IntegerToColor(accent);
  const luma = (col.red * 0.299 + col.green * 0.587 + col.blue * 0.114) / 255;
  const txt = scene.add
    .text(0, 0, label, {
      fontFamily: FONTS.display,
      fontSize: `${Math.round(h * 0.46)}px`,
      color: luma > 0.5 ? "#06080f" : CSS.ink,
      fontStyle: "bold",
    })
    .setOrigin(0.5);
  c.add([g, txt]);
  c.setSize(w, h);
  c.setInteractive(
    new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
    Phaser.Geom.Rectangle.Contains,
  );
  c.on("pointerover", () => {
    if (!prefersReducedMotion()) scene.tweens.add({ targets: c, scale: 1.04, duration: 120 });
  });
  c.on("pointerout", () => {
    scene.tweens.add({ targets: c, scale: 1, duration: 120 });
    draw(false);
  });
  c.on("pointerdown", () => {
    draw(true);
    scene.tweens.add({ targets: c, scale: 0.95, duration: 70, yoyo: true });
  });
  c.on("pointerup", () => {
    draw(false);
    onClick();
  });
  return c;
}

/** Apply a soft glow to a Graphics/Image via post-FX when supported. */
export function addGlow(obj: Phaser.GameObjects.GameObject, color: number, strength = 4): void {
  const withFx = obj as unknown as {
    preFX?: { addGlow: (c?: number, o?: number, i?: number) => unknown };
  };
  try {
    withFx.preFX?.addGlow(color, strength, 0);
  } catch {
    /* glow FX unsupported on this renderer — non-fatal */
  }
}
