import { noteOwnedWrite, terminalFileEvidence, writtenFileIdentity, type WrittenFileIdentity } from "../main/terminal/changed-file-evidence.js";
import { checkpointFileMutation, markCodeCheckpointUnavailable } from "../memory/code-checkpoints.js";
import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as pathResolve,
  sep,
} from "node:path";
import { z } from "zod";

import type { PathEffect } from "../permissions/allowed-directories.js";
import type { ApprovalMemoryScope } from "../shared/permissions-events.js";
import { consumeExecutionGrantForBuiltinToolInvocation } from "../permissions/execution-router.js";
import {
  MAX_TEXT_FILE_BYTES,
  isBinaryFile,
  isGlobPattern,
  readTextFileWindow,
} from "./file-read-core.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { PATCH_ENVELOPE_PATH_FIELD_SUFFIX } from "../shared/dotted-field-value.js";
import { globToRegExp } from "../lib/glob-matcher.js";
import { writeDiffSidecar, WRITE_DIFF_PREVIEW_LIMIT } from "./write-diff-cache.js";
import { ensureFileAccess, sensitiveFilePattern } from "./file-access-policy.js";
import {
  GREP_FILES_DESCRIPTION,
  GrepFilesInputSchema,
  grepOptionsUnsupportedByBroker,
  searchWithRipgrep,
} from "./grep-search.js";
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
import { ReadDocumentInputSchema, OpenDocumentInputSchema, type ReadDocumentInput } from "./document-tool-input.js";
import { requestDocumentPanel } from "./document-panel-access.js";
import { documentToolFailure, formatDocumentToolOutput } from "./document-tool-output.js";
import { PREVIEW_DOCUMENT_LIMITS, previewDocumentFormatOf } from "../shared/preview-document.js";
import { previewPageFormatOf } from "../shared/preview-page-document.js";
import { acquireParseSlot } from "./preview-document-process.js";
import { readPreviewDocumentInput } from "./preview-document-input.js";
import { TableDocumentError } from "./table-document-error.js";
import { DOCUMENT_PARSE_MESSAGES } from "./preview-document-protocol.js";
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

// Match builtin file tools by object identity; copied names and schemas cannot enter this set.
const canonicalFileTools = new WeakSet<object>();

// Pass the invocation's host-owned deadline to every broker request so transport defaults cannot shorten it.
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

  // Recheck sensitive paths and directory scope at execution; require explicit effect so new writes cannot inherit read access.
  // Both effects retain protected-path denial; only directory confinement differs.
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

// Fit the longest rendered line prefix into the result budget and report continuation offsets.
// Clip long lines further when even the first preview cannot fit.
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
  let fewest = 0;
  let most = MAX_READ_LINE_CHARS;
  while (fewest < most) {
    const mid = Math.ceil((fewest + most) / 2);
    if (trimOversizedToolResult(render(1, mid)).truncated) most = mid - 1;
    else fewest = mid;
  }
  return { output: render(1, Math.max(fewest, 1)), lineCount: 1, linesCut: 1 };
}

// Workload edits require a prior session read, but returned windows cannot prove the file stayed unchanged.
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

// Existing-file edits require a session read whose byte hash still matches.
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

/** After an edit tool's own write, the model has seen the new content; `identity` is what the write's descriptor saw. */
async function recordOwnWrite(sessionId: string, target: string, content: string, before: string | null | undefined, identity: WrittenFileIdentity | undefined): Promise<void> {
  await terminalFileEvidence.recordWrite(sessionId, target, before, identity);
  const written = await stat(target);
  recordFileRead(sessionId, await fileReadKey(target), {
    mtimeMs: written.mtimeMs,
    size: written.size,
    sha256: sha256Hex(Buffer.from(content, "utf8")),
  });
}

const READ_LINE_NUMBER_PREFIX = /^ *\d+\t/;

// Strip copied line-number prefixes only when every line has one, preserving ordinary digit-prefixed text.
function stripReadLineNumbers(text: string): string | null {
  const lines = text.split("\n");
  const trailingEmpty = lines.length > 1 && lines[lines.length - 1] === "";
  const body = trailingEmpty ? lines.slice(0, -1) : lines;
  if (body.length === 0 || !body.every((line) => READ_LINE_NUMBER_PREFIX.test(line))) return null;
  const stripped = body.map((line) => line.replace(READ_LINE_NUMBER_PREFIX, ""));
  return (trailingEmpty ? [...stripped, ""] : stripped).join("\n");
}

// Detect uniform non-LF separators so text copied from read_file can preserve the file's line endings.
function uniformNonLfSeparator(content: string): "\r\n" | "\r" | null {
  const crlf = content.includes("\r\n");
  const loneCr = /\r(?!\n)/.test(content);
  const loneLf = /(?<!\r)\n/.test(content);
  if (crlf && !loneCr && !loneLf) return "\r\n";
  if (loneCr && !crlf && !loneLf) return "\r";
  return null;
}

// Prefer exact text, then stripped line numbers, then uniform source separators; leave unmatched pairs unchanged.
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

// Local images share read_file path gates and travel through ToolExecutionResult.image in the native visual channel.
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

function documentPolicyFailure(denial: ToolExecutionResult): ToolExecutionResult {
  const error = denial.output.startsWith("Sensitive path:") ? "sensitive-path" : "path-not-allowed";
  return documentToolFailure(error, "Document read denied by file policy");
}

function documentRouteFailure(failure: ToolExecutionResult): ToolExecutionResult {
  return { ...documentToolFailure("unsupported-route", "Document execution route is unavailable"), metadata: failure.metadata };
}

export class ReadDocumentTool extends FileTool<typeof ReadDocumentInputSchema> {
  readonly name = "read_document";
  readonly description =
    "Read CSV, TSV, XLSX, XLS, ODS, PDF, PPTX, DOCX or ODT using bounded document extraction. " +
    "Select sheet (zero-based sheet and absolute row/column offsets; default 20 rows by 10 columns, " +
    "maximum 100 rows, 50 columns and 500 cells), page (one-based page, zero-based textOffset), " +
    "or info (ten sheet labels per call). Text results fit 6000 characters, 16 KiB and 1800 estimated tokens; " +
    "follow remainingWindows or nextTextOffset for more. Formulas are cached display values. " +
    "Page includeImage defaults false; true adds the existing rendered PNG as visual model context, " +
    "at most 2 MiB per call in a separate image budget. Image input consumes additional model context " +
    "and provider-dependent image tokens; omit it for text-only reading. PPTX, DOCX and ODT use text outlines without rendered images. " +
    "PDF text also requires the page renderer; no OCR or document editing. Does not open the side panel.";
  readonly inputSchema = ReadDocumentInputSchema;
  override readonly category: ToolCategory = "read";
  override readonly awaitCancellationSettlement = true as const;

  override isReadOnly(): boolean { return true; }

  override async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(rawInput);
    return parsed.success ? this.executeTyped(parsed.data, ctx) : documentToolFailure("invalid-arguments", "Invalid document selection or window");
  }

  protected async executeTyped(input: ReadDocumentInput, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (isGlobPattern(input.path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input.path)) {
      return documentToolFailure("not-a-file", "A concrete local file path is required");
    }
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return documentRouteFailure(transport.result);
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return documentRouteFailure(resolved.error);
    let target = resolved.value;
    if (transport.kind === "local") {
      const denied = this.ensureAllowed(target, ctx, "read");
      if (denied) return documentPolicyFailure(denied);
      try { target = await realpath(target); }
      catch { return documentToolFailure("read-failed", "Document could not be read"); }
      const canonicalDenied = this.ensureAllowed(target, ctx, "read");
      if (canonicalDenied) return documentPolicyFailure(canonicalDenied);
    }
    const format = previewDocumentFormatOf(target) ?? previewPageFormatOf(target);
    if (!format) return documentToolFailure("unsupported-format", "Unsupported document format");
    const table = previewDocumentFormatOf(target) !== null;
    if (input.selection && input.selection.kind !== "info" && (table !== (input.selection.kind === "sheet"))) {
      return documentToolFailure("invalid-arguments", "Selection does not match the document format");
    }
    const selection = input.selection ?? ReadDocumentInputSchema.parse({ path: target,
      selection: { kind: table ? "sheet" : "page" } }).selection!;
    const controller = new AbortController();
    const handleAbort = (): void => controller.abort(ctx.abortSignal?.reason);
    ctx.abortSignal?.addEventListener("abort", handleAbort, { once: true });
    if (ctx.abortSignal?.aborted) handleAbort();
    try {
      const slot = await acquireParseSlot(`agent-document:${randomUUID()}`, controller);
      try {
        let bytes: Buffer;
        if (transport.kind === "broker") {
          const result = await transport.runtime.executeBrokeredWorkloadRequest(transport.capability,
            "file.read_binary", brokerFilePayload({ path: target, maxBytes: PREVIEW_DOCUMENT_LIMITS.maxFileBytes }),
            transport.correlationAuthority, slot.signal);
          if (result.isError) return documentRouteFailure(result);
          if (!("data" in result)) return documentRouteFailure(brokerFailureResult("binary response was missing document bytes"));
          bytes = Buffer.from(result.data, "base64");
          if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes || bytes.toString("base64") !== result.data) {
            return documentRouteFailure(brokerFailureResult("invalid binary document response"));
          }
        } else {
          bytes = await readPreviewDocumentInput(target, slot.signal);
        }
        slot.signal.throwIfAborted();
        const index = selection.kind === "sheet" ? selection.sheet : selection.kind === "page" ? selection.page - 1 : 0;
        const window = selection.kind === "sheet" ? {
          rowOffset: selection.rowOffset, columnOffset: selection.columnOffset,
          rowCount: selection.rowCount, columnCount: selection.columnCount,
        } : table ? { rowCount: 1, columnCount: 1 } : undefined;
        const document = await slot.parse(bytes, format, index, window);
        slot.signal.throwIfAborted();
        return formatDocumentToolOutput(target, document, selection);
      } finally { slot.release(); }
    } catch (error) {
      if (controller.signal.aborted) return documentToolFailure("superseded", "Document read was canceled");
      if (error instanceof TableDocumentError) {
        const message = error.code in DOCUMENT_PARSE_MESSAGES
          ? DOCUMENT_PARSE_MESSAGES[error.code as keyof typeof DOCUMENT_PARSE_MESSAGES] : "Document could not be read";
        return documentToolFailure(error.code, message);
      }
      return documentToolFailure("read-failed", "Document could not be read");
    } finally { ctx.abortSignal?.removeEventListener("abort", handleAbort); }
  }
}

export class OpenDocumentTool extends FileTool<typeof OpenDocumentInputSchema> {
  readonly name = "open_document";
  readonly description =
    "Present a local CSV, TSV, XLSX, XLS, ODS, PDF, PPTX, DOCX, ODT, HWP or HWPX to the user. " +
    "HWP and HWPX require the optional document engine and compatible import runtime, and are not supported on macOS yet. " +
    "The user's document setting chooses direct side-panel opening or a clickable file link. " +
    "Uses ordinary read permissions without an additional prompt. Does not feed document contents to the model. " +
    "Requires the originating foreground session; unavailable headless or for isolated guest paths.";
  readonly inputSchema = OpenDocumentInputSchema;
  override readonly category: ToolCategory = "read";
  override isReadOnly(): boolean { return true; }

  override async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(rawInput);
    return parsed.success ? this.executeTyped(parsed.data, ctx) : documentToolFailure("invalid-arguments", "A document path is required");
  }

  protected async executeTyped(input: z.infer<typeof OpenDocumentInputSchema>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (isGlobPattern(input.path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input.path)) {
      return documentToolFailure("not-a-file", "A concrete local file path is required");
    }
    const transport = await this.executionTransport(input, ctx);
    if (transport.kind === "failure") return documentRouteFailure(transport.result);
    if (transport.kind === "broker") return documentToolFailure("unsupported-route", "Guest documents cannot be opened in the host panel");
    const resolved = this.resolveExecutionPath(input.path, ctx, transport);
    if (!resolved.ok) return documentRouteFailure(resolved.error);
    let target = resolved.value;
    const denied = this.ensureAllowed(target, ctx, "read");
    if (denied) return documentPolicyFailure(denied);
    try { target = await realpath(target); }
    catch { return documentToolFailure("read-failed", "Document could not be read"); }
    const canonicalDenied = this.ensureAllowed(target, ctx, "read");
    if (canonicalDenied) return documentPolicyFailure(canonicalDenied);
    if (!(previewDocumentFormatOf(target) ?? previewPageFormatOf(target))) {
      return documentToolFailure("unsupported-format", "Unsupported document format");
    }
    const file = await statFile(target);
    if (!file.ok || !file.value.isFile()) return documentToolFailure("not-a-file", "Document must be a regular file");
    return requestDocumentPanel(target, ctx);
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
  readonly description = GREP_FILES_DESCRIPTION;
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
      const unsupported = grepOptionsUnsupportedByBroker(input);
      if (unsupported.length > 0) {
        return toolError(
          `grep_files options not available under the workload broker: ${unsupported.join(", ")}. `
            + "Retry with pattern, path, include, caseSensitive and limit only.",
        );
      }
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
    return searchWithRipgrep(root, input, ctx.abortSignal);
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

  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return { kind: "path", path: this.resolveApprovalPath(this.requireStringField(input, "path"), ctx) };
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
      await markCodeCheckpointUnavailable();
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

    // Diff pre-images are best-effort; skip oversized or binary files to avoid excessive allocation and invalid text.
    let before = "";
    let skipSidecar = false;
    // Bind stat and read to one handle so pathname replacement cannot switch the inode between checks.
    const fh = await open(target, "r").catch(() => null);
    if (fh !== null) {
      try {
        const fhStat = await fh.stat();
        if (fhStat.size > MAX_TEXT_FILE_BYTES) {
          skipSidecar = true;
        } else {
          // The size check binds to this inode; concurrent truncation may shrink the read.
          before = await fh.readFile("utf8");
        }
      } finally {
        await fh.close();
      }
      // Binary sniffing reopens the path but retains its own bound after the size check.
      if (!skipSidecar && (await isBinaryFile(target))) {
        skipSidecar = true;
        before = "";
      }
    }
    const after = input.content;

    await mkdir(dirname(target), { recursive: true });
    const written = await atomicTextWrite(target, after);
    if (readSession !== undefined) await recordOwnWrite(readSession, target, after, skipSidecar ? undefined : existing.value === null ? null : before, written);

    const sessionId =
      typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : "";
    const toolUseId =
      typeof ctx.metadata?.toolUseId === "string" ? ctx.metadata.toolUseId : "";
    let hasSidecar = false;
    if (!skipSidecar && sessionId && toolUseId) {
      // Sidecar failures are logged internally and remain visible through truncated UI state.
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

  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return { kind: "path", path: this.resolveApprovalPath(this.requireStringField(input, "path"), ctx) };
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
      await markCodeCheckpointUnavailable();
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
    const written = await atomicTextWrite(target, next);
    await recordOwnWrite(fresh.value.sessionId, target, next, bytes.toString("utf8"), written);
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

  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return { kind: "path", path: this.resolveApprovalPath(this.requireStringField(input, "path"), ctx) };
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
      await markCodeCheckpointUnavailable();
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

    const written = await atomicTextWrite(target, next);
    await recordOwnWrite(fresh.value.sessionId, target, next, undefined, written);
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
    // Resolve file identity so symlink and case aliases cannot bypass duplicate-section checks.
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
        await checkpointFileMutation([{ path: change.path, content: null }], () => unlink(change.path));
        summary.push(`${PATCH_CHANGE_LETTER.delete} ${change.path}`);
        continue;
      }
      const written = change.kind === "add" ? change.path : change.destination;
      await mkdir(dirname(written), { recursive: true });
      const identity = await atomicTextWrite(written, change.content);
      if (change.kind === "update" && change.destination !== change.path) {
        if (sessionId !== undefined) forgetFileRead(sessionId, await fileReadKey(change.path));
        await checkpointFileMutation([{ path: change.path, content: null }], () => unlink(change.path));
      }
      if (sessionId !== undefined) await recordOwnWrite(sessionId, written, change.content, undefined, identity);
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

  // An approved plain move must never authorize overwriting an existing destination.
  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return {
      kind: "transfer",
      sourcePath: this.resolveApprovalPath(this.requireStringField(input, "sourcePath"), ctx),
      destinationPath: this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx),
      overwrite: (input as Record<string, unknown>).overwrite === true,
    };
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
      await markCodeCheckpointUnavailable();
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
    let moved: WrittenFileIdentity | undefined;
    const result = await checkpointFileMutation([
      { path: source, content: null },
      { path: destination, copyFrom: source },
    ], async () => {
      await mkdir(dirname(destination), { recursive: true });
      if (input.overwrite) {
        const destinationStat = await statExistingPath(destination);
        if (!destinationStat.ok) return destinationStat.error;
        if (destinationStat.value && !destinationStat.value.isFile()) {
          return toolError(`move_file destination is not a regular file: ${destination}`);
        }
        // The rename moves the inode this descriptor holds; a source replaced before the rename moves another file,
        // which the evidence then refuses.
        const held = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          moved = writtenFileIdentity(await held.stat({ bigint: true }));
          noteOwnedWrite(destination, moved);
          await rename(source, destination);
        } finally { await held.close(); }
      } else {
        // copyFile creates the destination without a descriptor Ave holds, so the evidence records no identity.
        const copied = await noClobberMoveFile(source, destination);
        if (!copied.ok) return copied.error;
        noteOwnedWrite(destination, undefined);
      }
      return {
        output: JSON.stringify({ sourcePath: source, destinationPath: destination }),
        isError: false,
        metadata: { sourcePath: source, destinationPath: destination },
      };
    });
    const sessionId = sessionIdOf(ctx);
    if (sessionId !== undefined && !result.isError) await terminalFileEvidence.recordWrite(sessionId, destination, undefined, moved);
    return result;
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

  // Strict schema forbids overwrite of existing destinations.
  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return {
      kind: "transfer",
      sourcePath: this.resolveApprovalPath(this.requireStringField(input, "sourcePath"), ctx),
      destinationPath: this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx),
      overwrite: false,
    };
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
      await markCodeCheckpointUnavailable();
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.copy",
        brokerFilePayload({ sourcePath, destinationPath }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    await markCodeCheckpointUnavailable();
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

  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return {
      kind: "transfer",
      sourcePath: this.resolveApprovalPath(this.requireStringField(input, "archivePath"), ctx),
      destinationPath: this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx),
      overwrite: false,
    };
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
      await markCodeCheckpointUnavailable();
      return transport.runtime.executeBrokeredWorkloadRequest(
        transport.capability,
        "file.extract",
        brokerFilePayload({ archivePath, destinationPath }),
        transport.correlationAuthority,
        ctx.abortSignal,
      );
    }
    await markCodeCheckpointUnavailable();
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

  approvalMemoryScope(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): ApprovalMemoryScope {
    return { kind: "path", path: this.resolveApprovalPath(this.requireStringField(input, "path"), ctx) };
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
      await markCodeCheckpointUnavailable();
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
    await checkpointFileMutation([{ path: target, content: null }], () => unlink(target));
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
  ReadDocumentTool,
  OpenDocumentTool,
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
    new ReadDocumentTool(),
    new OpenDocumentTool(),
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
  | ReadDocumentTool
  | OpenDocumentTool
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

// Host-created object identity is authoritative, never the tool name.
export function isCanonicalFileTool(tool: unknown): tool is CanonicalFileTool {
  return typeof tool === "object" && tool !== null && canonicalFileTools.has(tool);
}

// Hash and mint grants from canonical-schema output so defaults and unknown-key handling match execution.
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

export async function collectFiles(
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

/** Writes `content` to `target` through a temporary file, returning the identity its own descriptor saw. */
async function atomicTextWrite(target: string, content: string): Promise<WrittenFileIdentity | undefined> {
  return checkpointFileMutation([{ path: target, content }], () => writeTextAtomically(target, content));
}

async function writeTextAtomically(target: string, content: string): Promise<WrittenFileIdentity | undefined> {
  const temp = temporaryWritePath(target);
  try {
    // The descriptor that wrote the bytes names the file; the rename moves that inode to the target. Anything that
    // replaces the temporary path or the target in between is a different inode, which the evidence then refuses.
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666);
    let identity: WrittenFileIdentity | undefined;
    try {
      await handle.writeFile(content, "utf8");
      identity = writtenFileIdentity(await handle.stat({ bigint: true }));
    } finally { await handle.close(); }
    noteOwnedWrite(target, identity);
    await renameWithTransientRetry(temp, target);
    return identity;
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // Best effort cleanup: preserve the original write/rename failure.
    }
    throw err;
  }
}

// Tool writes use the shared asynchronous retry policy, distinct from synchronous and unattended budgets.
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
