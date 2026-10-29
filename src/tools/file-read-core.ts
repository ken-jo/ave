// Text previews and native agent reads share line windows; each caller retains its existing read policy.
import { createReadStream, realpathSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { finished } from "node:stream/promises";

import { expandLeadingTilde } from "../shared/home-tilde.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
  isConfiguredSessionReadPath,
} from "../permissions/sensitive-paths.js";

// Text preview and read_file share this size cap.
export const MAX_TEXT_FILE_BYTES = 2_000_000;
const BINARY_SAMPLE_BYTES = 8_192;

// Reject glob patterns before filesystem access; they are tool arguments, not concrete file paths.
export function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value) || value.includes("**");
}

type AssertReadableFailure = "not-a-file" | "sensitive-path" | "path-not-allowed";

export type AssertReadableResult =
  | { ok: true; resolved: string }
  | { ok: false; error: AssertReadableFailure };

// Direct preview and document reads have no agent approval receipt.
// Keep their sensitive-path denial separate from pipeline-authorized native tool reads.
// Check globs, then sensitive paths, then symlink-safe directory scope.
// Sensitive denial must precede allowed-root checks so grants cannot expose private descendants.
export function assertReadableFilePath(
  inputPath: string,
  cwd: string,
  extraAllowed: readonly string[],
): AssertReadableResult {
  if (isGlobPattern(inputPath)) return { ok: false, error: "not-a-file" };
  const expanded = expandLeadingTilde(inputPath);
  const lexical = isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(cwd, expanded);
  // Guard and read the same canonical target so symlink swaps cannot redirect access to sensitive or outside files.
  // Preserve lexical missing paths for clean downstream stat errors.
  let resolved = lexical;
  try {
    resolved = realpathSync.native(lexical);
  } catch {
    resolved = lexical;
  }
  const canonical = canonicalizePathForMatch(resolved);
  const sensitive = isSensitivePath(caseFoldForMatch(lexical), "read")
    ?? isSensitivePath(caseFoldForMatch(canonical), "read");
  if (sensitive) return { ok: false, error: "sensitive-path" };
  if (isConfiguredSessionReadPath(canonical)) return { ok: true, resolved };
  const check = validateSandboxPath(resolved, cwd, [...extraAllowed]);
  if (!check.allowed) return { ok: false, error: "path-not-allowed" };
  return { ok: true, resolved };
}

export async function isBinaryFile(path: string): Promise<boolean> {
  const stream = createReadStream(path, { start: 0, end: BINARY_SAMPLE_BYTES - 1 });
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    stream.destroy();
    await finished(stream, { cleanup: true }).catch(() => undefined);
  }
  return Buffer.concat(chunks).includes(0);
}

// Window content preserves source separators except the last; lines omit separators and truncated reports a remaining tail.
export async function readTextFileWindow(
  path: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; content: string; truncated: boolean }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines: string[] = [];
  const contentParts: string[] = [];
  let lineParts: string[] = [];
  let lineNo = 0;
  let previousSeparator = "";
  let pendingCR = false;
  let lineOpen = false;
  let truncated = false;

  const append = (fragment: string): void => {
    if (fragment.length === 0) return;
    lineOpen = true;
    if (lineNo >= offset && lines.length < limit) lineParts.push(fragment);
  };

  const finishLine = (separator: string): boolean => {
    if (lineNo >= offset) {
      if (lines.length >= limit) {
        truncated = true;
        return false;
      }
      const line = lineParts.join("");
      if (lines.length > 0) contentParts.push(previousSeparator);
      lines.push(line);
      contentParts.push(line);
    }
    lineParts = [];
    lineOpen = false;
    lineNo += 1;
    previousSeparator = separator;
    return true;
  };

  try {
    read: for await (const chunk of input) {
      if (chunk.length === 0) continue;
      let start = 0;
      // A CR at a chunk boundary may be the first half of a CRLF separator.
      if (pendingCR) {
        pendingCR = false;
        const hasLF = chunk.startsWith("\n");
        if (!finishLine(hasLF ? "\r\n" : "\r")) break;
        if (hasLF) start = 1;
      }

      const separators = /\r\n|\r|\n/g;
      separators.lastIndex = start;
      let match: RegExpExecArray | null;
      while ((match = separators.exec(chunk)) !== null) {
        append(chunk.slice(start, match.index));
        start = separators.lastIndex;
        if (match[0] === "\r" && start === chunk.length) {
          pendingCR = true;
          break;
        }
        if (!finishLine(match[0])) break read;
      }
      append(chunk.slice(start));
    }
    if (!truncated) {
      if (pendingCR) finishLine("\r");
      else if (lineOpen) finishLine("");
    }
  } finally {
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
  return { lines, content: contentParts.join(""), truncated };
}
