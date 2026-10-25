// Diagnostics are internal and host-renderer-only; exported logs and bundle content pass through DLP.
import { ipcMain, dialog } from "electron";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import {
  buildDiagnosticsBundle,
  listCrashDumps,
  type CrashDumpMeta,
} from "../../audit/diagnostics-bundle.js";
import { redactForLLM, redactFsPath, scrubSecretsForLLM } from "../../audit/dlp-filter.js";
import { parseIsoDate } from "./audit.js";
import { parseLogFileDate } from "../../lib/log-file-sink.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { aveHome } from "../../shared/ave-home.js";
import { createLogger } from "../../lib/logger.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("ipc-diagnostics");

const MAX_TAIL_LINES = 2000;
const DEFAULT_TAIL_LINES = 200;

type LogLevelFilter = "all" | "error" | "warn" | "info" | "debug";
const VALID_LEVELS: readonly LogLevelFilter[] = ["all", "error", "warn", "info", "debug"];

const PINO_LEVEL_NAME: Record<number, LogLevelFilter | "trace" | "fatal"> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

async function crashDumpsDir(): Promise<string> {
  const { app } = await import("electron");
  return resolve(app.getPath("userData"), "crash-dumps");
}

// Tail reads redact PII and credentials, loading each needed rotation-bounded file in full.
async function tailLogs(lines: number, level: LogLevelFilter): Promise<string[]> {
  const dir = join(aveHome(), "logs");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => parseLogFileDate(f) !== null).sort();
  } catch {
    return [];
  }
  const collected: string[] = [];
  for (let i = files.length - 1; i >= 0 && collected.length < lines; i--) {
    let raw: string;
    try {
      raw = await readFile(join(dir, files[i]), "utf-8");
    } catch {
      continue;
    }
    const fileLines = raw.split("\n").filter((l) => l.length > 0);
    collected.unshift(...fileLines);
  }
  const filtered = level === "all" ? collected : collected.filter((l) => lineMatchesLevel(l, level));
  const tail = filtered.slice(-lines);
  return tail.map((l) => scrubSecretsForLLM(redactForLLM(l).redacted));
}

function lineMatchesLevel(line: string, level: LogLevelFilter): boolean {
  try {
    const obj = JSON.parse(line) as { level?: number | string };
    const name =
      typeof obj.level === "number"
        ? PINO_LEVEL_NAME[obj.level]
        : typeof obj.level === "string"
          ? obj.level
          : undefined;
    return name === level;
  } catch {
    return line.toUpperCase().includes(level.toUpperCase());
  }
}

export function registerDiagnosticsHandlers(deps: IpcDeps): void {
  const { auditLogger, settingsService, getMainWindow } = deps;

  ipcMain.handle(
    CHANNELS.diagnostics.export,
    async (e, opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.diagnostics.export, e);
        return UNAUTHORIZED_FRAME;
      }
      // Validate day keys before bundle construction; audit-section error isolation would otherwise hide an incomplete export.
      const dateFrom = parseIsoDate(opts?.dateFrom, "dateFrom");
      const dateTo = parseIsoDate(opts?.dateTo, "dateTo");
      try {
        const settings = settingsService.getAll();
        // Persisted crash-dump consent is authoritative; renderer arguments may narrow it, never widen it.
        const includeCrashDumps =
          settings.diagnostics.includeCrashDumps === true && opts?.includeCrashDumps !== false;
        const buffer = await buildDiagnosticsBundle({
          settings,
          auditLogger,
          appVersion: getAveAppVersion(),
          crashDumpsDir: await crashDumpsDir(),
          includeCrashDumps,
          dateFrom,
          dateTo,
          osRelease: (await import("node:os")).release(),
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dialogOptions = {
          title: "진단 번들 저장",
          defaultPath: `ave-diagnostics-${stamp}.zip`,
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        };
        const win = getMainWindow();
        const res = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
        if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const };

        const { writeFile } = await import("node:fs/promises");
        await writeFile(res.filePath, buffer);
        // Audit effective options, date range, byte size, and redacted destination without exposing host paths.
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "diagnostics-export",
          type: "diagnostics-export",
          input: JSON.stringify({
            includeCrashDumps,
            dateFrom,
            dateTo,
            bytes: buffer.length,
            path: redactFsPath(res.filePath),
          }),
        });
        await auditLogger.flush();
        return { ok: true as const, path: res.filePath, bytes: buffer.length };
      } catch (err) {
        log.warn({ err }, "diagnostics export failed");
        return { ok: false as const, error: "export-failed" as const };
      }
    },
  );

  ipcMain.handle(CHANNELS.diagnostics.crashList, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.diagnostics.crashList, e);
      return UNAUTHORIZED_FRAME;
    }
    try {
      const dumps: CrashDumpMeta[] = listCrashDumps(await crashDumpsDir());
      return { ok: true as const, dumps };
    } catch (err) {
      log.warn({ err }, "crash-list failed");
      return { ok: false as const, error: "crash-list-failed" as const };
    }
  });

  ipcMain.handle(
    CHANNELS.logs.tail,
    async (e, args?: { lines?: number; level?: string }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.logs.tail, e);
        return UNAUTHORIZED_FRAME;
      }
      try {
        const rawLines = typeof args?.lines === "number" ? args.lines : DEFAULT_TAIL_LINES;
        const lines = Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(rawLines)));
        const level: LogLevelFilter =
          typeof args?.level === "string" && (VALID_LEVELS as readonly string[]).includes(args.level)
            ? (args.level as LogLevelFilter)
            : "all";
        const out = await tailLogs(lines, level);
        return { ok: true as const, lines: out };
      } catch (err) {
        log.warn({ err }, "logs tail failed");
        return { ok: false as const, error: "logs-tail-failed" as const };
      }
    },
  );
}
