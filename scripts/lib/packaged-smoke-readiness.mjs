import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE_NAME = /^ave-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;
const BOOT_READY = /\bboot: ready \(\d+ tools, \d+ plugins, \d+ mcp\)/;

export function snapshotProductionLogs(homeDir) {
  const logsDir = join(homeDir, "logs");
  if (!existsSync(logsDir)) return new Map();
  return new Map(readdirSync(logsDir)
    .filter((name) => LOG_FILE_NAME.test(name))
    .map((name) => [name, statSync(join(logsDir, name)).size]));
}

export function readProductionLogsSince(homeDir, snapshot) {
  const logsDir = join(homeDir, "logs");
  if (!existsSync(logsDir)) return "";
  return readdirSync(logsDir)
    .filter((name) => LOG_FILE_NAME.test(name))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(logsDir, name));
      const previousSize = snapshot.get(name) ?? 0;
      return bytes.subarray(bytes.length < previousSize ? 0 : previousSize).toString("utf8");
    })
    .join("");
}

export function reachedBootReadiness(logText) {
  return BOOT_READY.test(logText);
}

export function launchSucceeded({ ready, timedOut, code, signal }) {
  if (!ready || (code !== null && code !== 0)) return false;
  return code === 0 || (timedOut && (signal === "SIGTERM" || signal === "SIGKILL"));
}
