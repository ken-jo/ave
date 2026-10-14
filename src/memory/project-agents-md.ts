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
 * them pull arbitrary host files into the prompt.
 *
 * Budget. The whole chain shares {@link PROJECT_AGENTS_MD_MAX_TOTAL_BYTES},
 * filled root-first: the layer that crosses the cap is head-clamped and the
 * layers after it are dropped.
 *
 * Pure + dependency-free (node:fs/node:path only) so it stays a memory-layer
 * leaf with no upward dependency on engine/ or prompts/.
 */
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${sep}`);
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

/** Nearest ancestor of `start` (inclusive) holding `.git`; `start` when none does. */
function repositoryRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      // keep walking
    }
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
  opts: { maxTotalBytes?: number } = {},
): ProjectAgentsMd {
  const maxTotalBytes = opts.maxTotalBytes ?? PROJECT_AGENTS_MD_MAX_TOTAL_BYTES;
  const root = resolve(projectRoot);
  const canonicalProject = canonical(root);
  // A root that does not exist yet is watched itself, so its creation is noticed.
  if (!canonicalProject) return { projectRoot: root, layers: [], totalBytes: 0, watchedPaths: [root] };
  const top = repositoryRoot(canonicalProject);
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
 * Instruction files for directories BELOW `projectRoot` on the way to
 * `targetPath` (a file or directory the agent touched; relative paths resolve
 * against the project root), root-first, skipping any whose `relativePath`
 * is already in `attached`. Each layer is capped at the project budget. A
 * target outside the project root, or the root itself, yields nothing.
 */
export function discoverDirectoryInstructions(
  projectRoot: string,
  targetPath: string,
  attached: ReadonlySet<string>,
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
  const top = repositoryRoot(canonicalProject);
  const layers: ProjectAgentsMdLayer[] = [];
  for (const dir of chainDirectories(canonicalProject, canonicalTarget).slice(1)) {
    const layer = directoryLayer(top, dir, new Set(), new Set());
    if (!layer || attached.has(layer.relativePath)) continue;
    const truncated = Buffer.byteLength(layer.content, "utf-8") > PROJECT_AGENTS_MD_MAX_TOTAL_BYTES;
    layers.push({
      relativePath: layer.relativePath,
      content: truncated ? utf8HeadSlice(layer.content, PROJECT_AGENTS_MD_MAX_TOTAL_BYTES) : layer.content,
      truncated,
    });
  }
  return layers;
}
