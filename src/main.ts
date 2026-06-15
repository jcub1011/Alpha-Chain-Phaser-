import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { LobbyScene } from "./scenes/LobbyScene";
import { GameScene } from "./scenes/GameScene";
import { IntermissionScene } from "./scenes/IntermissionScene";
import { GameOverScene } from "./scenes/GameOverScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#06080f",
  scale: {
    // RESIZE: the canvas exactly fills the parent (viewport) — no scaling, no
    // centering, no letterbox. gameSize is in CSS pixels so displayScale = 1 and
    // pointer input maps 1:1 to game coordinates (bulletproof click alignment).
    // The layout reflows between portrait (mobile) and wide (desktop).
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  dom: { createContainer: true },
  render: { antialias: true },
  scene: [BootScene, LobbyScene, GameScene, IntermissionScene, GameOverScene],
};

const game = new Phaser.Game(config);
if (import.meta.env.DEV) (window as unknown as { __game?: unknown }).__game = game;
