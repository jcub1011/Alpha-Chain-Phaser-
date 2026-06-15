/*
 * Bakes the card icons from the original sprite (public/assets/cards.svg, whose
 * <symbol> ids equal the card ids) into individual white-stroke Phaser textures
 * keyed `icon:<id>`. They're rendered white so the Card widget can setTint() to
 * the card's family accent.
 */

import Phaser from "phaser";

export const iconKey = (id: string): string => `icon:${id}`;

/** Load + register a texture for every symbol in the sprite. Resolves when done. */
export async function bakeCardIcons(
  scene: Phaser.Scene,
  svgText: string,
  size = 112,
): Promise<void> {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const symbols = Array.from(doc.querySelectorAll("symbol"));
  await Promise.all(
    symbols.map((sym) => {
      const id = sym.getAttribute("id");
      if (!id) return Promise.resolve();
      const vb = sym.getAttribute("viewBox") ?? "0 0 24 24";
      const standalone =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" ` +
        `fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" ` +
        `stroke-linejoin="round">${sym.innerHTML}</svg>`;
      const uri = "data:image/svg+xml;base64," + btoa(standalone);
      return loadTexture(scene, iconKey(id), uri);
    }),
  );
}

function loadTexture(scene: Phaser.Scene, key: string, uri: string): Promise<void> {
  return new Promise((resolve) => {
    if (scene.textures.exists(key)) return resolve();
    const img = new Image();
    img.onload = () => {
      if (!scene.textures.exists(key)) scene.textures.addImage(key, img);
      resolve();
    };
    img.onerror = () => resolve(); // missing icon is non-fatal; Card falls back
    img.src = uri;
  });
}
