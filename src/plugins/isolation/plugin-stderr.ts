import type { Readable } from "node:stream";
import { createLogger } from "../../lib/logger.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";

const log = createLogger("plugin-stderr");
const LINE_BYTES_MAX = 16_384;
// Retain bounded lookahead for redaction before the display cap. Larger lines lose all free text.
const RAW_LINE_BYTES_MAX = 65_536;
const LINES_PER_SECOND = 100;
const LINE_BURST_MAX = 500;
const REDACTED_ENV_VALUE = Buffer.from("[REDACTED]");

interface PluginRate {
  users: number;
  tokens: number;
  updatedAt: number;
  droppedLines: number;
  summaryTimer?: ReturnType<typeof setTimeout>;
}

const rates = new Map<string, PluginRate>();

/** Read only diagnostics; protocol output remains owned by the transport. Simultaneous children share their plugin's budget. */
export function capturePluginStderr(stream: Readable, pluginId: string, resolvedEnvValues: readonly string[] = []): void {
  const valuesByFirstByte: Buffer[][] = [];
  for (const value of new Set(resolvedEnvValues)) {
    // Values shorter than eight characters bypass this check to preserve common diagnostic text.
    if (!/^.{8}/su.test(value)) continue;
    const needle = Buffer.from(value);
    (valuesByFirstByte[needle[0]!] ??= []).push(needle);
  }
  for (const values of valuesByFirstByte) values?.sort((a, b) => b.length - a.length);
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
  let rawBytes = 0;
  let truncated = false;
  let finished = false;
  const emitLine = (): void => {
    const raw = truncated ? "" : Buffer.concat(parts, bytes).toString("utf8").replace(/\r$/u, "");
    parts = [];
    bytes = 0;
    rawBytes = 0;
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
  const append = (part: Buffer, rawLength = part.length): void => {
    if (truncated) return;
    rawBytes += rawLength;
    if (rawBytes > RAW_LINE_BYTES_MAX) {
      // A clipped credential may no longer match the redactor. Discard rather than expose its prefix.
      truncated = true;
      parts = [];
      bytes = 0;
      return;
    }
    if (part.length > 0) {
      // Copy so a small pending line never retains a large child-output buffer.
      parts.push(Buffer.from(part));
      bytes += part.length;
    }
  };
  const captureChunk = (buffer: Buffer): void => {
    let start = 0;
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      append(buffer.subarray(start, end));
      emitLine();
      start = end + 1;
    }
    append(buffer.subarray(start));
  };
  let pending: Buffer | undefined;
  const redactChunk = (chunk: Buffer, final = false): void => {
    const buffer = pending ? Buffer.concat([pending, chunk]) : chunk;
    pending = undefined;
    let plainStart = 0;
    for (let offset = 0; offset < buffer.length; offset++) {
      const match = valuesByFirstByte[buffer[offset]!]?.find(value => {
        const length = Math.min(value.length, buffer.length - offset);
        return (!final || length === value.length) && value.compare(buffer, offset, offset + length, 0, length) === 0;
      });
      if (!match) continue;
      captureChunk(buffer.subarray(plainStart, offset));
      if (match.length > buffer.length - offset) {
        // Look ahead only when a value could continue in the next chunk.
        pending = Buffer.from(buffer.subarray(offset));
        return;
      }
      append(REDACTED_ENV_VALUE, match.length);
      offset += match.length - 1;
      plainStart = offset + 1;
    }
    captureChunk(buffer.subarray(plainStart));
  };
  const handleData = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (valuesByFirstByte.length > 0) redactChunk(buffer);
    else captureChunk(buffer);
  };
  stream.on("data", handleData);
  const finish = (): void => {
    if (finished) return;
    finished = true;
    stream.off("data", handleData);
    if (pending) redactChunk(Buffer.alloc(0), true);
    valuesByFirstByte.length = 0;
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
