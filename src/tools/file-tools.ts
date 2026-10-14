import { constants, createReadStream, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as pathResolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { z } from "zod";

import type { PathEffect } from "../permissions/allowed-directories.js";
import { consumeExecutionGrantForBuiltinToolInvocation } from "../permissions/execution-router.js";
import {
  MAX_TEXT_FILE_BYTES,
  isBinaryFile,
  readTextFileWindow,
} from "./file-read-core.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { PATCH_ENVELOPE_PATH_FIELD_SUFFIX } from "../shared/dotted-field-value.js";
import { globToRegExp } from "../lib/glob-matcher.js";
import { writeDiffSidecar, WRITE_DIFF_PREVIEW_LIMIT } from "./write-diff-cache.js";
import { ensureFileAccess, sensitiveFilePattern } from "./file-access-policy.js";
import { copyPath, runOwnedTransfer } from "./guarded-file-transfer.js";
import { consumeTarArchive } from "./archive-entry-reader.js";
import type { ArchiveFormat, TransferResult } from "./file-transfer-types.js";
import {
  ZodTool,
  type Tool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./base.js";
import { sleep } from "../shared/abortable-deadline.js";
import {
  TOOL_TIMEOUT_POLICY,
  resolveWorkloadBrokerExecutorCeilingMs,
} from "../shared/tool-timeout-policy.js";
import { prepareImageBytes, prepareImageFile } from "./image-preparation.js";
import {
  IMAGE_PREPARATION_POLICY,
  ImagePreparationOptionsSchema,
} from "../shared/image-preparation-policy.js";
import { errorMessage } from "../shared/error-message.js";
import { RENAME_FILE_LOCK_CODES, transientFsLockDelayMs } from "../lib/transient-fs-lock-retry.js";
import { trimOversizedToolResult } from "../shared/tool-result-trim.js";
import {
  applyPatchChunks,
  parsePatchEnvelope,
  patchOperationPaths,
  type PatchFileOperation,
} from "../shared/patch-envelope.js";
import {
  fileReadKey,
  forgetFileRead,
  hashAndCountLines,
  lookupFileRead,
  recordFileRead,
  sha256Hex,
  workloadFileReadKey,
} from "./file-read-state.js";
import type {
  BrokeredWorkloadCapability,
  WorkloadToolCorrelationAuthority,
} from "../workload/runtime.js";

type ToolErrorResult = ToolExecutionResult & { isError: true };
type Result<T> = { ok: true; value: T } | { ok: false; error: ToolErrorResult };
type WorkloadRuntime = typeof import("../workload/runtime.js");

type FileExecutionTransport =
  | { readonly kind: "local" }
  | {
      readonly kind: "broker";
      readonly runtime: WorkloadRuntime;
      readonly capability: BrokeredWorkloadCapability;
      readonly correlationAuthority: WorkloadToolCorrelationAuthority;
    }
  | { readonly kind: "failure"; readonly result: ToolErrorResult };

const DEFAULT_LINE_LIMIT = 2_000;
const MAX_LINE_LIMIT = 5_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 1_000;
const MAX_SCAN_FILES = 50_000;
const MAX_SCAN_ENTRIES = 75_000;
const DEFAULT_LIST_DEPTH = 1;
const MAX_LIST_DEPTH = 8;
const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

/**
 * Object-identity boundary for the host's built-in file tools. A plugin or MCP
 * tool can copy a name/schema, but it cannot insert itself into this set.
 */
const canonicalFileTools = new WeakSet<object>();

/**
 * Canonical brokered file operations inherit the same host-owned wall-clock
 * budget as their executor invocation. Supplying it in every request prevents
 * either side of the broker protocol from inventing a shorter implicit
 * deadline (the former Python and transport defaults were 30 seconds).
 */
function brokerFilePayload<T extends object>(payload: T): T & { readonly timeoutMs: number } {
  return { ...payload, timeoutMs: TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs };
}

function brokerFailureResult(reason: string): ToolErrorResult {
  return {
    output: `Workload broker refused file execution (${reason}).`,
    isError: true,
    metadata: {
      source: "workload-broker",
      executionTransport: "workload-broker",
      sandboxed: true,
      isolation: "disposable-container",
    },
  };
}

async function resolveFileExecutionTransport(
  tool: Pick<Tool, "name">,
  normalizedInput: unknown,
  ctx: ToolExecutionContext,
): Promise<FileExecutionTransport> {
  const runtime = await import("../workload/runtime.js");
  const requestedGrant = ctx.executionRouteGrant;
  const authority = consumeExecutionGrantForBuiltinToolInvocation({
    grant: requestedGrant,
    toolName: tool.name,
    normalizedInput,
    cwd: ctx.cwd,
  });
  if (requestedGrant !== undefined && authority === null) {
    return { kind: "failure", result: brokerFailureResult("broker-bound execution grant unavailable") };
  }
  if (!runtime.isWorkloadBrokerActive()) {
    if (authority !== null) {
      return { kind: "failure", result: brokerFailureResult("broker became inactive") };
    }
    return { kind: "local" };
  }
  if (
    authority?.route !== "disposable-container" ||
    authority.disposableAuthority !== "workload-broker" ||
    authority.brokeredWorkloadCapability === undefined ||
    authority.workloadCorrelationAuthority === undefined
  ) {
    return { kind: "failure", result: brokerFailureResult("broker-bound execution grant required") };
  }
  if (!runtime.isActiveWorkloadBrokerCwd(ctx.cwd)) {
    return { kind: "failure", result: brokerFailureResult("cwd binding mismatch") };
  }
  return {
    kind: "broker",
    runtime,
    capability: authority.brokeredWorkloadCapability,
    correlationAuthority: authority.workloadCorrelationAuthority!,
  };
}

const FilePathSchema = z.object({
  path: z.string().min(1).describe("Absolute path or path relative to the session cwd."),
});

export const ReadFileInputSchema = FilePathSchema.extend({
  offset: z.number().int().min(0).default(0).describe("Zero-based line offset."),
  limit: z.number().int().min(1).max(MAX_LINE_LIMIT).default(DEFAULT_LINE_LIMIT),
});

export const ListFilesInputSchema = FilePathSchema.extend({
  depth: z.number().int().min(1).max(MAX_LIST_DEPTH).default(DEFAULT_LIST_DEPTH),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const GlobFilesInputSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern relative to path/cwd, e.g. src/**/*.ts."),
  path: z.string().min(1).optional().describe("Search root. Defaults to session cwd."),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const GrepFilesInputSchema = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression."),
  path: z.string().min(1).optional().describe("Search root. Defaults to session cwd."),
  include: z.string().min(1).optional().describe("Optional glob include filter, e.g. **/*.ts."),
  caseSensitive: z.boolean().default(true),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const WriteFileInputSchema = FilePathSchema.extend({
  content: z.string().describe("Full file content to write."),
});

export const EditFileInputSchema = FilePathSchema.extend({
  oldText: z.string().min(1).describe("Exact text to replace."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().default(false),
});

export const MultiEditInputSchema = FilePathSchema.extend({
  replacements: z.array(z.object({
    oldText: z.string().min(1).describe("Exact text to replace."),
    newText: z.string().describe("Replacement text."),
    replaceAll: z.boolean().default(false),
  })).min(1).max(50),
});

export const ApplyPatchInputSchema = z.object({
  patch: z.string().min(1).superRefine((text, refinement) => {
    const parsed = parsePatchEnvelope(text);
    if (!parsed.ok) refinement.addIssue({ code: "custom", message: `invalid patch: ${parsed.error}` });
  }).describe(
    "Patch text from '*** Begin Patch' to '*** End Patch'. Each file section starts with " +
    "'*** Add File: <path>' (every line prefixed '+'), '*** Delete File: <path>', or " +
    "'*** Update File: <path>' (optionally followed by '*** Move to: <path>') with chunks of " +
    "' ' context, '-' removed and '+' added lines, each chunk optionally introduced by '@@ <anchor line>'.",
  ),
});

export const MoveFileInputSchema = z.object({
  sourcePath: z.string().min(1).describe("Source file path, absolute or relative to session cwd."),
  destinationPath: z.string().min(1).describe("Destination file path, absolute or relative to session cwd."),
  overwrite: z.boolean().default(false),
});

const TransferDestinationSchema = z.string().min(1).describe(
  "Exact new destination path, absolute or relative to session cwd. Its parent must already exist; existing destinations are rejected.",
);

export const CopyPathInputSchema = z.object({
  sourcePath: z.string().min(1).describe("Regular file or directory tree to copy, absolute or relative to session cwd."),
  destinationPath: TransferDestinationSchema,
}).strict();

export const ExtractArchiveInputSchema = z.object({
  archivePath: z.string().min(1).describe("Tar or gzip-compressed tar file, detected by content. Absolute or relative to session cwd."),
  destinationPath: TransferDestinationSchema,
}).strict();

export const DeleteFileInputSchema = FilePathSchema.extend({});

abstract class FileTool<TSchema extends z.ZodTypeAny> extends ZodTool<TSchema> {
  constructor() {
    super();
    if (canonicalFileToolConstructors.has(new.target)) canonicalFileTools.add(this);
  }

  override readonly source = "builtin" as const;
  readonly resolveHostCeilingMs = () =>
    resolveWorkloadBrokerExecutorCeilingMs(
      TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
    );
  readonly pathFields: readonly string[] = ["path"];

  protected executionTransport(
    input: z.infer<TSchema>,
    ctx: ToolExecutionContext,
  ): Promise<FileExecutionTransport> {
    return resolveFileExecutionTransport(this, input, ctx);
  }

  protected resolvePath(inputPath: string, ctx: ToolExecutionContext): string {
    const expanded = expandLeadingTilde(inputPath);
    return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);
  }

  protected resolveExecutionPath(
    inputPath: string,
    ctx: ToolExecutionContext,
    transport: Exclude<FileExecutionTransport, { readonly kind: "failure" }>,
  ): Result<string> {
    try {
      return {
        ok: true,
        value: transport.kind === "broker"
          ? transport.runtime.resolveBrokeredWorkloadPath(transport.capability, inputPath)
          : this.resolvePath(inputPath, ctx),
      };
    } catch (error) {
      return {
        ok: false,
        error: brokerFailureResult(errorMessage(error)),
      };
    }
  }

  /**
   * The tool's own copy of Layers 0 and 1, run again at execute time.
   *
   * `effect` is required rather than defaulted: this gate is what a tool
   * asserts about its own operand, and a default would silently give a new
   * write tool the read boundary. Layer 0 runs for both effects — a protected
   * path stays unreadable — and only the directory boundary is asymmetric.
   * {@link pathEffectIsConfined} is the same predicate the permission layer
   * asked before dispatching here, so this re-check cannot refuse an operand
   * the executor had already admitted.
   */
  protected ensureAllowed(
    path: string,
    ctx: ToolExecutionContext,
    effect: PathEffect,
  ): ToolExecutionResult | null {
    return ensureFileAccess(path, ctx, effect);
  }

  protected resolveApprovalPath(inputPath: string, ctx: Pick<ToolExecutionContext, "cwd"> | undefined): string {
    if (!ctx?.cwd) {
      throw new Error(`${this.name} approvalCacheKey requires explicit cwd`);
    }
    const expanded = expandLeadingTilde(inputPath);
    return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);
  }

  protected requireStringField(input: unknown, field: string): string {
    if (!input || typeof input !== "object") {
      throw new Error(`${this.name} approvalCacheKey requires object input`);
    }
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${this.name} approvalCacheKey requires '${field}' string`);
    }
    return value;
  }
}

export class ReadFileTool extends FileTool<typeof ReadFileInputSchema> {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file from the workspace. Returns a header line (path, line range, total lines) " +
    "followed by the lines, each prefixed with its 1-based line number and a tab; the prefix is not part " +
    "of the file. Use the zero-based offset and limit to page through large files; a result that would " +
    "exceed the size limit stops early and names the offset to continue from, and a very long line is cut " +
    "with a note on reading the rest. A file must be read in this session before edit_file, multi_edit, " +
    "apply_patch or write_file may change it, and must be unchanged since. In the disposable workload the " +
    "read is still required, but a change made there after the read is not detected.";
  readonly inputSchema = ReadFileInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ReadFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      const read = await transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.read",
        brokerFilePayload({ path: target, offset: input.offset, limit: input.limit }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
      const sessionId = sessionIdOf(ctx);
      if (!read.isError && sessionId !== undefined) {
        recordFileRead(sessionId, workloadFileReadKey(target), { mtimeMs: 0, size: 0, sha256: null });
      }
      return read;
    }
    const blocked = this.ensureAllowed(target, ctx, "read");
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`read_file requires a regular file: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`read_file refused binary file: ${target}`);
    }

    const window = await readTextFileWindow(target, input.offset, input.limit);
    const whole = await hashAndCountLines(target);
    const shown = fitReadWindow(target, input.offset, window.lines, whole.lineCount);
    const sessionId = sessionIdOf(ctx);
    if (sessionId !== undefined) {
      recordFileRead(sessionId, await fileReadKey(target), {
        mtimeMs: fileStat.value.mtimeMs,
        size: whole.size,
        sha256: whole.sha256,
      });
    }
    return {
      output: shown.output,
      isError: false,
      metadata: {
        path: target,
        truncated: window.truncated || shown.lineCount < window.lines.length,
        lineCount: shown.lineCount,
        totalLines: whole.lineCount,
        ...(shown.linesCut > 0 ? { linesCut: shown.linesCut } : {}),
      },
    };
  }
}

const LINE_NUMBER_WIDTH = 6;
/** Longest line text shown in full; a longer line is cut and says how to read the rest. */
const MAX_READ_LINE_CHARS = 2_000;

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function cutLine(path: string, line: string, lineNo: number, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)} [line ${lineNo} cut: showing ${maxChars} of ${line.length} characters; ` +
    `read the rest with: sed -n '${lineNo}p' ${shellQuote(path)} | cut -c${maxChars + 1}-]`;
}

function renderNumberedRead(
  path: string,
  offset: number,
  lines: readonly string[],
  totalLines: number,
  continuation: string | null,
  maxLineChars: number = MAX_READ_LINE_CHARS,
): string {
  if (lines.length === 0) {
    return totalLines === 0
      ? `${path} (empty file)`
      : `${path} (no lines at offset ${offset}; the file has ${totalLines} lines)`;
  }
  const first = offset + 1;
  const last = offset + lines.length;
  const numbered = lines.map((line, index) =>
    `${String(first + index).padStart(LINE_NUMBER_WIDTH)}\t${cutLine(path, line, first + index, maxLineChars)}`,
  );
  const body = `${path} (lines ${first}-${last} of ${totalLines})\n${numbered.join("\n")}`;
  return continuation === null ? body : `${body}\n${continuation}`;
}

/**
 * The requested window, shortened to the longest prefix whose rendering fits
 * the per-result size limit (measured with the conversation's own rule), with
 * a closing line naming the offset to continue from. Lines longer than
 * {@link MAX_READ_LINE_CHARS} are cut with a note on reading the rest; when
 * even the first cut line does not fit, it is cut shorter until it does.
 */
function fitReadWindow(
  path: string,
  offset: number,
  lines: readonly string[],
  totalLines: number,
): { output: string; lineCount: number; linesCut: number } {
  const linesCutIn = (count: number, maxChars: number): number =>
    lines.slice(0, count).filter((line) => line.length > maxChars).length;
  const full = renderNumberedRead(path, offset, lines, totalLines, null);
  if (!trimOversizedToolResult(full).truncated) {
    return { output: full, lineCount: lines.length, linesCut: linesCutIn(lines.length, MAX_READ_LINE_CHARS) };
  }
  const continuation = (count: number): string | null =>
    count === lines.length
      ? null
      : `[Stopped at the result size limit after line ${offset + count}; continue with offset=${offset + count}.]`;
  const render = (count: number, maxChars = MAX_READ_LINE_CHARS): string =>
    renderNumberedRead(path, offset, lines.slice(0, count), totalLines, continuation(count), maxChars);
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (trimOversizedToolResult(render(mid)).truncated) high = mid - 1;
    else low = mid;
  }
  if (low > 0) return { output: render(low), lineCount: low, linesCut: linesCutIn(low, MAX_READ_LINE_CHARS) };
  // Not even the first line fits at the default cut: cut it shorter.
  let fewest = 0;
  let most = MAX_READ_LINE_CHARS;
  while (fewest < most) {
    const mid = Math.ceil((fewest + most) / 2);
    if (trimOversizedToolResult(render(1, mid)).truncated) most = mid - 1;
    else fewest = mid;
  }
  return { output: render(1, Math.max(fewest, 1)), lineCount: 1, linesCut: 1 };
}

/**
 * The disposable-workload form of the read requirement. The host sees only
 * the window the workload returned, so it can require that the session read
 * the file but cannot detect a change made inside the workload since.
 */
function requireWorkloadRead(
  toolName: string,
  guestPath: string,
  ctx: ToolExecutionContext,
): ToolErrorResult | null {
  const sessionId = sessionIdOf(ctx);
  if (sessionId !== undefined && lookupFileRead(sessionId, workloadFileReadKey(guestPath)) !== undefined) {
    return null;
  }
  return toolError(`${toolName} refused to change ${guestPath}: read it with read_file in this session first.`);
}

function sessionIdOf(ctx: ToolExecutionContext): string | undefined {
  const sessionId = ctx.metadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Admit a change to an existing file only when this session read it and its
 * bytes still hash to what was read (or last written by an edit tool).
 */
async function requireFreshRead(
  toolName: string,
  target: string,
  ctx: ToolExecutionContext,
  current: { readonly sha256: string; readonly mtimeMs: number },
): Promise<Result<{ sessionId: string; key: string }>> {
  const sessionId = sessionIdOf(ctx);
  if (sessionId === undefined) {
    return {
      ok: false,
      error: toolError(
        `${toolName} refused to change ${target}: changing an existing file requires a session that records read_file calls.`,
      ),
    };
  }
  const key = await fileReadKey(target);
  const record = lookupFileRead(sessionId, key);
  if (record === undefined) {
    return {
      ok: false,
      error: toolError(
        `${toolName} refused to change ${target}: read it with read_file in this session first.`,
      ),
    };
  }
  if (record.sha256 === null || record.sha256 !== current.sha256) {
    return {
      ok: false,
      error: toolError(
        `${toolName} refused to change ${target}: the file changed after it was read ` +
        `(read at modification time ${new Date(record.mtimeMs).toISOString()}, now ` +
        `${new Date(current.mtimeMs).toISOString()}). Read it again with read_file before changing it.`,
      ),
    };
  }
  return { ok: true, value: { sessionId, key } };
}

/** After an edit tool's own write, the model has seen the new content. */
async function recordOwnWrite(sessionId: string, target: string, content: string): Promise<void> {
  const written = await stat(target);
  recordFileRead(sessionId, await fileReadKey(target), {
    mtimeMs: written.mtimeMs,
    size: written.size,
    sha256: sha256Hex(Buffer.from(content, "utf8")),
  });
}

const READ_LINE_NUMBER_PREFIX = /^ *\d+\t/;

/**
 * Remove `read_file` line-number prefixes copied into edit text by mistake.
 * Returns null unless every line carries one, so ordinary text that happens
 * to start with digits and a tab on some lines is never rewritten.
 */
function stripReadLineNumbers(text: string): string | null {
  const lines = text.split("\n");
  const trailingEmpty = lines.length > 1 && lines[lines.length - 1] === "";
  const body = trailingEmpty ? lines.slice(0, -1) : lines;
  if (body.length === 0 || !body.every((line) => READ_LINE_NUMBER_PREFIX.test(line))) return null;
  const stripped = body.map((line) => line.replace(READ_LINE_NUMBER_PREFIX, ""));
  return (trailingEmpty ? [...stripped, ""] : stripped).join("\n");
}

/**
 * The file's line separator when every separator in it is the same non-`\n`
 * one. `read_file` shows lines, not separators, so edit text copied from it
 * uses `\n` even for such a file.
 */
function uniformNonLfSeparator(content: string): "\r\n" | "\r" | null {
  const crlf = content.includes("\r\n");
  const loneCr = /\r(?!\n)/.test(content);
  const loneLf = /(?<!\r)\n/.test(content);
  if (crlf && !loneCr && !loneLf) return "\r\n";
  if (loneCr && !crlf && !loneLf) return "\r";
  return null;
}

/**
 * The replacement pair to apply. The text as given wins when it occurs in the
 * file. Otherwise, in order: the pair with copied `read_file` line-number
 * prefixes removed, then either pair with `\n` written as the file's own
 * uniform separator. The first candidate that occurs is used; when none does,
 * the pair is returned unchanged so the caller reports it as not found.
 */
function resolveReplacementText(
  content: string,
  oldText: string,
  newText: string,
): { oldText: string; newText: string } {
  const candidates = [{ oldText, newText }];
  const strippedOld = stripReadLineNumbers(oldText);
  if (strippedOld !== null && strippedOld.length > 0) {
    candidates.push({ oldText: strippedOld, newText: stripReadLineNumbers(newText) ?? newText });
  }
  const separator = uniformNonLfSeparator(content);
  if (separator !== null) {
    for (const candidate of [...candidates]) {
      if (!candidate.oldText.includes("\n") || candidate.oldText.includes("\r")) continue;
      candidates.push({
        oldText: candidate.oldText.replaceAll("\n", separator),
        newText: candidate.newText.includes("\r")
          ? candidate.newText
          : candidate.newText.replaceAll("\n", separator),
      });
    }
  }
  return candidates.find((candidate) => countOccurrences(content, candidate.oldText) > 0)
    ?? { oldText, newText };
}

export const ViewImageInputSchema = FilePathSchema.extend({
  maxBytes: ImagePreparationOptionsSchema.shape.maxBytes.describe("Maximum derived image bytes. Lower this when the active transport reports a smaller image budget; it does not raise the source file read limit."),
  maxDimension: ImagePreparationOptionsSchema.shape.maxDimension.describe("Maximum output width and height in pixels, preserving aspect ratio. Lower this to request a smaller image."),
});

/**
 * `view_image` — load a local image file into the model's context so it can see
 * it. Reuses the same path-scope security as read_file (resolvePath +
 * ensureAllowed). The image rides {@link ToolExecutionResult.image}; the text `output` is
 * a placeholder, and the selected transport sends the image through its native
 * visual input.
 */
export class ViewImageTool extends FileTool<typeof ViewImageInputSchema> {
  readonly name = "view_image";
  override readonly awaitCancellationSettlement = true as const;
  readonly description =
    "Read and validate a local PNG, JPEG, GIF or WebP image and return a resized visual copy. " +
    "The source is unchanged. The first frame is shown with orientation corrected. " +
    "Optional maxBytes and maxDimension request a smaller result after a transport size error. " +
    "Other formats must first be converted with an available image conversion tool.";
  readonly inputSchema = ViewImageInputSchema;
  override readonly resolveHostCeilingMs = () =>
    resolveWorkloadBrokerExecutorCeilingMs(
      TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
      TOOL_TIMEOUT_POLICY.imagePreparationMs,
    );
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ViewImageInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      const binary = await transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.read_binary",
        brokerFilePayload({ path: target, maxBytes: IMAGE_PREPARATION_POLICY.maxInputBytes }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
      if (binary.isError) return binary;
      if (!("data" in binary)) {
        return brokerFailureResult("binary response was missing validated image bytes");
      }
      try {
        const prepared = await prepareImageBytes(
          Buffer.from(binary.data, "base64"),
          { maxBytes: input.maxBytes, maxDimension: input.maxDimension },
          ctx.abortSignal,
        );
        const { data, ...details } = prepared;
        return {
          output: JSON.stringify({ path: target, ...details, loaded: true }),
          isError: false,
          image: {
            data,
            mimeType: prepared.mimeType,
            bytes: prepared.bytes,
            width: prepared.width,
            height: prepared.height,
          },
        };
      } catch (error) {
        return toolError(`view_image: ${errorMessage(error)}`);
      }
    }
    const blocked = this.ensureAllowed(target, ctx, "read");
    if (blocked) return blocked;

    try {
      const prepared = await prepareImageFile(target, {
        cwd: ctx.cwd, extraAllowedDirectories: [...ctx.extraAllowedDirectories],
        blockReadsOutsideWorkingDirectories: ctx.blockReadsOutsideWorkingDirectories === true,
      }, { maxBytes: input.maxBytes, maxDimension: input.maxDimension }, ctx.abortSignal);
      const { data, ...details } = prepared;
      return {
        output: JSON.stringify({ path: target, ...details, loaded: true }),
        isError: false,
        image: { data, mimeType: prepared.mimeType, bytes: prepared.bytes, width: prepared.width, height: prepared.height },
      };
    } catch (error) {
      return toolError(`view_image: ${errorMessage(error)}`);
    }
  }
}

export class ListFilesTool extends FileTool<typeof ListFilesInputSchema> {
  readonly name = "list_files";
  readonly description =
    "List files and directories under a workspace path. Returns bounded, depth-limited entries.";
  readonly inputSchema = ListFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ListFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const root = resolved.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.list",
        brokerFilePayload({ path: root, depth: input.depth, limit: input.limit }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(root, ctx, "read");
    if (blocked) return blocked;

    const listed = await listEntries(root, input.depth, input.limit);
    if (!listed.ok) return listed.error;
    return {
      output: JSON.stringify({
        path: root,
        entries: listed.value.entries,
        truncated: listed.value.truncated,
      }),
      isError: false,
      metadata: { path: root, truncated: listed.value.truncated },
    };
  }
}

export class GlobFilesTool extends FileTool<typeof GlobFilesInputSchema> {
  readonly name = "glob_files";
  readonly description =
    "Find files by glob pattern under the workspace. Searches paths, not file contents.";
  readonly inputSchema = GlobFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof GlobFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path ?? ".", ctx, transport);
    if (!resolved.ok) return resolved.error;
    const root = resolved.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.glob",
        brokerFilePayload({ path: root, pattern: input.pattern, limit: input.limit }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(root, ctx, "read");
    if (blocked) return blocked;

    const regex = globToRegExp(input.pattern);
    const listed = await collectFiles(root, MAX_SCAN_FILES);
    if (!listed.ok) return listed.error;
    const allMatches = listed.value.files
      .filter((entry) => regex.test(entry.relativePath))
      .map((entry) => entry.path);
    const matches = allMatches.slice(0, input.limit);
    return {
      output: JSON.stringify({
        path: root,
        pattern: input.pattern,
        matches,
        truncated: listed.value.truncated || allMatches.length > input.limit,
      }),
      isError: false,
      metadata: { path: root, pattern: input.pattern, matchCount: matches.length },
    };
  }
}

export class GrepFilesTool extends FileTool<typeof GrepFilesInputSchema> {
  readonly name = "grep_files";
  readonly description =
    "Search UTF-8 text files by JavaScript regular expression. Returns bounded file/line matches.";
  readonly inputSchema = GrepFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof GrepFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path ?? ".", ctx, transport);
    if (!resolved.ok) return resolved.error;
    const root = resolved.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.grep",
        brokerFilePayload({
          path: root,
          pattern: input.pattern,
          ...(input.include === undefined ? {} : { include: input.include }),
          caseSensitive: input.caseSensitive,
          limit: input.limit,
        }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(root, ctx, "read");
    if (blocked) return blocked;

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true };
    }

    const include = input.include ? globToRegExp(input.include) : null;
    const listed = await collectFiles(root, MAX_SCAN_FILES);
    if (!listed.ok) return listed.error;

    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of listed.value.files) {
      if (include && !include.test(file.relativePath)) continue;
      if (matches.length >= input.limit) break;
      const maybeMatches = await grepFile(file.path, regex, input.limit - matches.length);
      if (!maybeMatches.ok) continue;
      matches.push(...maybeMatches.value);
    }

    return {
      output: JSON.stringify({
        path: root,
        pattern: input.pattern,
        include: input.include,
        matches,
        truncated: matches.length >= input.limit || listed.value.truncated,
      }),
      isError: false,
      metadata: { path: root, matchCount: matches.length },
    };
  }
}

export class WriteFileTool extends FileTool<typeof WriteFileInputSchema> {
  readonly name = "write_file";
  readonly description =
    "Create or overwrite a UTF-8 text file. Parent directories are created automatically. " +
    "Overwriting an existing file requires reading it with read_file in this session first. In the " +
    "disposable workload write_file cannot tell whether the file exists, so it does not require a read there.";
  readonly inputSchema = WriteFileInputSchema;
  override readonly category: ToolCategory = "write";

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

  protected async executeTyped(
    input: z.infer<typeof WriteFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.write",
        brokerFilePayload({ path: target, content: input.content }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(target, ctx, "write");
    if (blocked) return blocked;

    const existing = await statExistingPath(target);
    if (!existing.ok) return existing.error;
    let readSession: string | undefined;
    if (existing.value !== null) {
      if (!existing.value.isFile()) {
        return toolError(`write_file requires a regular file target: ${target}`);
      }
      const { sha256 } = await hashAndCountLines(target);
      const fresh = await requireFreshRead(this.name, target, ctx, {
        sha256,
        mtimeMs: existing.value.mtimeMs,
      });
      if (!fresh.ok) return fresh.error;
      readSession = fresh.value.sessionId;
    } else {
      readSession = sessionIdOf(ctx);
    }

    // Read existing content for diff sidecar (best-effort — missing file = empty before).
    // Guard: skip pre-image read for large or binary files to avoid OOM / mojibake.
    // Mirrors the EditFileTool / ApplyPatchTool pattern exactly.
    let before = "";
    let skipSidecar = false;
    // Open the file once and bind stat + read to the same inode handle to
    // eliminate the TOCTOU window between stat() and readFile().
    const fh = await open(target, "r").catch(() => null);
    if (fh !== null) {
      try {
        const fhStat = await fh.stat();
        if (fhStat.size > MAX_TEXT_FILE_BYTES) {
          skipSidecar = true;
        } else {
          // Size verified ≤ MAX_TEXT_FILE_BYTES on this exact handle.
          // A concurrent truncate between fh.stat() and fh.readFile() can
          // shrink the read result but cannot grow it past the cap, so the
          // OOM bound holds — the file descriptor binds the inode, not the
          // data length.
          before = await fh.readFile("utf8");
        }
      } finally {
        await fh.close();
      }
      // isBinaryFile reopens the file internally but is bounded by its own
      // limit; acceptable as a secondary guard after the size check passes.
      if (!skipSidecar && (await isBinaryFile(target))) {
        skipSidecar = true;
        before = "";
      }
    }
    const after = input.content;

    await mkdir(dirname(target), { recursive: true });
    await atomicTextWrite(target, after);
    if (readSession !== undefined) await recordOwnWrite(readSession, target, after);

    // Write diff sidecar when either side exceeds the preview limit.
    const sessionId =
      typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : "";
    const toolUseId =
      typeof ctx.metadata?.toolUseId === "string" ? ctx.metadata.toolUseId : "";
    let hasSidecar = false;
    if (!skipSidecar && sessionId && toolUseId) {
      // writeDiffSidecar logs failures internally via its own createLogger.
      // auditWarn callback is a no-op here; failures keep truncated state
      // visible in the UI without a silent fallback.
      hasSidecar = await writeDiffSidecar(sessionId, toolUseId, before, after, () => {});
    }

    const beforeBytes = Buffer.byteLength(before, "utf8");
    const afterBytes = Buffer.byteLength(after, "utf8");
    const truncated =
      beforeBytes > WRITE_DIFF_PREVIEW_LIMIT || afterBytes > WRITE_DIFF_PREVIEW_LIMIT;

    return {
      output: JSON.stringify({
        path: target,
        bytes: afterBytes,
        ...(truncated ? { truncated: true, hasSidecar } : {}),
      }),
      isError: false,
      metadata: { path: target, ...(truncated ? { truncated: true, hasSidecar } : {}) },
    };
  }
}

export class EditFileTool extends FileTool<typeof EditFileInputSchema> {
  readonly name = "edit_file";
  readonly description =
    "Replace exact text in an existing UTF-8 file. Fails when the match is missing or ambiguous. " +
    "The file must have been read with read_file in this session and be unchanged since (in the " +
    "disposable workload only the read is checked); do not include read_file's line-number prefixes " +
    "in oldText or newText.";
  readonly inputSchema = EditFileInputSchema;
  override readonly category: ToolCategory = "write";

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

  protected async executeTyped(
    input: z.infer<typeof EditFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      const read = requireWorkloadRead(this.name, target, ctx);
      if (read) return read;
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.edit",
        brokerFilePayload({
          path: target,
          oldText: input.oldText,
          newText: input.newText,
          replaceAll: input.replaceAll,
        }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(target, ctx, "write");
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`edit_file requires a regular file: ${target}`);
    }
    if (fileStat.value.size > MAX_TEXT_FILE_BYTES) {
      return toolError(`edit_file refused large file > ${MAX_TEXT_FILE_BYTES} bytes: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`edit_file refused binary file: ${target}`);
    }

    const bytes = await readFile(target);
    const fresh = await requireFreshRead(this.name, target, ctx, {
      sha256: sha256Hex(bytes),
      mtimeMs: fileStat.value.mtimeMs,
    });
    if (!fresh.ok) return fresh.error;
    const current = bytes.toString("utf8");
    const { oldText, newText } = resolveReplacementText(current, input.oldText, input.newText);
    const occurrences = countOccurrences(current, oldText);
    if (occurrences === 0) {
      return toolError(`edit_file oldText not found in ${target}`);
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        output: `edit_file oldText matched ${occurrences} times in ${target}; set replaceAll=true for intentional global replacement`,
        isError: true,
      };
    }

    const next = input.replaceAll
      ? current.split(oldText).join(newText)
      : current.replace(oldText, () => newText);
    await atomicTextWrite(target, next);
    await recordOwnWrite(fresh.value.sessionId, target, next);
    return {
      output: JSON.stringify({ path: target, replacements: input.replaceAll ? occurrences : 1 }),
      isError: false,
      metadata: { path: target, replacements: input.replaceAll ? occurrences : 1 },
    };
  }
}

export class MultiEditTool extends FileTool<typeof MultiEditInputSchema> {
  readonly name = "multi_edit";
  readonly description =
    "Apply one or more exact text replacements to an existing UTF-8 file, in order. Fails before writing " +
    "when any replacement is missing or ambiguous. The file must have been read with read_file in this " +
    "session and be unchanged since (in the disposable workload only the read is checked); do not " +
    "include read_file's line-number prefixes in the text.";
  readonly inputSchema = MultiEditInputSchema;
  override readonly category: ToolCategory = "write";

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

  protected async executeTyped(
    input: z.infer<typeof MultiEditInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      const read = requireWorkloadRead(this.name, target, ctx);
      if (read) return read;
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.patch",
        brokerFilePayload({ path: target, replacements: input.replacements }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(target, ctx, "write");
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`multi_edit requires a regular file: ${target}`);
    }
    if (fileStat.value.size > MAX_TEXT_FILE_BYTES) {
      return toolError(`multi_edit refused large file > ${MAX_TEXT_FILE_BYTES} bytes: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`multi_edit refused binary file: ${target}`);
    }

    const bytes = await readFile(target);
    const fresh = await requireFreshRead(this.name, target, ctx, {
      sha256: sha256Hex(bytes),
      mtimeMs: fileStat.value.mtimeMs,
    });
    if (!fresh.ok) return fresh.error;
    let next = bytes.toString("utf8");
    let totalReplacements = 0;
    for (const [index, replacement] of input.replacements.entries()) {
      const { oldText, newText } = resolveReplacementText(next, replacement.oldText, replacement.newText);
      const occurrences = countOccurrences(next, oldText);
      if (occurrences === 0) {
        return toolError(`multi_edit replacement ${index + 1} oldText not found in ${target}`);
      }
      if (occurrences > 1 && !replacement.replaceAll) {
        return toolError(
          `multi_edit replacement ${index + 1} oldText matched ${occurrences} times in ${target}; set replaceAll=true for intentional global replacement`,
        );
      }
      totalReplacements += replacement.replaceAll ? occurrences : 1;
      next = replacement.replaceAll
        ? next.split(oldText).join(newText)
        : next.replace(oldText, () => newText);
    }

    await atomicTextWrite(target, next);
    await recordOwnWrite(fresh.value.sessionId, target, next);
    return {
      output: JSON.stringify({ path: target, replacements: totalReplacements }),
      isError: false,
      metadata: { path: target, replacements: totalReplacements },
    };
  }
}

type PlannedPatchChange =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly destination: string;
      readonly content: string;
    };

const PATCH_CHANGE_LETTER = { add: "A", delete: "D", update: "M" } as const;

export class ApplyPatchTool extends FileTool<typeof ApplyPatchInputSchema> {
  readonly name = "apply_patch";
  readonly description =
    "Add, update, move or delete one or more UTF-8 text files with a single patch. Every section is " +
    "validated before any file is written. Files being updated or deleted must have been read with " +
    "read_file in this session and be unchanged since. Paths are absolute or relative to the session cwd. " +
    "Not available in the disposable workload.";
  readonly inputSchema = ApplyPatchInputSchema;
  override readonly category: ToolCategory = "write";
  /** The target paths are the files the patch text names. */
  override readonly pathFields: readonly string[] = [`patch${PATCH_ENVELOPE_PATH_FIELD_SUFFIX}`];

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    const operations = this.parseOrThrow(this.requireStringField(input, "patch"));
    const paths = patchOperationPaths(operations)
      .map((path) => this.resolveApprovalPath(path, ctx))
      .sort();
    return JSON.stringify({ operation: this.name, paths });
  }

  private parseOrThrow(patch: string): readonly PatchFileOperation[] {
    const parsed = parsePatchEnvelope(patch);
    if (!parsed.ok) throw new Error(`apply_patch: invalid patch: ${parsed.error}`);
    return parsed.operations;
  }

  protected async executeTyped(
    input: z.infer<typeof ApplyPatchInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    if (transport.kind === "broker") {
      return brokerFailureResult(
        "apply_patch is not available in the disposable workload; use multi_edit, edit_file or write_file",
      );
    }
    const parsed = parsePatchEnvelope(input.patch);
    if (!parsed.ok) return toolError(`apply_patch: invalid patch: ${parsed.error}`);

    const planned: PlannedPatchChange[] = [];
    const touched = new Set<string>();
    // Compared by resolved file, so two spellings of one file (a symlink, a
    // case variant) cannot slip past as separate sections.
    const claim = async (path: string): Promise<ToolErrorResult | null> => {
      const key = await fileReadKey(path);
      if (touched.has(key)) {
        return toolError(`apply_patch: ${path} appears in more than one section; combine them into one`);
      }
      touched.add(key);
      return null;
    };
    for (const operation of parsed.operations) {
      const target = this.resolvePath(operation.path, ctx);
      const blocked = this.ensureAllowed(target, ctx, "write");
      if (blocked) return blocked;
      const duplicate = await claim(target);
      if (duplicate) return duplicate;
      const existing = await statExistingPath(target);
      if (!existing.ok) return existing.error;

      if (operation.kind === "add") {
        if (existing.value !== null) {
          return toolError(`apply_patch: cannot add ${target}: it already exists; use '*** Update File:'`);
        }
        planned.push({ kind: "add", path: target, content: operation.content });
        continue;
      }
      if (existing.value === null || !existing.value.isFile()) {
        return toolError(`apply_patch: ${target} is not an existing regular file`);
      }
      if (operation.kind === "delete") {
        const { sha256 } = await hashAndCountLines(target);
        const fresh = await requireFreshRead(this.name, target, ctx, {
          sha256,
          mtimeMs: existing.value.mtimeMs,
        });
        if (!fresh.ok) return fresh.error;
        planned.push({ kind: "delete", path: target });
        continue;
      }

      let destination = target;
      if (operation.moveTo !== null) {
        destination = this.resolvePath(operation.moveTo, ctx);
        const destinationBlocked = this.ensureAllowed(destination, ctx, "write");
        if (destinationBlocked) return destinationBlocked;
        if (destination !== target) {
          const destinationDuplicate = await claim(destination);
          if (destinationDuplicate) return destinationDuplicate;
          const destinationStat = await statExistingPath(destination);
          if (!destinationStat.ok) return destinationStat.error;
          if (destinationStat.value !== null) {
            return toolError(`apply_patch: cannot move ${target} to ${destination}: the destination exists`);
          }
        }
      }
      if (existing.value.size > MAX_TEXT_FILE_BYTES) {
        return toolError(`apply_patch refused large file > ${MAX_TEXT_FILE_BYTES} bytes: ${target}`);
      }
      if (await isBinaryFile(target)) {
        return toolError(`apply_patch refused binary file: ${target}`);
      }
      const bytes = await readFile(target);
      const fresh = await requireFreshRead(this.name, target, ctx, {
        sha256: sha256Hex(bytes),
        mtimeMs: existing.value.mtimeMs,
      });
      if (!fresh.ok) return fresh.error;
      const applied = applyPatchChunks(bytes.toString("utf8"), operation.chunks);
      if (!applied.ok) return toolError(`apply_patch: ${target}: ${applied.error}`);
      planned.push({ kind: "update", path: target, destination, content: applied.content });
    }

    const sessionId = sessionIdOf(ctx);
    const summary: string[] = [];
    for (const change of planned) {
      if (change.kind === "delete") {
        if (sessionId !== undefined) forgetFileRead(sessionId, await fileReadKey(change.path));
        await unlink(change.path);
        summary.push(`${PATCH_CHANGE_LETTER.delete} ${change.path}`);
        continue;
      }
      const written = change.kind === "add" ? change.path : change.destination;
      await mkdir(dirname(written), { recursive: true });
      await atomicTextWrite(written, change.content);
      if (change.kind === "update" && change.destination !== change.path) {
        if (sessionId !== undefined) forgetFileRead(sessionId, await fileReadKey(change.path));
        await unlink(change.path);
      }
      if (sessionId !== undefined) await recordOwnWrite(sessionId, written, change.content);
      summary.push(
        change.kind === "update" && change.destination !== change.path
          ? `${PATCH_CHANGE_LETTER.update} ${change.path} -> ${change.destination}`
          : `${PATCH_CHANGE_LETTER[change.kind]} ${written}`,
      );
    }
    return {
      output: `Applied patch:\n${summary.join("\n")}`,
      isError: false,
      metadata: {
        paths: planned.map((change) => change.kind === "update" ? change.destination : change.path),
      },
    };
  }
}

export class MoveFileTool extends FileTool<typeof MoveFileInputSchema> {
  readonly name = "move_file";
  readonly description =
    "Move or rename a regular file within the workspace. Parent directories are created automatically.";
  readonly inputSchema = MoveFileInputSchema;
  override readonly category: ToolCategory = "write";
  override readonly pathFields = ["sourcePath", "destinationPath"] as const;

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    const source = this.resolveApprovalPath(this.requireStringField(input, "sourcePath"), ctx);
    const destination = this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx);
    return `source:${source}:destination:${destination}`;
  }

  protected async executeTyped(
    input: z.infer<typeof MoveFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolvedSource = this.resolveExecutionPath(input.sourcePath, ctx, transport);
    if (!resolvedSource.ok) return resolvedSource.error;
    const resolvedDestination = this.resolveExecutionPath(input.destinationPath, ctx, transport);
    if (!resolvedDestination.ok) return resolvedDestination.error;
    const source = resolvedSource.value;
    const destination = resolvedDestination.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.move",
        brokerFilePayload({
          sourcePath: source,
          destinationPath: destination,
          overwrite: input.overwrite,
        }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const sourceBlocked = this.ensureAllowed(source, ctx, "write");
    if (sourceBlocked) return sourceBlocked;
    const destinationBlocked = this.ensureAllowed(destination, ctx, "write");
    if (destinationBlocked) return destinationBlocked;

    const sourceStat = await statFile(source);
    if (!sourceStat.ok) return sourceStat.error;
    if (!sourceStat.value.isFile()) {
      return toolError(`move_file requires a regular source file: ${source}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    if (input.overwrite) {
      const destinationStat = await statExistingPath(destination);
      if (!destinationStat.ok) return destinationStat.error;
      if (destinationStat.value && !destinationStat.value.isFile()) {
        return toolError(`move_file destination is not a regular file: ${destination}`);
      }
      await rename(source, destination);
    } else {
      const moved = await noClobberMoveFile(source, destination);
      if (!moved.ok) return moved.error;
    }
    return {
      output: JSON.stringify({ sourcePath: source, destinationPath: destination }),
      isError: false,
      metadata: { sourcePath: source, destinationPath: destination },
    };
  }
}

export class CopyPathTool extends FileTool<typeof CopyPathInputSchema> {
  readonly name = "copy_path";
  readonly description =
    "Copy a regular binary/text file or a complete directory tree to a new destination within admitted workspace roots. The destination parent must exist; existing destinations, links and special entries are rejected. Uses owner-only POSIX mode bits where supported and preserves the source owner's executable bit; does not copy ACLs. The destination may be visible during work; success means the complete copy finished.";
  readonly inputSchema = CopyPathInputSchema;
  override readonly category: ToolCategory = "write";
  override readonly pathFields = ["sourcePath", "destinationPath"] as const;
  override readonly awaitCancellationSettlement = true as const;

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return JSON.stringify({
      operation: this.name,
      sourcePath: this.resolveApprovalPath(this.requireStringField(input, "sourcePath"), ctx),
      destinationPath: this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx),
    });
  }

  protected async executeTyped(
    input: z.infer<typeof CopyPathInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolvedSource = this.resolveExecutionPath(input.sourcePath, ctx, transport);
    if (!resolvedSource.ok) return resolvedSource.error;
    const resolvedDestination = this.resolveExecutionPath(input.destinationPath, ctx, transport);
    if (!resolvedDestination.ok) return resolvedDestination.error;
    const sourcePath = resolvedSource.value;
    const destinationPath = resolvedDestination.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.copy",
        brokerFilePayload({ sourcePath, destinationPath }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    return fileTransferExecutionResult(await copyPath({
      sourcePath,
      destinationPath,
    }, ctx));
  }
}

export class ExtractArchiveTool extends FileTool<typeof ExtractArchiveInputSchema> {
  readonly name = "extract_archive";
  readonly description =
    "Extract a tar or gzip-compressed tar archive to a new directory within admitted workspace roots. The destination parent must exist. Rejects existing destinations, unsafe paths, links, unsupported entries and malformed archives. ZIP and archive creation are unsupported. Uses owner-only POSIX mode bits where supported and preserves only each file member's owner executable bit; does not copy ACLs. Success means the complete archive was processed without skipped members.";
  readonly inputSchema = ExtractArchiveInputSchema;
  override readonly category: ToolCategory = "write";
  override readonly pathFields = ["archivePath", "destinationPath"] as const;
  override readonly awaitCancellationSettlement = true as const;

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return JSON.stringify({
      operation: this.name,
      archivePath: this.resolveApprovalPath(this.requireStringField(input, "archivePath"), ctx),
      destinationPath: this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx),
      formats: ["tar", "tar.gz"],
    });
  }

  protected async executeTyped(
    input: z.infer<typeof ExtractArchiveInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolvedArchive = this.resolveExecutionPath(input.archivePath, ctx, transport);
    if (!resolvedArchive.ok) return resolvedArchive.error;
    const resolvedDestination = this.resolveExecutionPath(input.destinationPath, ctx, transport);
    if (!resolvedDestination.ok) return resolvedDestination.error;
    const archivePath = resolvedArchive.value;
    const destinationPath = resolvedDestination.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.extract",
        brokerFilePayload({ archivePath, destinationPath }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    let archiveFormat: ArchiveFormat | undefined;
    const result = await runOwnedTransfer({
      sourcePath: archivePath,
      destinationPath,
      destinationKind: "directory",
    }, ctx, async (session) => {
      const source = await session.openSourceFile(session.sourcePath);
      archiveFormat = (await consumeTarArchive(source, session.sink, {
        signal: session.signal,
        limits: session.limits,
      })).format;
    });
    if (result.ok) {
      if (archiveFormat === undefined) {
        throw new Error("extract_archive completed without a recognized archive format");
      }
      result.summary.archiveFormat = archiveFormat;
    }
    return fileTransferExecutionResult(result);
  }
}

function fileTransferExecutionResult(result: TransferResult): ToolExecutionResult {
  const output = result.ok ? result : {
    ok: false,
    cleanup: result.cleanup,
    code: result.code,
    ...(result.residualPaths ? { residualPaths: result.residualPaths } : {}),
    message: result.message,
    ...(result.cleanupErrors ? { cleanupErrors: result.cleanupErrors } : {}),
  };
  return { output: JSON.stringify(output), isError: !result.ok };
}

export class DeleteFileTool extends FileTool<typeof DeleteFileInputSchema> {
  readonly name = "delete_file";
  readonly description = "Delete a regular file from the workspace.";
  readonly inputSchema = DeleteFileInputSchema;
  override readonly category: ToolCategory = "write";

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

  protected async executeTyped(
    input: z.infer<typeof DeleteFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return transport.result;
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return resolved.error;
    const target = resolved.value;
    if (transport.kind === "broker") {
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.delete",
        brokerFilePayload({ path: target }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    const blocked = this.ensureAllowed(target, ctx, "write");
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`delete_file requires a regular file: ${target}`);
    }
    await unlink(target);
    return {
      output: JSON.stringify({ path: target, deleted: true }),
      isError: false,
      metadata: { path: target, deleted: true },
    };
  }
}

const canonicalFileToolConstructors = new Set<Function>([
  ReadFileTool,
  ViewImageTool,
  ListFilesTool,
  GlobFilesTool,
  GrepFilesTool,
  WriteFileTool,
  EditFileTool,
  MultiEditTool,
  ApplyPatchTool,
  CopyPathTool,
  ExtractArchiveTool,
  MoveFileTool,
  DeleteFileTool,
]);

export function createFileTools(): Tool[] {
  return [
    new ReadFileTool(),
    new ViewImageTool(),
    new ListFilesTool(),
    new GlobFilesTool(),
    new GrepFilesTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new MultiEditTool(),
    new ApplyPatchTool(),
    new CopyPathTool(),
    new ExtractArchiveTool(),
    new MoveFileTool(),
    new DeleteFileTool(),
  ];
}

export type CanonicalFileTool =
  | ReadFileTool
  | ViewImageTool
  | ListFilesTool
  | GlobFilesTool
  | GrepFilesTool
  | WriteFileTool
  | EditFileTool
  | MultiEditTool
  | ApplyPatchTool
  | CopyPathTool
  | ExtractArchiveTool
  | MoveFileTool
  | DeleteFileTool;

/** Exact host-created identity check; tool names are deliberately irrelevant. */
export function isCanonicalFileTool(tool: unknown): tool is CanonicalFileTool {
  return typeof tool === "object" && tool !== null && canonicalFileTools.has(tool);
}

/**
 * Normalize authority-bound input through the exact canonical instance schema.
 * The caller must use the returned value when hashing/minting an execution
 * grant so Zod defaults and unknown-key behavior match the eventual execute.
 */
export function normalizeCanonicalFileToolInput(tool: unknown, rawInput: unknown): unknown {
  if (!isCanonicalFileTool(tool)) {
    throw new Error("Canonical file tool input requires a host-created file tool");
  }
  return tool.inputSchema.parse(rawInput);
}

async function statFile(path: string): Promise<Result<Stats>> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
}

async function statExistingPath(path: string): Promise<Result<Stats | null>> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: null };
    }
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
}

interface ListedEntry {
  path: string;
  relativePath: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  mtimeMs?: number;
}

async function listEntries(
  root: string,
  depth: number,
  limit: number,
): Promise<Result<{ entries: ListedEntry[]; truncated: boolean }>> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return { ok: false, error: toolError(`list_files requires a directory: ${root}`) };
    }
    const entries: ListedEntry[] = [];
    const state = { visited: 0, truncated: false };
    await walk(root, root, depth, limit, entries, { filesOnly: false }, state);
    const truncated = entries.length >= limit || state.truncated;
    return { ok: true, value: { entries, truncated } };
  } catch (err) {
    return { ok: false, error: toolError(`list_files failed: ${(err as Error).message}`) };
  }
}

async function collectFiles(
  root: string,
  limit: number,
): Promise<Result<{ files: ListedEntry[]; truncated: boolean }>> {
  try {
    const rootStat = await stat(root);
    const files: ListedEntry[] = [];
    const state = { visited: 0, truncated: false };
    if (sensitiveFilePattern(root)) {
      return { ok: true, value: { files, truncated: false } };
    }
    if (rootStat.isFile()) {
      files.push({
        path: root,
        relativePath: root.split(sep).pop() ?? root,
        type: "file",
        size: rootStat.size,
        mtimeMs: rootStat.mtimeMs,
      });
    } else if (rootStat.isDirectory()) {
      await walk(root, root, MAX_LIST_DEPTH, limit, files, { filesOnly: true }, state);
    } else {
      return { ok: false, error: toolError(`file search requires a file or directory: ${root}`) };
    }
    return { ok: true, value: { files, truncated: files.length >= limit || state.truncated } };
  } catch (err) {
    return { ok: false, error: toolError(`file search failed: ${(err as Error).message}`) };
  }
}

async function walk(
  root: string,
  current: string,
  remainingDepth: number,
  limit: number,
  output: ListedEntry[],
  opts: { filesOnly: boolean },
  state: { visited: number; truncated: boolean },
): Promise<void> {
  if (output.length >= limit || remainingDepth < 1 || state.truncated) return;
  const dirents = await readdir(current, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (output.length >= limit || state.truncated) return;
    state.visited += 1;
    if (state.visited > MAX_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }
    const full = join(current, dirent.name);
    if (sensitiveFilePattern(full)) {
      continue;
    }
    const rel = normalizeRelativePath(relative(root, full));
    const type = dirent.isDirectory()
      ? "directory"
      : dirent.isFile()
        ? "file"
        : dirent.isSymbolicLink()
          ? "symlink"
          : "other";
    if (!opts.filesOnly || type === "file") {
      const entryStat = type === "file" ? await stat(full) : null;
      output.push({
        path: full,
        relativePath: rel,
        type,
        ...(entryStat ? { size: entryStat.size, mtimeMs: entryStat.mtimeMs } : {}),
      });
    }
    if (dirent.isDirectory() && remainingDepth > 1 && !DEFAULT_SKIP_DIRS.has(dirent.name)) {
      await walk(root, full, remainingDepth - 1, limit, output, opts, state);
    }
  }
}

async function noClobberMoveFile(source: string, destination: string): Promise<Result<null>> {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await unlink(source);
    return { ok: true, value: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { ok: false, error: toolError(`move_file destination exists; set overwrite=true to replace: ${destination}`) };
    }
    return { ok: false, error: toolError(`move_file failed: ${(err as Error).message}`) };
  }
}

async function grepFile(
  path: string,
  regex: RegExp,
  limit: number,
): Promise<Result<Array<{ path: string; line: number; text: string }>>> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) {
    return { ok: true, value: [] };
  }
  if (await isBinaryFile(path)) {
    return { ok: true, value: [] };
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 1;
  try {
    for await (const line of rl) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({ path, line: lineNo, text: line });
        if (matches.length >= limit) break;
      }
      lineNo += 1;
    }
  } finally {
    rl.close();
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
  return { ok: true, value: matches };
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function temporaryWritePath(target: string): string {
  return `${target}.ave-tmp-${process.pid}-${randomUUID()}`;
}

async function atomicTextWrite(target: string, content: string): Promise<void> {
  const temp = temporaryWritePath(target);
  try {
    await writeFile(temp, content, "utf8");
    await renameWithTransientRetry(temp, target);
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // Best effort cleanup: preserve the original write/rename failure.
    }
    throw err;
  }
}

/**
 * Attempt budget for a tool write: a turn is waiting on it, so it neither
 * blocks the main thread (sync budget) nor runs unattended (background
 * budget). The curve and the retryable codes are the shared policy.
 */
const TOOL_WRITE_RENAME_ATTEMPTS = 6;

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const retryable = code !== undefined
        && RENAME_FILE_LOCK_CODES.has(code)
        && attempt < TOOL_WRITE_RENAME_ATTEMPTS;
      if (!retryable) throw err;
      await sleep(transientFsLockDelayMs(attempt));
    }
  }
}

function toolError(output: string): ToolErrorResult {
  return { output, isError: true };
}
