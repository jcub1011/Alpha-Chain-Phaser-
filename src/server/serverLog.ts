/*
 * Sandbox-safe replacement for src/log.ts, used ONLY inside the server authority
 * bundle. The authority build aliases every `../log` import to this module (see
 * vite.authority.config.ts) so the rules layer (src/game/*) can keep calling
 * `createLogger(...)` unchanged while running under Jint — which has no
 * `console`, no `import.meta.env`, and no ambient `Date`.
 *
 * Lines route to the injected `kb.log` (info/warn/error/debug only). The sink is
 * resolved lazily through a module-level ref that createAuthority(kb) sets once,
 * because src/game modules call `createLogger(...)` at import time — before `kb`
 * exists. Until then (and if kb.log is absent) logging is a silent no-op. `detail`
 * args are dropped: they may hold PII (player names, words) and never leave the box.
 */

/** The subset of kb.log the sandbox exposes (mirror of the server capability). */
export interface KbLog {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

export interface Logger {
  trace(message: string, ...detail: unknown[]): void;
  debug(message: string, ...detail: unknown[]): void;
  info(message: string, ...detail: unknown[]): void;
  warn(message: string, ...detail: unknown[]): void;
  error(message: string, ...detail: unknown[]): void;
  critical(message: string, ...detail: unknown[]): void;
}

let sink: KbLog | null = null;

/** Point the logger at kb.log. Called once from createAuthority(kb). */
export function setLogSink(kbLog: KbLog | null | undefined): void {
  sink = kbLog ?? null;
}

/** trace/critical fold onto debug/error (kb.log has no such levels). */
function emit(level: "debug" | "info" | "warn" | "error", category: string, message: string): void {
  const fn = sink?.[level];
  if (!fn) return;
  try {
    fn(`[${category}] ${message}`);
  } catch {
    // Logging must never break the authority (a CLR throw would be fatal); drop it.
  }
}

/** Category-scoped logger, drop-in for src/log.ts's createLogger. */
export function createLogger(category: string): Logger {
  return {
    trace: (m) => emit("debug", category, m),
    debug: (m) => emit("debug", category, m),
    info: (m) => emit("info", category, m),
    warn: (m) => emit("warn", category, m),
    error: (m) => emit("error", category, m),
    critical: (m) => emit("error", category, m),
  };
}
