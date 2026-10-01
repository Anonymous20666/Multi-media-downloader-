/**
 * Minimal structured JSON logger with secret redaction (§61/§62).
 * Never log: bot tokens, api hashes, sessions, OTPs, signed URL query strings.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Matches bot tokens, long hex secrets, and URL query strings (often signed).
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/\d{6,12}:[A-Za-z0-9_-]{30,}/g, "<BOT_TOKEN>"],
  [/([?&](sig|signature|token|key|auth|session|otp|code)=)[^&\s"']+/gi, "$1<REDACTED>"],
  [/\b[0-9a-f]{32,}\b/gi, "<HEX_SECRET>"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of REDACT_PATTERNS) {
    out = out.replace(re, rep);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: Level = "info", bindings: Record<string, unknown> = {}): Logger {
  const emit = (lv: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lv] < ORDER[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lv, msg, ...bindings, ...(fields ?? {}) });
    const out = redact(line);
    if (lv === "error" || lv === "warn") process.stderr.write(out + "\n");
    else process.stdout.write(out + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}
