/** Use AuditLogger for security events; attach ordinary file logging at boot through a mutable stream target. */
import pino from "pino";
import prettyStream from "pino-pretty";
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

function createConsoleStream(): NodeJS.WritableStream {
  return useJsonFormat
    ? (execHeadless ? process.stderr : process.stdout)
    : // Use a pretty-print stream rather than a worker transport whose entry cannot resolve inside packaged archives.
      prettyStream({
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
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
    fileSink?.write(chunk);
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
  if (fileSink) {
    fileSink.destroy();
    fileSink = null;
  }
}

/** Use console proxies only in unpackaged tests; packaged runs retain structured production logging. */
export function createLogger(module: string): pino.Logger {
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

  return logger.child({ module });
}
