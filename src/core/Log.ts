/**
 * Leveled logging facade — the ONLY console.* owner in src/ (fable5#133).
 *
 * `?log=debug|info|warn|error|silent` sets the emission floor; default is
 * `warn`, so a production boot is quiet except warnings/errors. `?log=debug`
 * or `?log=info` restores the boot chatter (adapter diag, road-build
 * summaries, camera mode). Tags are module names, printed `[tag] message`.
 *
 * `addErrorSink()` is the place to hang future crash reporting (the dev-mode
 * `?debug=1` POST sink in tools/debug-telemetry-server.ts, a localStorage
 * breadcrumb ring, …): sinks see every error() call regardless of the
 * console floor.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORD: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function levelFromUrl(): LogLevel {
  if (typeof window === 'undefined') return 'warn';
  const raw = new URLSearchParams(window.location.search).get('log');
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent'
    ? raw
    : 'warn';
}

let floor = levelFromUrl();

/** Override the URL-derived floor (menus, tests). */
export function setLogLevel(level: LogLevel): void {
  floor = level;
}

export function getLogLevel(): LogLevel {
  return floor;
}

export type ErrorSink = (tag: string, msg: unknown, args: unknown[]) => void;
const errorSinks: ErrorSink[] = [];

/** Register a crash-reporting sink — sees error() even at floor 'silent'. */
export function addErrorSink(fn: ErrorSink): void {
  errorSinks.push(fn);
}

type ConsoleMethod = (...args: unknown[]) => void;

function emit(method: ConsoleMethod, tag: string, msg: unknown, args: unknown[]): void {
  method(`[${tag}]`, msg, ...args);
}

export const log = {
  debug(tag: string, msg: unknown, ...args: unknown[]): void {
    if (ORD[floor] <= ORD.debug) emit(console.debug, tag, msg, args);
  },
  info(tag: string, msg: unknown, ...args: unknown[]): void {
    if (ORD[floor] <= ORD.info) emit(console.log, tag, msg, args);
  },
  warn(tag: string, msg: unknown, ...args: unknown[]): void {
    if (ORD[floor] <= ORD.warn) emit(console.warn, tag, msg, args);
  },
  error(tag: string, msg: unknown, ...args: unknown[]): void {
    for (const sink of errorSinks) sink(tag, msg, args);
    if (ORD[floor] <= ORD.error) emit(console.error, tag, msg, args);
  },
};
