/** Attach file logging at boot through a mutable stream target. */
import pino from "pino";
import prettyStream from "pino-pretty";
import { createAsyncLogDestination } from "./async-log-destination.js";
import { createLogFileSink, type LogFileSink, type LogFileSinkOptions } from "./log-file-sink.js";
import { isPackagedElectronProcess } from "../boot/dev-flags.js";
import { execModeRequested } from "../main/exec-mode.js";

const isPackagedElectron = isPackagedElectronProcess(process);
const isTest = !isPackagedElectron
  && (process.env.VITEST !== undefined || process.env.NODE_ENV === "test");
const isProduction = process.env.NODE_ENV === "production";
// Derive packaged status from runtime facts before boot; packaged builds must ignore user-controlled test and development flags.
const useJsonFormat =
  process.env.AVE_LOG_FORMAT === "json" || isProduction || isPackagedElectron;

/** The mutable file target permits boot attachment without reconstructing the logger. */
let fileSink: LogFileSink | null = null;

const LOG_LEVEL = process.env.LOG_LEVEL ?? ((isProduction || isPackagedElectron) ? "info" : "debug");

/** One-shot execution owns stdout for JSON events; choose stderr from argv at import time before host services exist. */
const execHeadless = execModeRequested(process.argv);

const prettyOptions = { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" };

function createConsoleStream(): NodeJS.WritableStream {
  return useJsonFormat
    ? (execHeadless ? process.stderr : process.stdout)
    : // Use a pretty-print stream rather than a worker transport whose entry cannot resolve inside packaged archives.
      prettyStream({
        ...prettyOptions,
        ...(execHeadless ? { destination: process.stderr } : {}),
      });
}

export const transport = !isTest && !useJsonFormat
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    }
  : undefined;

const fileStream = {
  write(chunk: string): void {
    try { fileSink?.write(chunk); } catch { /* Logging cannot affect the caller. */ }
  },
};

/** Redact credentials at top level and one level deep only; callers must never log deeper secret-bearing objects. */
const REDACT_PATHS = [
  "*.apiKey",
  "*.token",
  "*.authorization",
  "*.password",
  "*.secret",
  "apiKey",
  "token",
  "authorization",
  "password",
  "secret",
];
const redact = { paths: REDACT_PATHS, censor: "[redacted]" };

/** Test mode uses console-spy-compatible output; production multistream keeps a dormant file target until boot. */
export const logger = isTest
  // Write test output synchronously so process-exit hooks cannot outlive renderer VM contexts.
  ? pino({ level: LOG_LEVEL, redact, transport }, pino.destination({ fd: 1, sync: true }))
  : pino(
      { level: LOG_LEVEL, redact },
      pino.multistream([
        // Create async pretty output only outside test mode to avoid stale exit hooks.
        { stream: createConsoleStream(), level: LOG_LEVEL as pino.Level },
        { stream: fileStream as NodeJS.WritableStream, level: LOG_LEVEL as pino.Level },
      ]),
    );

/** Destroy any previous sink before attaching another; return null on failure so logging cannot block boot. */
export function initFileLogSink(options: LogFileSinkOptions = {}): LogFileSink | null {
  try {
    if (fileSink) {
      fileSink.destroy();
      fileSink = null;
    }
    fileSink = createLogFileSink(options);
    return fileSink;
  } catch {
    fileSink = null;
    return null;
  }
}

export function closeFileLogSink(): void {
  const sink = fileSink;
  fileSink = null;
  try { sink?.destroy(); } catch { /* Logging cannot affect shutdown. */ }
}

let bestEffortLogger: pino.Logger | undefined;
let permissionConsole: ReturnType<typeof createAsyncLogDestination> | undefined;

function getBestEffortLogger(): pino.Logger {
  if (!bestEffortLogger) {
    const destination = createAsyncLogDestination({
      fd: execHeadless ? 2 : 1,
      sync: false,
      maxLength: 1024 * 1024,
    });
    permissionConsole = destination;
    const pretty = useJsonFormat ? undefined : prettyStream.prettyFactory(prettyOptions);
    const consoleStream = { write: (chunk: string) => destination.write(pretty ? pretty(chunk) : chunk) };
    bestEffortLogger = pino({ level: LOG_LEVEL, redact }, pino.multistream([
      { stream: consoleStream, level: LOG_LEVEL as pino.Level },
      { stream: fileStream as NodeJS.WritableStream, level: LOG_LEVEL as pino.Level },
    ]));
  }
  return bestEffortLogger;
}

export async function flushLogDestinations(): Promise<void> {
  const file = fileSink;
  const console = permissionConsole;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([file?.flush(), console?.flush(), new Promise<void>((resolve) => {
        try { logger.flush(() => resolve()); } catch { resolve(); }
      })]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); }),
    ]);
    // Pending counts are records accepted since the last confirmed drain.
    const undelivered = (file?.pending ?? 0) + (console?.pending ?? 0);
    if (undelivered > 0) {
      getBestEffortLogger().warn({ event: "permission_log_shutdown_loss", undelivered }, "permission_log_shutdown_loss");
    }
  } catch {
    // A broken destination cannot change shutdown status.
  } finally {
    clearTimeout(timer);
  }
}

/** Use console proxies only in unpackaged tests; packaged runs retain structured production logging. */
export function createLogger(module: string, bestEffort = false): pino.Logger {
  if (isTest) {
    const prefix = `[${module}]`;
    const consoleFn = (level: "warn" | "error" | "info" | "debug") =>
      (objOrMsg: unknown, ...args: unknown[]) => {
        const fn =
          level === "warn"
            ? console.warn
            : level === "error"
              ? console.error
              : console.log;
        if (typeof objOrMsg === "object" && objOrMsg !== null && !(objOrMsg instanceof Error)) {
          const msg = typeof args[0] === "string" ? args[0] : "";
          fn(`${prefix} ${msg}`, objOrMsg, ...args.slice(1));
        } else if (typeof objOrMsg === "string") {
          fn(`${prefix} ${objOrMsg}`, ...args);
        } else {
          fn(prefix, objOrMsg, ...args);
        }
      };

    return {
      warn: consoleFn("warn"),
      error: consoleFn("error"),
      info: consoleFn("info"),
      debug: consoleFn("debug"),
      trace: consoleFn("debug"),
      fatal: consoleFn("error"),
      child: () => createLogger(module),
    } as unknown as pino.Logger;
  }

  return (bestEffort ? getBestEffortLogger() : logger).child({ module });
}
