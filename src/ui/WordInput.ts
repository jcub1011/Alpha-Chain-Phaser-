/*
 * The word-input box: a real DOM <input> (styled in index.html) overlaid via
 * Phaser's DOM layer so the mobile on-screen keyboard works. Submits on Enter.
 * Supports the Blindfold card (hide own glyphs) and a shake on rejection.
 */

import Phaser from "phaser";

export class WordInput {
  readonly el: HTMLInputElement;
  readonly dom: Phaser.GameObjects.DOMElement;
  private readonly scene: Phaser.Scene;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    onSubmit: (value: string) => void,
  ) {
    this.scene = scene;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ac-word-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("enterkeyhint", "send");
    input.placeholder = "type a word…";
    input.style.width = `${width}px`;
    input.style.height = `${height}px`;
    input.style.fontSize = `${Math.round(height * 0.42)}px`;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit(input.value);
      }
    });
    this.el = input;
    this.dom = scene.add.dom(x, y, input).setOrigin(0.5);
  }

  setVisible(v: boolean): void {
    this.dom.setVisible(v);
    this.el.disabled = !v;
  }

  clear(): void {
    this.el.value = "";
  }

  focus(): void {
    // Defer so the element is laid out before focusing (helps mobile).
    setTimeout(() => this.el.focus(), 30);
  }

  setBlindfold(on: boolean): void {
    this.el.classList.toggle("ac-blindfold", on);
  }

  setBorderColor(css: string): void {
    this.el.style.borderColor = css;
    this.el.style.boxShadow = `0 0 18px ${css}66, 5px 5px 0 #000`;
    this.el.style.caretColor = css;
  }

  shake(): void {
    this.scene.tweens.add({
      targets: this.dom,
      x: this.dom.x + 10,
      duration: 60,
      yoyo: true,
      repeat: 3,
      ease: "Sine.easeInOut",
    });
  }

  destroy(): void {
    this.dom.destroy();
  }
}
