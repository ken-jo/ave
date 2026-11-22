import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { compileGlobMatcher, containsGlobMetacharacter } from "../../lib/glob-matcher.js";

export const MAX_SEED_FILES = 5_000;
export const MAX_SEED_BYTES = 512 * 1024 * 1024;
/** Entries one selection may look at before it gives up; a narrow glob over a huge tree is refused instead of walked. */
const MAX_SEED_SCAN = 100_000;

export interface SeedFile { path: string; size: number; sha256: string }
interface SeedSkip { path: string; why: "link" | "secret" | "ignored" | "not-a-file" }
type SeedRefusal = "seed-too-large" | "seed-unreadable";
type Listed = { ok: true; files: { path: string; size: number }[]; skipped: SeedSkip[] } | { ok: false; code: SeedRefusal };

export interface SeedRules {
  /** The secret-file test, asked with the absolute source path. */
  sensitive: (absolutePath: string) => boolean;
  /** The project's ignore rules: which of these relative paths (a directory ends in `/`) are ignored. */
  ignored?: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
  limits?: { files: number; bytes: number };
}

class SeedStop extends Error { constructor(readonly code: SeedRefusal) { super(code); } }

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A relative path with `/` separators and no segment that could leave its root or name a stream. */
function relativeSegments(path: string): string[] | null {
  const segments = path.replace(/\\/g, "/").split("/").filter(segment => segment !== "" && segment !== ".");
  if (segments.length === 0 || isAbsolute(path) || /^[a-zA-Z]:/u.test(path)) return null;
  return segments.some(segment => segment === ".." || segment.includes(":") || segment.includes("\0")) ? null : segments;
}

function selectorOf(globs: readonly string[]): { starts: string[]; matches: (path: string) => boolean } {
  const matchers = globs.flatMap(glob => [glob, `${glob.replace(/\/+$/u, "")}/**`]).map(glob => compileGlobMatcher(glob, { caseInsensitive: false }));
  // The walk starts at each glob's literal directory prefix, so a narrow glob never lists the whole tree.
  const starts = globs.map((glob) => {
    const segments = glob.replace(/\\/g, "/").split("/").filter(Boolean);
    const literal = segments.findIndex(containsGlobMetacharacter);
    return (literal === -1 ? segments : segments.slice(0, literal)).join("/");
  });
  return { starts: [...new Set(starts)], matches: path => matchers.some(match => match(path)) };
}

/**
 * The regular files under `root` that `globs` select. It never follows a symbolic link, junction or other link (the entry is skipped and
 * listed), skips every secret and ignored path, and stops with `seed-too-large` at the bounds.
 */
export async function listSeedFiles(root: string, globs: readonly string[], rules: SeedRules): Promise<Listed> {
  const limits = rules.limits ?? { files: MAX_SEED_FILES, bytes: MAX_SEED_BYTES };
  const { starts, matches } = selectorOf(globs);
  const files: { path: string; size: number }[] = [];
  const skipped: SeedSkip[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let scanned = 0;

  async function visit(batch: readonly string[]): Promise<void> {
    scanned += batch.length;
    if (scanned > MAX_SEED_SCAN) throw new SeedStop("seed-too-large");
    const entries: { path: string; directory: boolean; size: number }[] = [];
    for (const path of batch) {
      if (seen.has(path)) continue;
      seen.add(path);
      const absolute = join(root, path);
      const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw new SeedStop("seed-unreadable");
      });
      if (stat === null) continue;
      if (stat.isSymbolicLink()) skipped.push({ path, why: "link" });
      // Repository metadata is never seed material: it carries hooks and configuration.
      else if (/(^|\/)\.git$/iu.test(path)) skipped.push({ path, why: "ignored" });
      else if (!stat.isDirectory() && !stat.isFile()) skipped.push({ path, why: "not-a-file" });
      else if (rules.sensitive(absolute)) skipped.push({ path, why: "secret" });
      else entries.push({ path, directory: stat.isDirectory(), size: stat.size });
    }
    const ignored = rules.ignored && entries.length > 0 ? await rules.ignored(entries.map(entry => entry.directory ? `${entry.path}/` : entry.path)) : new Set<string>();
    for (const entry of entries) {
      if (ignored.has(entry.directory ? `${entry.path}/` : entry.path)) { skipped.push({ path: entry.path, why: "ignored" }); continue; }
      if (entry.directory) {
        const names = await readdir(join(root, entry.path)).catch(() => { throw new SeedStop("seed-unreadable"); });
        await visit(names.sort().map(name => `${entry.path}/${name}`));
      } else if (matches(entry.path)) {
        bytes += entry.size;
        if (files.length + 1 > limits.files || bytes > limits.bytes) throw new SeedStop("seed-too-large");
        files.push({ path: entry.path, size: entry.size });
      }
    }
  }

  try {
    for (const start of starts) {
      if (start === "") {
        const names = await readdir(root).catch(() => { throw new SeedStop("seed-unreadable"); });
        await visit(names.sort());
        continue;
      }
      const segments = relativeSegments(start);
      if (segments === null) throw new SeedStop("seed-unreadable");
      // A link among the parents of a start is not followed either.
      let linked = false;
      for (let depth = 1; depth < segments.length && !linked; depth += 1) {
        const parent = segments.slice(0, depth).join("/");
        const stat = await lstat(join(root, parent)).catch(() => null);
        if (stat?.isSymbolicLink()) { skipped.push({ path: parent, why: "link" }); linked = true; }
      }
      if (!linked) await visit([segments.join("/")]);
    }
  } catch (error) {
    if (error instanceof SeedStop) return { ok: false, code: error.code };
    throw error;
  }
  return { ok: true, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), skipped };
}

/** sha256 and size of one regular file, read through a handle that does not follow a link. */
export async function hashSeedFile(absolutePath: string, copyTo?: string): Promise<{ sha256: string; size: number }> {
  const source = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await source.stat()).isFile()) throw new Error("not a regular file");
    const target = copyTo === undefined ? undefined : await open(copyTo, "w", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        size += bytesRead;
        if (target) await target.write(chunk);
      }
      return { sha256: hash.digest("hex"), size };
    } finally {
      await target?.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * Copies the listed files from `sourceRoot` to the same relative paths under `targetRoot`. A destination outside `runRoot`, or one whose
 * parent folders are not real directories, is refused before anything is written there.
 */
export async function copySeedFiles(sourceRoot: string, targetRoot: string, runRoot: string, paths: readonly string[]): Promise<SeedFile[]> {
  if (targetRoot !== runRoot && !isInside(runRoot, targetRoot)) throw new Error("seed destination is outside the run root");
  const copied: SeedFile[] = [];
  for (const path of paths) {
    const segments = relativeSegments(path);
    if (segments === null) throw new Error("seed path is not a relative path");
    const target = join(targetRoot, ...segments);
    if (!isInside(runRoot, target)) throw new Error("seed destination is outside the run root");
    await mkdir(dirname(target), { recursive: true });
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const stat = await lstat(join(targetRoot, ...segments.slice(0, depth))).catch(() => null);
      if (stat !== null && (stat.isSymbolicLink() || (depth < segments.length ? !stat.isDirectory() : !stat.isFile()))) throw new Error("seed destination is not a plain path");
    }
    copied.push({ path: segments.join("/"), ...(await hashSeedFile(join(sourceRoot, ...segments), target)) });
  }
  return copied;
}
