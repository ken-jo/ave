import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolExecutionResult } from "./base.js";
import { admissionDeniedFilePattern, sensitiveFilePattern } from "./file-access-policy.js";
import { buildSafeChildEnv } from "./safe-env.js";
import { resolvePinnedRipgrepExecutable } from "./ripgrep-executable.js";
import { forceKillManagedChildProcess, spawnManaged } from "../main/managed-child-processes.js";
import { errorMessage } from "../shared/error-message.js";

// Use only the pinned bundled search binary under an already-authorized root.
// Check every descendant result against sensitive-path policy before exposing text to the model.

const GREP_DEFAULT_LIMIT = 200;
const GREP_MAX_LIMIT = 1_000;
const MAX_CONTEXT_LINES = 20;
/** Long lines (minified bundles) print a preview instead of the whole line. */
const MAX_LINE_COLUMNS = 500;
/** One output record can never exceed this; a longer one means rg broke its own column cap. */
const MAX_PENDING_RECORD_BYTES = 64 * 1024;
const MAX_STDERR_CHARS = 4_000;

export const GrepFilesInputSchema = z.object({
  pattern: z.string().min(1).describe(
    "Regular expression in ripgrep (Rust regex) syntax, e.g. `log.*Error` or `function\\s+\\w+`. "
      + "Escape regex metacharacters for literal text (`interface\\{\\}` finds `interface{}`).",
  ),
  path: z.string().min(1).optional().describe(
    "File or directory to search, absolute or relative to the session cwd. Defaults to the session cwd.",
  ),
  include: z.string().min(1).optional().describe(
    "Glob filter on file paths (ripgrep --glob), e.g. `*.ts`, `**/*.{ts,tsx}`, `src/**/test_*.py`.",
  ),
  type: z.string().regex(/^[A-Za-z0-9_+-]+$/).optional().describe(
    "ripgrep file type, e.g. `ts`, `py`, `rust`, `go`, `java`, `md`. Often faster than an include glob.",
  ),
  caseSensitive: z.boolean().default(true).describe("Set false for a case-insensitive search (ripgrep -i)."),
  outputMode: z.enum(["content", "files_with_matches", "count"]).default("content").describe(
    "`content` (default) returns matching lines with line numbers; `files_with_matches` returns only file paths; "
      + "`count` returns the number of matching lines per file.",
  ),
  context: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(
    "Lines of context before and after each match (ripgrep -C). `content` mode only.",
  ),
  contextBefore: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(
    "Lines of context before each match (ripgrep -B). `content` mode only.",
  ),
  contextAfter: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(
    "Lines of context after each match (ripgrep -A). `content` mode only.",
  ),
  multiline: z.boolean().default(false).describe(
    "Let the pattern span lines and `.` match newlines (ripgrep -U --multiline-dotall).",
  ),
  limit: z.number().int().min(1).max(GREP_MAX_LIMIT).default(GREP_DEFAULT_LIMIT).describe(
    "Maximum entries to return: output lines in `content` mode, files in the other modes.",
  ),
  offset: z.number().int().min(0).default(0).describe(
    "Entries to skip before applying limit; pass the `nextOffset` of a truncated result to continue.",
  ),
});

export type GrepFilesInput = z.infer<typeof GrepFilesInputSchema>;

export const GREP_FILES_DESCRIPTION = [
  "Search file contents with ripgrep. Use this instead of running grep or rg through the shell.",
  "Respects .gitignore/.ignore files, searches hidden files except .git, skips binary files and protected paths.",
  "Pattern syntax is ripgrep's Rust regex (no lookaround or backreferences).",
  "outputMode: `content` (default) shows matching lines as `line: text` grouped by file, with optional context lines",
  "(`line- text`); `files_with_matches` lists paths only — cheapest when you just need where something occurs;",
  "`count` gives matching-line counts per file. Narrow with `path`, `include` (glob) or `type`.",
  "Results are sorted by path and paged by `limit`/`offset`; a truncated result says which offset to pass next.",
].join(" ");

/** Options the workload broker's legacy `file.grep` payload cannot carry. */
export function grepOptionsUnsupportedByBroker(input: GrepFilesInput): string[] {
  const unsupported: string[] = [];
  if (input.type !== undefined) unsupported.push("type");
  if (input.outputMode !== "content") unsupported.push("outputMode");
  if (input.context !== undefined) unsupported.push("context");
  if (input.contextBefore !== undefined) unsupported.push("contextBefore");
  if (input.contextAfter !== undefined) unsupported.push("contextAfter");
  if (input.multiline) unsupported.push("multiline");
  if (input.offset !== 0) unsupported.push("offset");
  return unsupported;
}

class RipgrepUnavailableError extends Error {
  constructor() {
    super(
      "grep_files is unavailable: the bundled ripgrep executable is missing for this platform. "
        + "Reinstall Ave; the search engine ships inside the @vscode/ripgrep platform package.",
    );
    this.name = "RipgrepUnavailableError";
  }
}

export function resolveBundledRipgrep(): string {
  return resolvePinnedRipgrepExecutable(() => new RipgrepUnavailableError());
}

export function buildRipgrepArgs(root: string, input: GrepFilesInput): string[] {
  const args = [
    // Ignore user search configuration so flags such as --pre cannot execute arbitrary programs.
    "--no-config",
    "--color=never",
    "--hidden",
    "--glob=!.git",
    "--sort=path",
    // A single-file root would otherwise print records without the path.
    "--with-filename",
    "--null",
  ];
  if (!input.caseSensitive) args.push("--ignore-case");
  if (input.multiline) args.push("--multiline", "--multiline-dotall");
  if (input.include !== undefined) args.push(`--glob=${input.include}`);
  if (input.type !== undefined) args.push(`--type=${input.type}`);
  switch (input.outputMode) {
    case "files_with_matches":
      args.push("--files-with-matches");
      break;
    case "count":
      args.push("--count");
      break;
    case "content":
      args.push(
        "--no-heading",
        "--line-number",
        `--max-columns=${MAX_LINE_COLUMNS}`,
        "--max-columns-preview",
      );
      if (input.context !== undefined) args.push(`--context=${input.context}`);
      if (input.contextBefore !== undefined) args.push(`--before-context=${input.contextBefore}`);
      if (input.contextAfter !== undefined) args.push(`--after-context=${input.contextAfter}`);
      break;
  }
  // Delimit patterns and paths so leading hyphens cannot become flags.
  args.push("--regexp", input.pattern, "--", root);
  return args;
}

type ContentLine = { readonly line: number; readonly kind: "match" | "context"; readonly text: string };
type GrepEntry =
  | { readonly kind: "line"; readonly path: string; readonly value: ContentLine }
  | { readonly kind: "gap"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "count"; readonly path: string; readonly count: number };

function parseRecord(record: string, mode: GrepFilesInput["outputMode"]): GrepEntry | null {
  if (mode === "files_with_matches") {
    return record.length === 0 ? null : { kind: "file", path: record };
  }
  if (mode === "content" && record === "--") return { kind: "gap", path: "" };
  const nul = record.indexOf("\0");
  if (nul <= 0) return null;
  const path = record.slice(0, nul);
  const rest = record.slice(nul + 1);
  if (mode === "count") {
    const count = Number(rest);
    return Number.isSafeInteger(count) ? { kind: "count", path, count } : null;
  }
  const parsed = /^(\d+)([:-])/.exec(rest);
  if (!parsed) return null;
  return {
    kind: "line",
    path,
    value: {
      line: Number(parsed[1]),
      kind: parsed[2] === ":" ? "match" : "context",
      text: rest.slice(parsed[0].length).replace(/\r$/, ""),
    },
  };
}

interface RipgrepRun {
  readonly entries: GrepEntry[];
  readonly more: boolean;
  readonly exitCode: number | null;
  readonly stderr: string;
}

// A grep result path is inside the admitted secret root when it equals the root
// or sits beneath it at a separator boundary. ripgrep echoes result paths under
// the search root in the root's own spelling, so on win32 both carry backslashes
// — fold `\` to `/` there before comparing. Fold ONLY on win32: on POSIX a
// backslash is a legal filename byte, not a separator, so folding it would admit
// a sibling literally named `.ssh\id_rsa` into the `.ssh` root. Case is NOT
// folded on either platform: ripgrep preserves the root's case, and case-folding
// would widen a per-directory case-sensitive admission (`.ssh` must not admit
// `.SSH`). The `root + "/"` boundary keeps a prefix-sharing sibling (`.ssh-other`)
// out; a trailing-separator root yields a `//` boundary and so admits nothing.
export function isWithinAdmittedRoot(
  entryPath: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = (p: string): string => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  const foldedRoot = fold(root);
  const foldedPath = fold(entryPath);
  return foldedPath === foldedRoot || foldedPath.startsWith(foldedRoot + "/");
}

function runRipgrep(
  executable: string,
  args: string[],
  cwd: string,
  input: GrepFilesInput,
  signal: AbortSignal | undefined,
  explicitSecretRoot?: string,
): Promise<RipgrepRun> {
  signal?.throwIfAborted();
  const wanted = input.offset + input.limit + 1;
  const separator = input.outputMode === "files_with_matches" ? "\0" : "\n";
  const child = spawnManaged(executable, args, {
    cwd,
    env: buildSafeChildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }, { label: "grep-files-ripgrep" });

  return new Promise((resolve, reject) => {
    const entries: GrepEntry[] = [];
    let counted = 0;
    let pending = "";
    let stderr = "";
    let stoppedEarly = false;
    let failure: Error | undefined;
    let termination: void | Promise<void>;
    const decoder = new TextDecoder("utf-8");

    const stop = (error?: Error): void => {
      if (error) failure ??= error;
      termination = forceKillManagedChildProcess(child, "grep-files-stop");
    };
    const onAbort = (): void => {
      stop(signal?.reason instanceof Error ? signal.reason : new Error("grep_files was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const accept = (record: string): void => {
      if (stoppedEarly || failure) return;
      const entry = parseRecord(record, input.outputMode);
      if (entry === null) return;
      // Check every result path: the search engine does not know the host's sensitive-path floor.
      if (entry.kind !== "gap") {
        const explicit = explicitSecretRoot !== undefined && isWithinAdmittedRoot(entry.path, explicitSecretRoot);
        if (admissionDeniedFilePattern(entry.path) !== null || (!explicit && sensitiveFilePattern(entry.path) !== null)) return;
      }
      if (entry.kind === "gap") {
        entries.push(entry);
        return;
      }
      // Every non-gap record is one entry: a line in content mode, a file otherwise.
      counted += 1;
      entries.push(entry);
      if (counted >= wanted) {
        stoppedEarly = true;
        stop();
      }
    };

    const consume = (text: string): void => {
      pending += text;
      let index = pending.indexOf(separator);
      while (index !== -1) {
        accept(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf(separator);
      }
      if (pending.length > MAX_PENDING_RECORD_BYTES) {
        stop(new Error("grep_files: ripgrep produced an unbounded output record."));
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => consume(decoder.decode(chunk, { stream: true })));
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.once("error", (error) => {
      failure ??= new Error(`grep_files could not start ripgrep: ${error.message}`);
      if (child.pid) stop();
    });
    child.once("close", async (code) => {
      if (termination) await termination;
      signal?.removeEventListener("abort", onAbort);
      consume(decoder.decode());
      if (pending.length > 0 && !stoppedEarly) accept(pending);
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ entries, more: stoppedEarly, exitCode: stoppedEarly ? 0 : code, stderr: stderr.trim() });
    });
  });
}

/** Group entries into numbered pages; content-mode gaps never count as entries. */
function paginate(entries: GrepEntry[], offset: number, limit: number): GrepEntry[] {
  const page: GrepEntry[] = [];
  let index = -1;
  for (const entry of entries) {
    if (entry.kind === "gap") {
      if (index >= offset && index < offset + limit) page.push(entry);
      continue;
    }
    index += 1;
    if (index >= offset + limit) break;
    if (index >= offset) page.push(entry);
  }
  return page;
}

// Render numbered match/context lines under each file, using -- for nonadjacent gaps.
function render(page: GrepEntry[]): string {
  const lines: string[] = [];
  let currentPath: string | undefined;
  let gapPending = false;
  for (const entry of page) {
    switch (entry.kind) {
      case "file":
        lines.push(entry.path);
        break;
      case "count":
        lines.push(`${entry.path}: ${entry.count}`);
        break;
      case "gap":
        gapPending = currentPath !== undefined;
        break;
      case "line":
        if (entry.path !== currentPath) {
          if (currentPath !== undefined) lines.push("");
          lines.push(entry.path);
          currentPath = entry.path;
        } else if (gapPending) {
          lines.push("  --");
        }
        gapPending = false;
        lines.push(`  ${entry.value.line}${entry.value.kind === "match" ? ":" : "-"} ${entry.value.text}`);
        break;
    }
  }
  return lines.join("\n");
}

function grepError(output: string): ToolExecutionResult {
  return { output, isError: true };
}

// Search under an authorized root; production always resolves the bundled executable.
export async function searchWithRipgrep(
  root: string,
  input: GrepFilesInput,
  signal: AbortSignal | undefined,
  resolveExecutable: () => string = resolveBundledRipgrep,
): Promise<ToolExecutionResult> {
  if (admissionDeniedFilePattern(root) !== null) {
    return { output: `Searched ${root}.\n\nNo matches found.`, isError: false, metadata: { path: root, matchCount: 0 } };
  }
  let cwd: string;
  try {
    const rootStat = await stat(root);
    if (!rootStat.isFile() && !rootStat.isDirectory()) {
      return grepError(`grep_files requires a file or directory: ${root}`);
    }
    cwd = rootStat.isDirectory() ? root : dirname(root);
  } catch (error) {
    return grepError(`grep_files: cannot search ${root}: ${errorMessage(error)}`);
  }

  let executable: string;
  try {
    executable = resolveExecutable();
  } catch (error) {
    return grepError(errorMessage(error));
  }

  let run: RipgrepRun;
  try {
    run = await runRipgrep(executable, buildRipgrepArgs(root, input), cwd, input, signal, sensitiveFilePattern(root) !== null ? root : undefined);
  } catch (error) {
    return grepError(errorMessage(error));
  }

  // Exit 1 means no matches; exit 2 can follow partial matches and still indicates failure.
  const hasResults = run.entries.some((entry) => entry.kind !== "gap");
  if (run.exitCode !== 0 && run.exitCode !== 1 && !hasResults) {
    return grepError(`grep_files failed: ${run.stderr || `ripgrep exited with code ${String(run.exitCode)}`}`);
  }

  const page = paginate(run.entries, input.offset, input.limit);
  const shown = page.filter((entry) => entry.kind !== "gap").length;
  const fileCount = new Set(page.filter((entry) => entry.kind !== "gap").map((entry) => entry.path)).size;
  const notes: string[] = [];
  if (run.more) {
    notes.push(
      `[Truncated: more results exist. Pass offset=${input.offset + input.limit} for the next page, `
        + "or narrow the search with path, include or type.]",
    );
  }
  if (run.exitCode === 2) {
    notes.push(`[Some paths could not be searched: ${run.stderr.split("\n", 1)[0] ?? "ripgrep reported an error"}]`);
  }

  const body = shown === 0
    ? (input.offset > 0 && hasResults ? `No results at offset ${input.offset}.` : "No matches found.")
    : render(page);
  const header = shown === 0
    ? `Searched ${root}.`
    : `Searched ${root}: ${describeCount(input.outputMode, shown, fileCount)}`
      + (input.offset > 0 ? ` (from offset ${input.offset})` : "") + ".";
  return {
    output: [header, body, ...notes].join("\n\n"),
    isError: false,
    metadata: {
      path: root,
      matchCount: shown,
      truncated: run.more,
      ...(run.more ? { nextOffset: input.offset + input.limit } : {}),
    },
  };
}

function describeCount(mode: GrepFilesInput["outputMode"], shown: number, files: number): string {
  if (mode === "content") return `${shown} line${shown === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  return `${shown} file${shown === 1 ? "" : "s"}`;
}
