import type { Readable } from "node:stream";
import { createLogger } from "../../lib/logger.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";

const log = createLogger("plugin-stderr");
const LINE_BYTES_MAX = 16_384;
// Retain bounded lookahead for redaction before the display cap. Larger lines lose all free text.
const RAW_LINE_BYTES_MAX = 65_536;
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
    const raw = truncated ? "" : Buffer.concat(parts, bytes).toString("utf8").replace(/\r$/u, "");
    parts = [];
    bytes = 0;
    const overflowed = truncated;
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
    const masked = Buffer.from(maskSensitiveData(raw).masked, "utf8");
    let end = Math.min(masked.length, LINE_BYTES_MAX);
    // A continuation byte belongs to the character beginning before the cap.
    while (end < masked.length && end > 0 && (masked[end]! & 0xc0) === 0x80) end--;
    const line = overflowed
      ? "[truncated: line exceeded capture limit]"
      : masked.subarray(0, end).toString("utf8") + (masked.length > end ? " [truncated]" : "");
    if (line.startsWith("ERROR ")) log.error({ pluginId }, line);
    else if (line.startsWith("WARN ")) log.warn({ pluginId }, line);
    else log.info({ pluginId }, line);
  };
  const append = (part: Buffer): void => {
    if (truncated) return;
    const remaining = RAW_LINE_BYTES_MAX - bytes;
    if (part.length > remaining) {
      // A clipped credential may no longer match the redactor. Discard rather than expose its prefix.
      truncated = true;
      parts = [];
      bytes = 0;
      return;
    }
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
      // Keep the bucket for this plugin across child restarts; only time replenishes its tokens.
    }
  };
  stream.once("end", finish);
  stream.once("close", finish);
}
