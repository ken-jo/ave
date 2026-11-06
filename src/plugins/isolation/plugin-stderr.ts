import type { Readable } from "node:stream";
import { createLogger } from "../../lib/logger.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";

const log = createLogger("plugin-stderr");
const LINE_BYTES_MAX = 16_384;
const LINES_PER_SECOND = 100;
const LINE_BURST_MAX = 500;

interface PluginRate {
  users: number;
  tokens: number;
  updatedAt: number;
  droppedLines: number;
  summaryTimer?: ReturnType<typeof setTimeout>;
}

const rates = new Map<string, PluginRate>();

/** Read only diagnostics; protocol output remains owned by the transport. Simultaneous children share their plugin's budget. */
export function capturePluginStderr(stream: Readable, pluginId: string): void {
  let rate = rates.get(pluginId);
  if (!rate) {
    rate = { users: 0, tokens: LINE_BURST_MAX, updatedAt: Date.now(), droppedLines: 0 };
    rates.set(pluginId, rate);
  }
  const budget = rate;
  budget.users++;
  const reportDrops = (): void => {
    if (budget.summaryTimer) clearTimeout(budget.summaryTimer);
    budget.summaryTimer = undefined;
    if (budget.droppedLines === 0) return;
    log.info({ pluginId, droppedLines: budget.droppedLines }, "Plugin stderr rate limit dropped lines");
    budget.droppedLines = 0;
  };
  let parts: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let finished = false;
  const emitLine = (): void => {
    const raw = Buffer.concat(parts, bytes).toString("utf8").replace(/\r$/u, "");
    parts = [];
    bytes = 0;
    const suffix = truncated ? " [truncated]" : "";
    truncated = false;
    const now = Date.now();
    budget.tokens = Math.min(LINE_BURST_MAX, budget.tokens + Math.max(0, now - budget.updatedAt) * LINES_PER_SECOND / 1_000);
    budget.updatedAt = now;
    if (budget.tokens < 1) {
      budget.droppedLines++;
      if (!budget.summaryTimer) {
        budget.summaryTimer = setTimeout(reportDrops, 1_000);
        budget.summaryTimer.unref();
      }
      return;
    }
    budget.tokens--;
    const line = maskSensitiveData(raw).masked + suffix;
    if (line.startsWith("ERROR ")) log.error({ pluginId }, line);
    else if (line.startsWith("WARN ")) log.warn({ pluginId }, line);
    else log.info({ pluginId }, line);
  };
  const append = (part: Buffer): void => {
    const remaining = LINE_BYTES_MAX - bytes;
    if (part.length > remaining) truncated = true;
    if (remaining > 0 && part.length > 0) {
      const kept = part.subarray(0, remaining);
      // Copy so a small pending line never retains a large child-output buffer.
      parts.push(Buffer.from(kept));
      bytes += kept.length;
    }
  };
  stream.on("data", (chunk: Buffer | string) => {
    if (finished) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      append(buffer.subarray(start, end));
      emitLine();
      start = end + 1;
    }
    append(buffer.subarray(start));
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (bytes > 0 || truncated) emitLine();
    budget.users--;
    if (budget.users === 0) {
      reportDrops();
      rates.delete(pluginId);
    }
  };
  stream.once("end", finish);
  stream.once("close", finish);
}
