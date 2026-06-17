/*
 * EngineEffects.bankSiphon — the shared bank-and-announce helper behind the
 * reactive economy cards (Tax Collector / Toll Booth / Chrono Syphon). It must
 * push both a siphon (for the leaderboard credit) and a named notice (for the
 * score-replay attribution), and stay inert on a non-positive amount.
 */

import { describe, expect, it } from "vitest";
import { EngineEffects, type RoomServices, type EngineEffectsDeps } from "./roomServices";

const stubDeps: EngineEffectsDeps = {
  cardsOf: () => [],
  activePlayers: () => [],
  leaderId: () => "",
  armedClockOf: () => 0,
};

const makeEffects = (): EngineEffects => new EngineEffects({} as RoomServices, stubDeps);

describe("EngineEffects.bankSiphon", () => {
  it("records both a siphon and a named notice", () => {
    const fx = makeEffects();
    fx.bankSiphon("p1", 6, "Chrono Syphon");
    expect(fx.takeSiphons()).toEqual([{ playerId: "p1", amount: 6 }]);
    expect(fx.takeNotices()).toEqual([
      { source: "Chrono Syphon", targetId: "p1", text: "+6 banked", amount: 6 },
    ]);
  });

  it("is a no-op for a non-positive amount", () => {
    const fx = makeEffects();
    fx.bankSiphon("p1", 0, "The Toll Booth");
    fx.bankSiphon("p1", -3, "The Toll Booth");
    expect(fx.takeSiphons()).toEqual([]);
    expect(fx.takeNotices()).toEqual([]);
  });
});
