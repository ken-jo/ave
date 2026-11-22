import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { ToolExecutionResult } from "./base.js";
import { admissionDeniedFilePattern, createFilePathPolicy, createStageWorkspacesSkip, sensitiveFilePattern } from "./file-access-policy.js";
import { isSensitiveContent, judgedPathNamesOpenedFile, KEY_MATERIAL_SCAN_BYTES } from "../permissions/sensitive-paths.js";
import { buildSafeChildEnv } from "./safe-env.js";
import { resolvePinnedRipgrepExecutable } from "./ripgrep-executable.js";
import { forceKillManagedChildProcess, spawnManaged } from "../main/managed-child-processes.js";
import { errorMessage } from "../shared/error-message.js";

// Use only the pinned bundled search binary under an already-authorized root.
// The search over the tree only names the files that match. Each one is then judged on its real path and read by the host
// through one handle bound to that path, and ripgrep matches again on exactly those bytes: no line, count or match that the
// tree search read itself reaches the model.

const GREP_DEFAULT_LIMIT = 200;
const GREP_MAX_LIMIT = 1_000;
const MAX_CONTEXT_LINES = 20;
/** Long lines (minified bundles) print a preview instead of the whole line. */
const MAX_LINE_COLUMNS = 500;
/** One output record can never exceed this; a longer one means rg broke its own column cap. */
const MAX_PENDING_RECORD_BYTES = 64 * 1024;
/** How much of a matching file the host reads at a time to hand it to the search. */
const BOUND_READ_CHUNK_BYTES = 64 * 1024;
/** Listed files whose bound search runs while earlier results are still being taken. */
const BOUND_SEARCHES_AHEAD = 8;
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

/**
 * The search over the tree: it lists, in path order, the files whose contents match, with their counts in count mode, so
 * that the files listed are the ones it would count (none for a binary file it finds in a folder). Only their names are
 * used.
 */
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
    "--line-buffered",
  ];
  pushMatchArgs(args, input);
  if (input.include !== undefined) args.push(`--glob=${input.include}`);
  if (input.type !== undefined) args.push(`--type=${input.type}`);
  args.push(input.outputMode === "count" ? "--count" : "--files-with-matches");
  // Delimit patterns and paths so leading hyphens cannot become flags.
  args.push("--regexp", input.pattern, "--", root);
  return args;
}

/** The search over one file's bytes, which the host reads and writes to its standard input. */
function buildRipgrepStdinArgs(input: GrepFilesInput): string[] {
  const args = ["--no-config", "--color=never"];
  pushMatchArgs(args, input);
  switch (input.outputMode) {
    case "files_with_matches":
      args.push("--quiet");
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
  // `-` is standard input; the pattern is delimited so a leading hyphen cannot become a flag.
  args.push("--regexp", input.pattern, "--", "-");
  return args;
}

/** What makes a line match, the same in both searches. */
function pushMatchArgs(args: string[], input: GrepFilesInput): void {
  if (!input.caseSensitive) args.push("--ignore-case");
  if (input.multiline) args.push("--multiline", "--multiline-dotall");
}

type ContentLine = { readonly line: number; readonly kind: "match" | "context"; readonly text: string };
type GrepEntry =
  | { readonly kind: "line"; readonly path: string; readonly value: ContentLine }
  | { readonly kind: "gap"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "count"; readonly path: string; readonly count: number };

/** One output record of the search over one file's bytes, shown under `path`. */
function parseBoundRecord(record: string, mode: GrepFilesInput["outputMode"], path: string): GrepEntry | null {
  if (mode === "content" && record === "--") return { kind: "gap", path: "" };
  if (mode === "count") {
    const count = Number(record);
    return record.length > 0 && Number.isSafeInteger(count) && count > 0 ? { kind: "count", path, count } : null;
  }
  if (mode !== "content") return null;
  const parsed = /^(\d+)([:-])/.exec(record);
  if (!parsed) return null;
  return {
    kind: "line",
    path,
    value: {
      line: Number(parsed[1]),
      kind: parsed[2] === ":" ? "match" : "context",
      text: record.slice(parsed[0].length).replace(/\r$/, ""),
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

/**
 * Whether the real path `entryPath` is the real path `root` or lies beneath it. Both come from realpath, so they share
 * case and spelling; on win32 `\\` is folded to `/` as in `isWithinAdmittedRoot`. A root that ends in a separator (a
 * filesystem or drive root) is its own boundary, and any other is followed by one, so a sibling sharing its name's prefix
 * stays outside.
 */
export function liesUnderRealRoot(entryPath: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string): string => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  const foldedRoot = fold(root);
  const foldedPath = fold(entryPath);
  const boundary = foldedRoot.endsWith("/") ? foldedRoot : `${foldedRoot}/`;
  return foldedPath === foldedRoot || foldedPath.startsWith(boundary);
}

/**
 * Search under `root` with entries for at most `offset + limit + 1` results. The tree search names the matching files in
 * path order; each one that the path policy admits is then searched again on bytes the host read itself
 * (`searchBoundFile`), and only those results are kept.
 */
async function runRipgrep(
  executable: string,
  root: string,
  cwd: string,
  input: GrepFilesInput,
  signal: AbortSignal | undefined,
  explicitSecretRoot?: string,
): Promise<RipgrepRun> {
  signal?.throwIfAborted();
  const wanted = input.offset + input.limit + 1;
  // Every file read lies under the real root: the tree search does not follow links, so only a path changed after it listed
  // the file can lead out. An explicitly searched secret root admits what lies beneath it, judged on real paths too.
  const realRoot = await realpath(resolve(cwd, root));
  const explicitRealRoot = explicitSecretRoot === undefined ? undefined : realRoot;
  // One policy pass for every listed path and real path of this search.
  const policy = createFilePathPolicy("read");
  const skip = createStageWorkspacesSkip(realRoot);
  const listing: ListingState = { exitCode: null, stderr: "" };
  // A few files are searched ahead of the one whose results are taken next; they are cancelled once enough are found.
  const searches = new AbortController();
  const files = matchingFiles(executable, buildRipgrepArgs(root, input), cwd, searches.signal, listing, input.outputMode === "count");
  const forward = (): void => searches.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  const ahead: Promise<GrepEntry[]>[] = [];
  let listed = false;
  let listingFailure: Error | undefined;
  let notifyChange: () => void = () => {};
  let changed = new Promise<void>(resolveChange => { notifyChange = resolveChange; });
  const notify = (): void => {
    notifyChange();
    changed = new Promise<void>(resolveChange => { notifyChange = resolveChange; });
  };
  searches.signal.addEventListener("abort", notify, { once: true });
  const producer = (async (): Promise<void> => {
    try {
      for await (const path of files) {
        while (ahead.length >= BOUND_SEARCHES_AHEAD) {
          searches.signal.throwIfAborted();
          await changed;
        }
        searches.signal.throwIfAborted();
        // Check every result path: the search engine does not know the host's sensitive-path floor.
        const explicit = explicitSecretRoot !== undefined && isWithinAdmittedRoot(path, explicitSecretRoot);
        if (policy.admissionDenied(path) !== null || (!explicit && policy.sensitive(path) !== null) || skip(resolve(cwd, path))) continue;
        const search = searchBoundFile(executable, path, cwd, input, wanted, { real: realRoot, explicit: explicitRealRoot, skip }, policy, searches.signal);
        // A search cancelled after enough results were found settles with nobody waiting for it.
        search.catch(() => {});
        ahead.push(search);
        notify();
      }
    } catch (error) {
      listingFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      listed = true;
      notify();
    }
  })();
  const entries: GrepEntry[] = [];
  let counted = 0;
  try {
    while (ahead.length > 0 || !listed) {
      const next = ahead[0];
      if (next === undefined) { await changed; continue; }
      const found = await next;
      signal?.throwIfAborted();
      ahead.shift();
      notify();
      for (const entry of found) {
        entries.push(entry);
        if (entry.kind === "gap") continue;
        // Every non-gap record is one entry: a line in content mode, a file otherwise.
        counted += 1;
        if (counted >= wanted) return { entries, more: true, exitCode: 0, stderr: listing.stderr.trim() };
      }
    }
    if (listingFailure !== undefined) throw listingFailure;
    return { entries, more: false, exitCode: listing.exitCode, stderr: listing.stderr.trim() };
  } finally {
    searches.abort(new Error("grep_files has the results it needs."));
    await producer;
    await Promise.allSettled(ahead);
    await files.return(undefined);
    signal?.removeEventListener("abort", forward);
  }
}

/** The piped streams of a search child, which a child spawned with pipes always has; one without them is stopped. */
function pipedStreams(child: ChildProcess): { stdin: Writable | null; stdout: Readable; stderr: Readable } {
  if (child.stdout === null || child.stderr === null) {
    void forceKillManagedChildProcess(child, "grep-files-stop");
    throw new Error("grep_files: ripgrep was started without output pipes.");
  }
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
}

interface ListingState {
  exitCode: number | null;
  stderr: string;
}

function searchCompletedNormally(child: ChildProcess, code: number | null, endedBy: NodeJS.Signals | null, hasMatches: boolean): boolean {
  return !child.killed && endedBy === null && (code === 0 || (code === 1 && !hasMatches));
}

function searchExitFailure(code: number | null, endedBy: NodeJS.Signals | null, diagnostics: string): Error {
  return new Error(`grep_files failed: ${diagnostics.trim() || (endedBy ? `ripgrep ended by ${endedBy}` : `ripgrep exited with code ${String(code)}`)}`);
}

/**
 * The paths the tree search lists, in its order; with `counted`, each is followed by its count, which is dropped. Stopping
 * early stops the search; its exit code and errors land in `state`.
 */
async function* matchingFiles(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  state: ListingState,
  counted: boolean,
): AsyncGenerator<string> {
  const child = spawnManaged(executable, args, {
    cwd,
    env: buildSafeChildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }, { label: "grep-files-ripgrep" });
  const { stdout, stderr } = pipedStreams(child);
  let startFailure: Error | undefined;
  const closed = new Promise<{ code: number | null; endedBy: NodeJS.Signals | null }>((resolveClose) => {
    child.once("close", (code, endedBy) => resolveClose({ code, endedBy }));
  });
  child.once("error", (error) => {
    startFailure ??= new Error(`grep_files could not start ripgrep: ${error.message}`);
  });
  stderr.on("data", (chunk: Buffer) => {
    if (state.stderr.length < MAX_STDERR_CHARS) state.stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - state.stderr.length);
  });
  let aborted: Error | undefined;
  const onAbort = (): void => {
    aborted = signal?.reason instanceof Error ? signal.reason : new Error("grep_files was cancelled.");
    void forceKillManagedChildProcess(child, "grep-files-stop");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let finished = false;
  let hasMatches = false;
  try {
    for await (const chunk of stdout) {
      pending += decoder.decode(chunk as Buffer, { stream: true });
      for (let index = pending.indexOf("\0"); index !== -1; index = pending.indexOf("\0")) {
        // A path ends at its NUL; its count, when there is one, at the next newline.
        const end = counted ? pending.indexOf("\n", index + 1) : index;
        if (end === -1) break;
        const path = pending.slice(0, index);
        pending = pending.slice(end + 1);
        if (path.length > 0) {
          hasMatches = true;
          yield path;
        }
      }
      if (pending.length > MAX_PENDING_RECORD_BYTES) throw new Error("grep_files: ripgrep produced an unbounded output record.");
    }
    pending += decoder.decode();
    const { code, endedBy } = await closed;
    state.exitCode = code;
    if (aborted) throw aborted;
    if (startFailure) throw startFailure;
    // An ordinary listing error can retain diagnosed partial results; termination cannot become a completed search.
    const partial = code === 2 && endedBy === null && !child.killed;
    if (!partial && !searchCompletedNormally(child, code, endedBy, hasMatches || pending.length > 0)) {
      throw searchExitFailure(code, endedBy, state.stderr);
    }
    finished = true;
    const last = counted && pending.includes("\0") ? pending.slice(0, pending.indexOf("\0")) : pending;
    if (last.length > 0) yield last;
  } finally {
    if (!finished) await forceKillManagedChildProcess(child, "grep-files-stop");
    await closed;
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The results for one listed file, from bytes the host read itself. The file is judged again on its real path, which must
 * lie under the searched root's, opened without following a link in its last name where the platform can, and read through
 * that one handle into a search of standard input. Its results count only if the real path still names the file read once
 * the reading is done (`judgedPathNamesOpenedFile`); a file that fails that, no longer matches, or cannot be read gives
 * none.
 */
async function searchBoundFile(
  executable: string,
  path: string,
  cwd: string,
  input: GrepFilesInput,
  needed: number,
  roots: { readonly real: string; readonly explicit: string | undefined; readonly skip: (path: string) => boolean },
  policy: ReturnType<typeof createFilePathPolicy>,
  signal: AbortSignal | undefined,
): Promise<GrepEntry[]> {
  let judged: string;
  let handle: FileHandle;
  let explicit = false;
  try {
    judged = await realpath(resolve(cwd, path));
    if (!liesUnderRealRoot(judged, roots.real)) return [];
    explicit = roots.explicit !== undefined && isWithinAdmittedRoot(judged, roots.explicit);
    if (policy.admissionDenied(judged) !== null || (!explicit && policy.sensitive(judged) !== null) || roots.skip(judged)) return [];
    handle = await open(judged, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    signal?.throwIfAborted();
    return [];
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return [];
    const found = await searchHandle(executable, handle, cwd, input, path, needed, signal);
    if (!explicit) {
      const size = Number((await handle.stat({ bigint: true })).size);
      let sensitive = isSensitiveContent(judged, found.bytes, size);
      // A successful search can finish before it consumes the file. Complete bounded content evidence through this same
      // handle, retaining the prefix already searched rather than reading it again from a mutable file.
      if (sensitive !== null && found.bytes.length < size && size <= KEY_MATERIAL_SCAN_BYTES) {
        const bytes = Buffer.alloc(size);
        found.bytes.copy(bytes);
        let filled = found.bytes.length;
        while (filled < size) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const completed = await handle.stat({ bigint: true });
        sensitive = isSensitiveContent(judged, bytes.subarray(0, filled), Number(completed.size));
      }
      if (sensitive !== null) return [];
    }
    if (!judgedPathNamesOpenedFile(judged, opened)) return [];
    return found.entries;
  } finally {
    await handle.close();
  }
}

/**
 * Search the bytes of `handle`, from its start, for `input`; results are shown under `path`. ripgrep decodes them and
 * tells binary ones as in a file it is named: their lines show up to the first NUL byte, as the tree search shows them, and
 * a count is of the whole input, given only for a file the tree search counted (`buildRipgrepArgs`).
 */
function searchHandle(
  executable: string,
  handle: FileHandle,
  cwd: string,
  input: GrepFilesInput,
  path: string,
  needed: number,
  signal: AbortSignal | undefined,
): Promise<{ entries: GrepEntry[]; bytes: Buffer }> {
  signal?.throwIfAborted();
  const child = spawnManaged(executable, buildRipgrepStdinArgs(input), {
    cwd,
    env: buildSafeChildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }, { label: "grep-files-ripgrep" });

  const { stdin, stdout, stderr } = pipedStreams(child);
  if (stdin === null) {
    void forceKillManagedChildProcess(child, "grep-files-stop");
    throw new Error("grep_files: ripgrep was started without an input pipe.");
  }
  return new Promise((resolvePromise, reject) => {
    const entries: GrepEntry[] = [];
    let counted = 0;
    let pending = "";
    let enough = false;
    let limited = false;
    let closed = false;
    let failure: Error | undefined;
    let diagnostics = "";
    const chunks: Buffer[] = [];
    let captured = 0;
    let termination: void | Promise<void>;
    const decoder = new TextDecoder("utf-8");

    // The first listener on the search's end, so every wait for room in its input sees it ended once it has.
    child.once("close", (code, endedBy) => {
      closed = true;
      void settle(code, endedBy);
    });

    const stop = (error?: Error): void => {
      if (error) failure ??= error;
      termination ??= forceKillManagedChildProcess(child, "grep-files-stop");
    };
    const onAbort = (): void => {
      stop(signal?.reason instanceof Error ? signal.reason : new Error("grep_files was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const accept = (record: string): void => {
      if (enough || failure) return;
      const entry = parseBoundRecord(record, input.outputMode, path);
      if (entry === null) return;
      entries.push(entry);
      if (entry.kind === "gap") return;
      counted += 1;
      if (counted >= needed) {
        enough = true;
        if (!closed && !child.killed && child.exitCode === null && child.signalCode === null) {
          limited = true;
          stop();
        }
      }
    };
    const consume = (text: string): void => {
      pending += text;
      for (let index = pending.indexOf("\n"); index !== -1; index = pending.indexOf("\n")) {
        accept(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (pending.length > MAX_PENDING_RECORD_BYTES) stop(new Error("grep_files: ripgrep produced an unbounded output record."));
    };

    // The search may stop reading early (it has an answer, or it was stopped); later writes then have nowhere to go.
    stdin.on("error", () => {});
    stdout.on("data", (chunk: Buffer) => consume(decoder.decode(chunk, { stream: true })));
    stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - diagnostics.length);
    });
    child.once("error", (error) => {
      failure ??= new Error(`grep_files could not start ripgrep: ${error.message}`);
      if (child.pid) stop();
    });

    // Whether the search has ended, or will without more input; then no byte is written to it and nothing is waited for.
    const ended = (): boolean => enough || failure !== undefined || closed || stdin.destroyed;
    // Room in the input pipe, or the end of the search. Asked only while the search runs, so its end is still to come.
    const room = (): Promise<void> => new Promise((resolveRoom) => {
      const done = (): void => {
        stdin.off("drain", done);
        stdin.off("close", done);
        child.off("close", done);
        resolveRoom();
      };
      stdin.once("drain", done);
      stdin.once("close", done);
      child.once("close", done);
    });
    const feed = async (): Promise<void> => {
      for (let position = 0; !ended();) {
        const buffer = Buffer.allocUnsafe(BOUND_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        // The search can end while a read is under way.
        if (bytesRead === 0 || ended()) break;
        const capture = Math.min(bytesRead, KEY_MATERIAL_SCAN_BYTES - captured);
        if (capture > 0) {
          chunks.push(buffer.subarray(0, capture));
          captured += capture;
        }
        position += bytesRead;
        if (!stdin.write(buffer.subarray(0, bytesRead)) && !ended()) await room();
      }
      if (!stdin.destroyed) stdin.end();
    };
    const fed = feed().catch((error: unknown) => stop(error instanceof Error ? error : new Error(String(error))));

    const settle = async (code: number | null, endedBy: NodeJS.Signals | null): Promise<void> => {
      await fed;
      if (termination) await termination;
      signal?.removeEventListener("abort", onAbort);
      consume(decoder.decode());
      if (pending.length > 0) accept(pending);
      if (!limited && !searchCompletedNormally(child, code, endedBy, entries.some((entry) => entry.kind !== "gap"))) {
        failure ??= searchExitFailure(code, endedBy, diagnostics);
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (input.outputMode === "files_with_matches") {
        resolvePromise({ entries: code === 0 ? [{ kind: "file", path }] : [], bytes: Buffer.concat(chunks, captured) });
        return;
      }
      resolvePromise({ entries, bytes: Buffer.concat(chunks, captured) });
    };
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
    run = await runRipgrep(executable, root, cwd, input, signal, sensitiveFilePattern(root) !== null ? root : undefined);
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
