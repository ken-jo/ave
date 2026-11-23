import { createHash } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { type FileHandle, lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { compileGlobMatcher, containsGlobMetacharacter } from "../../lib/glob-matcher.js";
import { type OwnedDir, OwnedFsError, openSource, type SourceRoot } from "./owned-fs.js";

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
const NAME_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** A folder's names from the bytes the disk holds. A name that is no text would be read as another, or as one beside it, and refuses
 * the listing. */
async function namesOf(dir: string): Promise<string[]> {
  const names = await readdir(dir, { encoding: "buffer" }).catch(() => { throw new SeedStop("seed-unreadable"); });
  return names.map((name) => {
    try { return NAME_TEXT.decode(name); } catch { throw new SeedStop("seed-unreadable"); }
  });
}

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
        const names = await namesOf(join(root, entry.path));
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
        await visit((await namesOf(root)).sort());
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

/** sha256 and size of what `source` holds; with `into`, each part is also written there, after `held` was asked once more. */
async function digest(source: FileHandle, into?: { fd: number; held: () => void }): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    size += bytesRead;
    if (into === undefined) continue;
    into.held();
    for (let written = 0; written < chunk.length;) written += writeSync(into.fd, chunk, written);
  }
  return { sha256: hash.digest("hex"), size };
}

/** sha256 and size of one regular file under a folder that is still the one held: no link is followed on the way to it. */
export async function hashSeedFile(root: SourceRoot, path: string): Promise<{ sha256: string; size: number }> {
  const segments = relativeSegments(path);
  if (segments === null) throw new Error("seed path is not a relative path");
  const source = await openSource(root, segments);
  try {
    return await digest(source);
  } finally {
    await source.close();
  }
}

/**
 * Copies the listed files from `source` to the same relative paths under `target`. Each parent is made one component at a time in the
 * held folder, and the file is a new one: a file or link already at its name is unlinked, never written through. With `expect`, a copy
 * whose content is not the sha256 given for its path is removed again and the call throws.
 */
export async function copySeedFiles(source: SourceRoot, target: OwnedDir, paths: readonly string[], expect?: ReadonlyMap<string, string>): Promise<SeedFile[]> {
  const copied: SeedFile[] = [];
  for (const path of paths) {
    const segments = relativeSegments(path);
    if (segments === null) throw new Error("seed path is not a relative path");
    const leaf = segments.at(-1) as string;
    const handle = await openSource(source, segments);
    try {
      const dir = target.ensurePath(segments.slice(0, -1));
      const { fd, id } = dir.createFile(leaf, { replace: true });
      let made: { sha256: string; size: number };
      try { made = await digest(handle, { fd, held: () => dir.check() }); } finally { closeSync(fd); }
      dir.check();
      if (dir.entryId(leaf) !== id) throw new OwnedFsError("changed", "the copy was replaced while it was written");
      const wanted = expect?.get(path);
      if (wanted !== undefined && wanted !== made.sha256) {
        await dir.remove(leaf, id);
        throw new OwnedFsError("changed", "the source is not the content that was recorded");
      }
      copied.push({ path: segments.join("/"), ...made });
    } finally {
      await handle.close();
    }
  }
  return copied;
}
