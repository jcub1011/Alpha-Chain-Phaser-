import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachKnockBoxSink, createLogger, type KnockBoxLogger } from "./log";

/** A spyable fake of the KnockBox server logger. */
function fakeKbLogger(): KnockBoxLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

describe("createLogger", () => {
  beforeEach(() => {
    // Reset the module-level KnockBox sink to absent before each test.
    attachKnockBoxSink(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes the message with the category", () => {
    createLogger("net").info("connected");
    expect(console.info).toHaveBeenCalledWith("[net] connected");
  });

  it("maps each level to the right console method", () => {
    const log = createLogger("x");
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.critical("c");

    expect(console.debug).toHaveBeenCalledWith("[x] t");
    expect(console.debug).toHaveBeenCalledWith("[x] d");
    expect(console.info).toHaveBeenCalledWith("[x] i");
    expect(console.warn).toHaveBeenCalledWith("[x] w");
    expect(console.error).toHaveBeenCalledWith("[x] e");
    expect(console.error).toHaveBeenCalledWith("[x] c"); // critical → console.error
  });

  it("forwards detail args to the console", () => {
    const payload = { id: 7 };
    createLogger("match").debug("submission", payload);
    expect(console.debug).toHaveBeenCalledWith("[match] submission", payload);
  });

  it("fans out to the KnockBox sink with the prefixed message only (no detail)", () => {
    const kb = fakeKbLogger();
    attachKnockBoxSink(() => kb);

    createLogger("net").warn("retrying", { attempt: 2 });

    expect(kb.warn).toHaveBeenCalledTimes(1);
    expect(kb.warn).toHaveBeenCalledWith("[net] retrying"); // detail not shipped
  });

  it("routes each level to the matching KnockBox method", () => {
    const kb = fakeKbLogger();
    attachKnockBoxSink(() => kb);
    const log = createLogger("y");
    log.trace("t");
    log.critical("c");
    expect(kb.trace).toHaveBeenCalledWith("[y] t");
    expect(kb.critical).toHaveBeenCalledWith("[y] c");
  });

  it("is a no-op for the KnockBox sink when none is attached (solo / pre-ready)", () => {
    // No sink attached (reset to undefined in beforeEach) — must not throw.
    expect(() => createLogger("solo").info("hello")).not.toThrow();
  });

  it("never lets a failing KnockBox sink break the caller", () => {
    attachKnockBoxSink(() => {
      const broken = fakeKbLogger();
      broken.error = vi.fn(() => {
        throw new Error("socket gone");
      });
      return broken;
    });
    expect(() => createLogger("net").error("boom")).not.toThrow();
  });
});
