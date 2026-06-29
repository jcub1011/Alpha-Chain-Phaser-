import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availableBanLetters,
  DEFAULT_SETTINGS,
  legalBanLetters,
  loadSettings,
  modifierSlotsForCardEra,
  saveSettings,
} from "./settings";

// The test environment is "node" (no DOM), so stand up a minimal in-memory
// localStorage for the persistence helpers to talk to.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

const KEY = "alphachain.settings";
// Mirrors the (unexported) SETTINGS_VERSION; corruption cases set it so they test the
// per-field validators rather than tripping the version gate. Keep in sync.
const VERSION = 3;

function setGlobalStorage(s: Storage | undefined): void {
  (globalThis as unknown as { localStorage?: Storage }).localStorage = s as Storage;
}
function storeRaw(raw: string): void {
  globalThis.localStorage.setItem(KEY, raw);
}
function storeObj(obj: unknown): void {
  storeRaw(JSON.stringify(obj));
}

describe("settings persistence", () => {
  beforeEach(() => setGlobalStorage(new MemoryStorage() as unknown as Storage));
  afterEach(() => setGlobalStorage(undefined));

  it("returns a fresh copy of the defaults when nothing is persisted", () => {
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).not.toBe(DEFAULT_SETTINGS); // a copy, never the shared default object
  });

  it("falls back to defaults on malformed JSON", () => {
    storeRaw("{ not valid json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("discards a blob written under a different schema version", () => {
    storeObj({ version: 999, banMode: "VowelsOnly", shotClockSeconds: 55 });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("discards a blob with no version field", () => {
    storeObj({ banMode: "VowelsOnly" });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the default for an invalid enum value", () => {
    storeObj({ version: VERSION, ...DEFAULT_SETTINGS, banMode: "garbage" });
    expect(loadSettings().banMode).toBe(DEFAULT_SETTINGS.banMode);
  });

  it("keeps the default for an out-of-range or wrong-typed number", () => {
    storeObj({
      version: VERSION,
      ...DEFAULT_SETTINGS,
      shotClockSeconds: -5, // below MIN
      botCount: 99, // above max
      eraCount: "4", // right value, wrong type
    });
    const s = loadSettings();
    expect(s.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
    expect(s.botCount).toBe(DEFAULT_SETTINGS.botCount);
    expect(s.eraCount).toBe(DEFAULT_SETTINGS.eraCount);
  });

  it("keeps the default for a non-finite number (NaN serializes to null)", () => {
    storeObj({ version: VERSION, ...DEFAULT_SETTINGS, shotClockSeconds: NaN });
    expect(loadSettings().shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds);
  });

  it("fills missing keys from the defaults (forward-compatible)", () => {
    storeObj({ version: VERSION, banMode: "VowelsOnly" });
    const s = loadSettings();
    expect(s.banMode).toBe("VowelsOnly"); // the one stored key
    expect(s.shotClockSeconds).toBe(DEFAULT_SETTINGS.shotClockSeconds); // the rest default
  });

  it("loads valid stored values", () => {
    storeObj({
      version: VERSION,
      ...DEFAULT_SETTINGS,
      shotClockSeconds: 30,
      botDifficulty: "hard",
    });
    const s = loadSettings();
    expect(s.shotClockSeconds).toBe(30);
    expect(s.botDifficulty).toBe("hard");
  });

  it("round-trips a saved settings object and stamps the schema version", () => {
    saveSettings({ ...DEFAULT_SETTINGS, shotClockSeconds: 45, banMode: "ConsonantsOnly" });
    const persisted = JSON.parse(globalThis.localStorage.getItem(KEY) as string);
    expect(persisted.version).toBe(VERSION);

    const s = loadSettings();
    expect(s.shotClockSeconds).toBe(45);
    expect(s.banMode).toBe("ConsonantsOnly");
  });

  it("falls back to defaults when storage access throws", () => {
    setGlobalStorage({
      getItem: () => {
        throw new Error("SecurityError: storage disabled");
      },
    } as unknown as Storage);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("availableBanLetters — ban-repeat rule", () => {
  it("AllowRepeat returns every legal letter regardless of history", () => {
    expect(availableBanLetters("All", "AllowRepeat", ["a", "b"])).toEqual(legalBanLetters("All"));
  });

  it("an empty history always returns the full legal pool", () => {
    expect(availableBanLetters("ConsonantsOnly", "NoRepeat", [])).toEqual(
      legalBanLetters("ConsonantsOnly"),
    );
  });

  it("NoConsecutive excludes only the most recent ban", () => {
    const r = availableBanLetters("All", "NoConsecutive", ["a", "b"]);
    expect(r).toContain("a"); // older bans are fair game again
    expect(r).not.toContain("b"); // last era's ban is off-limits
    expect(r).toHaveLength(25);
  });

  it("NoRepeat excludes every previously banned letter", () => {
    const r = availableBanLetters("All", "NoRepeat", ["a", "b", "c"]);
    expect(r).not.toContain("a");
    expect(r).not.toContain("b");
    expect(r).not.toContain("c");
    expect(r).toHaveLength(23);
  });

  it("resets the exclusion set when NoRepeat exhausts the legal pool", () => {
    const vowels = legalBanLetters("VowelsOnly"); // a e i o u
    // Every vowel already banned → excluding all would leave nothing, so reset.
    expect(availableBanLetters("VowelsOnly", "NoRepeat", vowels)).toEqual(vowels);
  });
});

describe("modifierSlotsForCardEra — engine bay slot growth", () => {
  const settings = (over: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, ...over });

  it("grows by the default +1 every era from the start value", () => {
    const s = settings({
      modifierSlotsStart: 3,
      slotIncreaseEveryNEras: 1,
      slotIncreaseAmount: 1,
      modifierSlotsMax: 99,
    });
    expect([1, 2, 3, 4].map((c) => modifierSlotsForCardEra(s, c))).toEqual([3, 4, 5, 6]);
  });

  it("stays flat at the start value when the frequency is 0 (never)", () => {
    const s = settings({ modifierSlotsStart: 4, slotIncreaseEveryNEras: 0, modifierSlotsMax: 99 });
    expect([1, 5, 20].map((c) => modifierSlotsForCardEra(s, c))).toEqual([4, 4, 4]);
  });

  it("increases only every N eras", () => {
    const s = settings({
      modifierSlotsStart: 3,
      slotIncreaseEveryNEras: 2,
      slotIncreaseAmount: 1,
      modifierSlotsMax: 99,
    });
    // card-eras 1,2 → 3; 3,4 → 4; 5,6 → 5
    expect([1, 2, 3, 4, 5, 6].map((c) => modifierSlotsForCardEra(s, c))).toEqual([
      3, 3, 4, 4, 5, 5,
    ]);
  });

  it("applies the per-increase amount", () => {
    const s = settings({
      modifierSlotsStart: 3,
      slotIncreaseEveryNEras: 1,
      slotIncreaseAmount: 2,
      modifierSlotsMax: 99,
    });
    expect([1, 2, 3].map((c) => modifierSlotsForCardEra(s, c))).toEqual([3, 5, 7]);
  });

  it("clamps at the maximum cap", () => {
    const s = settings({
      modifierSlotsStart: 3,
      slotIncreaseEveryNEras: 1,
      slotIncreaseAmount: 1,
      modifierSlotsMax: 5,
    });
    expect([1, 2, 3, 4, 10].map((c) => modifierSlotsForCardEra(s, c))).toEqual([3, 4, 5, 5, 5]);
  });
});
