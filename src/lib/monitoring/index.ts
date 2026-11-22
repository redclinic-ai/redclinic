// Logging and error reporting. Logs are JSON lines on stdout (every hosting platform collects these).
// No error-monitoring provider is selected (D2); reportError logs only until one is added behind ErrorReporter.
// Never put patient details, passwords, tokens or file contents in log fields.

type Level = "info" | "warn" | "error";

const REDACT = /pass(word)?|token|secret|authorization|cookie|sig$/i;

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? "[redacted]" : v;
  return out;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, env: process.env.APP_ENV, ...clean(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface ErrorReporter {
  readonly name: string;
  capture(err: unknown, context: Record<string, unknown>): void;
}

class LogOnlyReporter implements ErrorReporter {
  readonly name = "log-only";
  capture(err: unknown, context: Record<string, unknown>): void {
    const e = err instanceof Error ? err : new Error(String(err));
    log("error", e.message, { ...context, error: e.name, stack: e.stack?.split("\n").slice(0, 8).join("\n") });
  }
}

let reporter: ErrorReporter = new LogOnlyReporter();

export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  try {
    reporter.capture(err, context);
  } catch {
    console.error("[monitoring] reporter failed", err);
  }
}

/** Tests, or when a provider is chosen. */
export function setErrorReporter(r: ErrorReporter): void {
  reporter = r;
}
