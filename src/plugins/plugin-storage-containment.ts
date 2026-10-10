/**
 * The lexical half of plugin-storage containment, in a module a plugin child
 * process can import.
 *
 * WHY IT IS ITS OWN MODULE. `storage.ts` imports `electron` for `safeStorage`,
 * so a plugin running in its own plain Node process cannot import it — and
 * `storage.resolve()` is answered IN the child
 * (`docs/blueprints/plugin-process-isolation.md` §3.1): it is a pure lexical
 * join under `pluginDataDir`, which the child already holds, and a round trip
 * would buy nothing. Without a shared module the child would need its own copy
 * of the traversal rejection, and two copies are free to disagree about what
 * escapes the root — the one thing this particular rule cannot afford.
 *
 * WHAT THE CHILD'S ANSWER IS NOT. It is not the security decision. Every method
 * that actually touches the disk re-runs the host's async guard, which adds the
 * `realpath` walk this module deliberately omits — a symlink planted inside the
 * root is caught there, at the syscall, not here. The child's copy exists so
 * `resolve()` returns the same STRING the host would; containment is enforced
 * where the bytes move.
 *
 * The host canonicalises its root ({@link resolvePluginDataRoot}) at construction
 * and the child holds the un-canonicalised `pluginDataDir`, so the two can differ
 * when the data dir is reached through a linked ancestor. That difference is visible
 * in the returned string and harmless: the plugin feeds it straight back into a
 * storage call, which re-guards against the canonical root.
 */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PluginStorageError } from "./public-contract.js";

/**
 * Sink invoked when a storage path is REFUSED by the containment guards.
 * `message` names the refusal; `meta` carries the offending paths.
 */
export type PluginStorageRejectionLog = (message: string, meta?: unknown) => void;

/**
 * Whether `target` is `root` or lies beneath it.
 *
 * Both are expected already ABSOLUTE and lexically normalised; this asks only
 * the containment question and resolves nothing, because the two callers
 * normalise differently — one canonicalises with `realpath` first, the other
 * cannot because the path need not exist yet.
 *
 * The `+ sep` is the whole point and is why this is shared rather than written
 * again at each site: a bare `startsWith(root)` accepts `/data-evil` for a root
 * of `/data`, and this repository already carries several hand-written copies of
 * the same three-line predicate. Adding another would make it several plus one.
 */
export function isPathWithin(root: string, target: string): boolean {
  if (target === root) return true;
  // A root that ALREADY ends in a separator would otherwise be given a second
  // one and match nothing — `/data/` would reject `/data/x`, and on Windows a
  // drive root is exactly that shape (`C:\\`), so `C:\\foo` would read as
  // outside `C:\\`. In a containment check a false negative refuses a
  // legitimate path, which is how this surfaces: not as an escape, but as a
  // plugin whose own directory looks foreign to it.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootWithSep);
}

/**
 * Whether `target` is `root` or lies beneath it, resolving both sides first.
 *
 * The sibling of {@link isPathWithin} for callers that hold raw filesystem
 * input rather than an already-normalised absolute path. `resolve` collapses
 * `.`/`..` and anchors a relative argument to `process.cwd()`; the containment
 * question is then the same one, asked the same way.
 *
 * WHY THIS SHAPE AND NOT `path.relative`. Seven call sites across plugins,
 * agents, skills and the python runtime each carried the identical two-liner
 * `relative(a, b)` + `!rel.startsWith("..")`. That form answers NO for a
 * directory whose own name begins with two dots — `relative("/a", "/a/..foo")`
 * is `"..foo"`, and `startsWith("..")` reads that as an escape — so a
 * legitimately contained path was refused. The prefix form has no such blind
 * spot.
 *
 * CASE IS COMPARED EXACTLY, on every platform. `path.win32.relative` folds
 * case, so on Windows this is strictly stricter than the form it replaces: it
 * can only ever refuse a path the old form admitted, never the reverse. Every
 * caller derives its candidate from the root it checks against (`resolve(root,
 * …)`, `join(root, …)`, or `realpath` applied to both), so the two sides carry
 * the same casing by construction and no caller loses a path it used to keep.
 */
export function isResolvedPathWithin(root: string, target: string): boolean {
  return isPathWithin(resolve(root), resolve(target));
}

/**
 * Each of `paths` replaced by the OUTERMOST of `roots` that contains it, in
 * order and without duplicates; a path no root contains is an error (callers
 * check containment first).
 *
 * What a Windows filesystem grant is given instead of the path a plugin named.
 * `srt-win acl grant` canonicalises the path it is handed — it follows a
 * junction or symlink in any component and stamps its `(OI)(CI)` ACE on the
 * TARGET (measured on ASRT 0.0.76: a grant on `data\link` landed on the
 * directory the junction named). A path below an envelope root passes through
 * directories the plugin's own process can replace with a junction between any
 * check and the grant, so no lstat walk closes it. The outermost root does not:
 * it is a directory the host created whose parent no confined process can
 * write, so it cannot be re-pointed. On Windows that widens nothing — every
 * confined process runs as the one sandbox account (decision 64), so a worker
 * granted the root reaches only what the plugin's own process already does.
 */
export function outermostContainingRoots(paths: readonly string[], roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const containing = roots.filter((root) => isResolvedPathWithin(root, path));
    const outermost = containing.find((root) => !containing.some((other) =>
      other !== root && isResolvedPathWithin(other, root) && !isResolvedPathWithin(root, other)));
    if (outermost === undefined) {
      throw new Error(`[plugin-storage-containment] ${path} lies under none of ${roots.join(", ")}`);
    }
    if (!out.includes(outermost)) out.push(outermost);
  }
  return out;
}

/**
 * The data root is not the directory the host created: a symlink sits in its
 * place, or something that is not a directory does.
 */
export class PluginDataRootError extends Error {
  constructor(readonly owner: string, readonly dataDir: string, readonly found: "symlink" | "non-directory") {
    super(
      found === "symlink"
        ? `${owner}: the plugin data root ${dataDir} is a symlink, not the directory the host created; `
          + "refusing to follow it"
        : `${owner}: the plugin data root ${dataDir} is not a directory`,
    );
    this.name = "PluginDataRootError";
  }
}

/**
 * THE one check on a plugin's data root, and its canonical path.
 *
 * Every reader that RESOLVES the root goes through here: storage handles at
 * construction, `${PLUGIN_DATA}` argv and env tokens, the load-time ensure, and
 * the owner sandbox root the reviewer and the shell write jail are given
 * (`resolveOwnerPluginSandboxRoot`). The host code that touches the root
 * without resolving it does not need to: carrying `data/` across an install
 * swap, the uninstall removal and the update backup move the directory entry
 * itself with `rename`/`lstat`-based operations, and a link there is moved or
 * removed as a link, never followed. The rule:
 *
 *  - the root's ANCESTORS are trusted host paths and are resolved, links
 *    included — macOS `/tmp` is `/private/tmp`, and `AVE_HOME` may sit on
 *    another volume behind a link;
 *  - the root ITSELF must be a real directory. A confined plugin writes inside
 *    it, and on macOS a write grant on a directory reaches the directory's own
 *    entry, so the plugin could `rmdir` the root and put a link in its place.
 *    The sandbox denies that as well (`confined-child.ts`); this check is what
 *    holds if a root is replaced anyway — a handle built afterwards refuses
 *    instead of following the link out;
 *  - every component BELOW the root is the caller's to walk with `lstat`.
 *
 * A missing root throws the raw `ENOENT`: whether absence is a manifest error,
 * a refused operation or something to create is the caller's decision.
 */
export function resolvePluginDataRoot(owner: string, dataDir: string): string {
  // `resolve` drops a trailing separator, which would make `lstat` follow a
  // link in the last component instead of reporting it.
  const root = resolve(dataDir);
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) throw new PluginDataRootError(owner, root, "symlink");
  if (!entry.isDirectory()) throw new PluginDataRootError(owner, root, "non-directory");
  return realpathSync(root);
}

/**
 * Join `segments` under `storageRoot` and refuse anything that leaves it.
 *
 * Lexical only, and callers that go on to touch the disk must follow it with
 * the realpath walk — see the module header for why the split is deliberate
 * rather than an omission.
 */
/**
 * The path a plugin asked for, in the plugin's own vocabulary.
 *
 * `join` normalises to the HOST separator, so one `read("../escape.bin")`
 * reports `../escape.bin` on POSIX and `..\\escape.bin` on Win32. Storage paths are
 * relative, `/`-separated segments in the public contract, and `attemptedPath`
 * is a diagnostic a plugin may branch on — it must not tell the plugin which
 * host it happened to land on. Only the reported string is folded back; the
 * containment decision above is made on the joined host path.
 */
function reportedPath(rel: string): string {
  return rel.split(sep).join("/");
}

export function resolvePluginStoragePath(
  pluginId: string,
  storageRoot: string,
  segments: readonly unknown[],
  log?: PluginStorageRejectionLog,
): string {
  for (const segment of segments) {
    // Checked before `join`, which throws a bare `TypeError` naming the
    // argument index — a diagnostic that says nothing about which plugin or
    // which path, and that a plugin author cannot branch on.
    if (typeof segment !== "string") {
      throw new PluginStorageError("path must be a string", pluginId, String(segment));
    }
  }
  const rel = segments.length === 0 ? "." : join(...(segments as string[]));
  // Refuse absolute paths outright — plugins should think in relative terms.
  if (isAbsolute(rel)) {
    throw new PluginStorageError("absolute paths are not allowed", pluginId, reportedPath(rel));
  }
  const target = resolve(storageRoot, rel);
  if (!isPathWithin(storageRoot, target)) {
    log?.(`storage: rejected escape attempt`, { rel, resolved: target });
    throw new PluginStorageError("path escapes plugin storage root", pluginId, reportedPath(rel));
  }
  return target;
}
