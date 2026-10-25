/**
 * Project instruction discovery — leaf module.
 *
 * Discovers the committed, team-shared instruction files of the active project
 * so they can be injected as a distinct layer BELOW the global personal
 * `~/.ave/AGENTS.md`.
 *
 * Chain. The walk starts at the repository root — the nearest ancestor of the
 * project root holding `.git` (a directory, or a file in a worktree), or the
 * project root itself when there is none — and goes down to the project root.
 * The climb is bounded by the home directory: a `.git` found at `$HOME` or
 * above it (a dotfiles repository, say) is not the project's repository, so
 * the walk then starts at the project root and `~/AGENTS.md` never loads as a
 * committed project file.
 * Each directory contributes at most one file: `AGENTS.md`, or `CLAUDE.md`
 * when `AGENTS.md` is absent or empty. Layers are ordered root-first, so the
 * file closest to the project root comes last and reads as the most specific.
 *
 * Subdirectories below the project root are not part of the launch chain;
 * {@link discoverDirectoryInstructions} reads one of them on demand when the
 * agent works with files there.
 *
 * Imports. A line may name another file as `@path` (relative to the file that
 * names it). Imports are appended after the importing file's own text, up to
 * {@link PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH} hops, once each. Text inside
 * fenced code blocks and inline code spans is not scanned. An import must
 * resolve inside the repository root: committed files are shared content, and
 * a path out of the repository (an absolute path, `~`, or a symlink) would let
 * them pull arbitrary host files into the prompt. A path the host's sensitive
 * path policy denies for reading (`.env`, keys, credentials) is skipped even
 * inside the repository.
 *
 * Budget. The whole chain shares {@link PROJECT_AGENTS_MD_MAX_TOTAL_BYTES},
 * filled root-first: the layer that crosses the cap is head-clamped and the
 * layers after it are dropped.
 *
 * First touch. {@link discoverDirectoryInstructions} stops at a nested
 * repository (a directory holding `.git`, as a submodule or a third-party
 * clone does) and at `node_modules`, and skips files git ignores: what lies
 * there is not this project's committed text.
 *
 * Dependencies stay at node built-ins plus the sensitive-path policy leaf, so
 * this remains a memory-layer leaf with no upward dependency on engine/ or
 * prompts/.
 */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../permissions/sensitive-paths.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { buildHostGitArgs, isHostGitWorkspaceAvailable } from "../shared/host-git.js";

interface ProjectAgentsMdLayer {
  /** Path of the instruction file relative to the repository root. */
  relativePath: string;
  /** LF-normalized content with imports appended, head-truncated to the remaining byte budget. */
  content: string;
  /** True when the layer exceeded the byte budget and was head-clamped. */
  truncated: boolean;
}

export interface ProjectAgentsMd {
  /** Canonicalized project root the discovery was scoped to. */
  projectRoot: string;
  /** Ordered root-first (closest-last). */
  layers: ProjectAgentsMdLayer[];
  /** Total UTF-8 bytes of injected content, always <= maxTotalBytes. */
  totalBytes: number;
  /**
   * Every path whose change can change the result: each candidate file name
   * in each chain directory (present or not) and each imported file read.
   */
  watchedPaths: string[];
}

/** Committed instructions are capped so they cannot flood the prompt. */
export const PROJECT_AGENTS_MD_MAX_TOTAL_BYTES = 32 * 1024;

/** How many `@path` hops an import chain may take from the instruction file. */
export const PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH = 4;

/** Per directory, first match wins. */
const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isWithin(canonicalRoot: string, canonicalPath: string): boolean {
  if (canonicalPath === canonicalRoot) return true;
  // The filesystem root already ends in a separator.
  return canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`);
}

/** Slice to at most `maxBytes` without splitting a multi-byte UTF-8 sequence. */
function utf8HeadSlice(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off while `end` lands on a continuation byte (10xxxxxx): slicing there
  // would split a character. Stop on an ASCII/lead byte so [0, end) is clean.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Read a regular file whose realpath stays inside `canonicalRoot`. Returns
 * null for absent, non-regular, escaping or unreadable files — the expected
 * filesystem cases of discovery, all of which mean "no file here".
 */
function readConfinedFile(canonicalRoot: string, path: string): { canonicalPath: string; text: string } | null {
  const canonicalPath = canonical(path);
  if (!canonicalPath || !isWithin(canonicalRoot, canonicalPath)) return null;
  if (isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(canonicalPath)), "read")) return null;
  let fd: number | null = null;
  try {
    fd = openSync(canonicalPath, "r");
    if (!fstatSync(fd).isFile()) return null; // EISDIR / socket / fifo — not an instruction file
    return { canonicalPath, text: readFileSync(fd, "utf-8").replace(/\r\n/g, "\n") };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** `@path` references outside fenced code blocks and inline code spans. */
function importReferences(text: string): string[] {
  const references: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/g, " ");
    for (const match of prose.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      references.push(match[1]!.replace(/[.,;:!?)\]]+$/, ""));
    }
  }
  return references;
}

/** The file's text followed by its imports, depth-first, each read once. */
function expandImports(
  canonicalRoot: string,
  file: { canonicalPath: string; text: string },
  seen: Set<string>,
  watched: Set<string>,
  depth: number,
): string {
  const parts = [file.text.trimEnd()];
  if (depth >= PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH) return parts[0]!;
  for (const reference of importReferences(file.text)) {
    if (!reference || isAbsolute(reference) || reference.startsWith("~")) continue;
    const imported = readConfinedFile(canonicalRoot, resolve(dirname(file.canonicalPath), reference));
    if (!imported || seen.has(imported.canonicalPath)) continue;
    seen.add(imported.canonicalPath);
    watched.add(imported.canonicalPath);
    const body = expandImports(canonicalRoot, imported, seen, watched, depth + 1);
    if (body.trim()) {
      parts.push(`<!-- imported: ${relative(canonicalRoot, imported.canonicalPath)} -->\n${body}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * The instruction file of one directory with its imports, or null when the
 * directory has none. `seen` carries files already included elsewhere so a
 * file is never injected twice.
 */
function directoryLayer(
  canonicalRoot: string,
  dir: string,
  seen: Set<string>,
  watched: Set<string>,
): { relativePath: string; content: string } | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(dir, name);
    watched.add(path);
    const file = readConfinedFile(canonicalRoot, path);
    if (!file || file.text.trim().length === 0) continue;
    if (seen.has(file.canonicalPath)) return null;
    seen.add(file.canonicalPath);
    return {
      relativePath: relative(canonicalRoot, file.canonicalPath) || name,
      content: expandImports(canonicalRoot, file, seen, watched, 0),
    };
  }
  return null;
}

function hasGitEntry(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** The home directory `~` names, as the filesystem resolves it, when it exists. */
function canonicalHome(): string | null {
  return canonical(expandLeadingTilde("~"));
}

/**
 * Nearest ancestor of `start` (inclusive) holding `.git`, or `start` when none
 * does. A repository at `home` or above it is not taken: there the walk would
 * leave the project for the user's own files, so `start` is the root instead.
 */
function repositoryRoot(start: string, home: string | null): string {
  let dir = start;
  for (;;) {
    if (dir !== start && home !== null && isWithin(dir, home)) return start;
    if (hasGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Directories from `top` down to `bottom`, inclusive. `bottom` must be at or below `top`. */
function chainDirectories(top: string, bottom: string): string[] {
  const rel = relative(top, bottom);
  const dirs = [top];
  if (!rel) return dirs;
  let current = top;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

/**
 * Discover the committed instruction chain for `projectRoot`. Returns empty
 * `layers` when no directory on the chain has a usable file. Never throws for
 * the expected filesystem cases.
 */
export function discoverProjectAgentsMd(
  projectRoot: string,
  opts: { maxTotalBytes?: number; homeDir?: string } = {},
): ProjectAgentsMd {
  const maxTotalBytes = opts.maxTotalBytes ?? PROJECT_AGENTS_MD_MAX_TOTAL_BYTES;
  const root = resolve(projectRoot);
  const canonicalProject = canonical(root);
  // A root that does not exist yet is watched itself, so its creation is noticed.
  if (!canonicalProject) return { projectRoot: root, layers: [], totalBytes: 0, watchedPaths: [root] };
  const top = repositoryRoot(canonicalProject, opts.homeDir !== undefined ? canonical(opts.homeDir) : canonicalHome());
  const seen = new Set<string>();
  const watched = new Set<string>();
  const found = chainDirectories(top, canonicalProject)
    .map((dir) => directoryLayer(top, dir, seen, watched))
    .filter((layer): layer is { relativePath: string; content: string } => layer !== null);

  const layers: ProjectAgentsMdLayer[] = [];
  let totalBytes = 0;
  for (const layer of found) {
    // Several layers are joined into one block; a source line keeps each one's
    // origin, and with it which one is closest, readable.
    const text = found.length > 1
      ? `<!-- instructions: ${layer.relativePath} -->\n${layer.content}`
      : layer.content;
    const remaining = maxTotalBytes - totalBytes;
    if (remaining <= 0) break;
    const truncated = Buffer.byteLength(text, "utf-8") > remaining;
    const content = truncated ? utf8HeadSlice(text, remaining) : text;
    layers.push({ relativePath: layer.relativePath, content, truncated });
    totalBytes += Buffer.byteLength(content, "utf-8");
    if (truncated) break;
  }
  return { projectRoot: root, layers, totalBytes, watchedPaths: [...watched] };
}

/**
 * Session-scoped memo of git's ignore verdicts, keyed by repository root and
 * path. The owner (the conversation loop) clears it on a session switch.
 */
export type GitIgnoreVerdicts = Map<string, boolean>;

/**
 * Whether git reports `path` as ignored in the repository at `repoRoot`, asked
 * once per `verdicts` lifetime. The query is synchronous because its caller
 * appends to a tool result in the same pass; the memo keeps repeated touches
 * of an ignored directory from spawning git each time.
 */
function gitIgnores(repoRoot: string, path: string, verdicts: GitIgnoreVerdicts | undefined): boolean {
  // An unsettled sandbox write is temporary, so do not cache its conservative answer.
  if (!isHostGitWorkspaceAvailable(repoRoot)) return false;
  const key = `${repoRoot}\0${path}`;
  const known = verdicts?.get(key);
  if (known !== undefined) return known;
  const verdict = askGitIgnores(repoRoot, path);
  verdicts?.set(key, verdict);
  return verdict;
}

/**
 * Whether git reports `path` as ignored in the repository at `repoRoot`. A
 * tracked file is never reported. Any failure to ask (no git, not a
 * repository) reads as "not ignored": the nested-repository and
 * `node_modules` stops still hold without git.
 */
function askGitIgnores(repoRoot: string, path: string): boolean {
  if (!isHostGitWorkspaceAvailable(repoRoot)) return false;
  if (!hasGitEntry(repoRoot)) return false;
  const env = { ...process.env };
  // A git hook's GIT_DIR / GIT_WORK_TREE would point the query at another repository.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  try {
    execFileSync("git", buildHostGitArgs(["-C", repoRoot, "check-ignore", "-q", "--", relative(repoRoot, path)]), {
      windowsHide: true,
      stdio: "ignore",
      timeout: 2_000,
      env,
    });
    return true; // exit 0: ignored
  } catch {
    return false; // exit 1: not ignored; anything else: unknown
  }
}

/**
 * Instruction files for directories BELOW `projectRoot` on the way to
 * `targetPath` (a file or directory the agent touched; relative paths resolve
 * against the project root), root-first, skipping any whose `relativePath`
 * is already in `attached`. Each layer is capped at the project budget. A
 * target outside the project root, or the root itself, yields nothing.
 *
 * The descent stops at the first directory that is `node_modules` or holds
 * `.git` (a nested repository or submodule): instruction files from there down
 * belong to another project. A file git ignores is skipped.
 */
export function discoverDirectoryInstructions(
  projectRoot: string,
  targetPath: string,
  attached: { has(relativePath: string): boolean },
  opts: { homeDir?: string; gitIgnoreVerdicts?: GitIgnoreVerdicts } = {},
): ProjectAgentsMdLayer[] {
  const canonicalProject = canonical(resolve(projectRoot));
  if (!canonicalProject) return [];
  const absolute = resolve(canonicalProject, targetPath);
  let targetDir = dirname(absolute);
  try {
    if (statSync(absolute).isDirectory()) targetDir = absolute;
  } catch {
    // A path that does not exist yet (a file being written) still names its directory.
  }
  const canonicalTarget = canonical(targetDir);
  if (!canonicalTarget || canonicalTarget === canonicalProject || !isWithin(canonicalProject, canonicalTarget)) {
    return [];
  }
  const top = repositoryRoot(canonicalProject, opts.homeDir !== undefined ? canonical(opts.homeDir) : canonicalHome());
  const layers: ProjectAgentsMdLayer[] = [];
  for (const dir of chainDirectories(canonicalProject, canonicalTarget).slice(1)) {
    if (basename(dir) === "node_modules" || hasGitEntry(dir)) break;
    const layer = directoryLayer(top, dir, new Set(), new Set());
    if (!layer || attached.has(layer.relativePath)) continue;
    if (gitIgnores(top, join(top, layer.relativePath), opts.gitIgnoreVerdicts)) continue;
    const truncated = Buffer.byteLength(layer.content, "utf-8") > PROJECT_AGENTS_MD_MAX_TOTAL_BYTES;
    layers.push({
      relativePath: layer.relativePath,
      content: truncated ? utf8HeadSlice(layer.content, PROJECT_AGENTS_MD_MAX_TOTAL_BYTES) : layer.content,
      truncated,
    });
  }
  return layers;
}
