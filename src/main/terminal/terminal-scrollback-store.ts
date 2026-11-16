import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { constants, promises as fs, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { caseFoldForMatch, foldCanonicalPathSeparators } from "../../permissions/sensitive-paths.js";
import type { MainLayoutSnapshot } from "../../shared/main-layout.js";
import { TERMINAL_REPLAY_MAX_BYTES } from "../../shared/terminal-session.js";
import { admitWindowsReparse, readWindowsDacls, type WindowsDaclFacts } from "../../shared/windows-path-facts.js";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../storage/feature-namespace.js";

/**
 * What a host terminal tab showed, kept across a restart of the app. It is the user's own shell output — whatever they printed, secrets included — so it
 * lives in one directory of the Ave home that no confined process is granted (it is not a row of AVE_HOME_READ_REALLOWS) and that the file tools
 * treat as sensitive (its row in SENSITIVE_PATH_ENTRIES), in files only the user can read, and nothing reads it but the terminal view the tab is
 * restored into. It is never a session, a memory or a tool result.
 */
export const TERMINAL_SCROLLBACK_DIRECTORY = "terminal-state";

const SUFFIX = ".scrollback";

/**
 * The settings profile a store's files belong to. Which tabs come back is a profile's saved layout, and several profiles can share one Ave home (a
 * source run's profile, or a native host's `AVE_USER_DATA_DIR`, beside the installed app's), so each file is named for the profile whose tab it is,
 * by this prefix. A profile reads, replaces and sweeps its own files and never another's: a layout says nothing of the tabs of a profile it is not.
 */
export type TerminalScrollbackProfile = string & { readonly __terminalScrollbackProfile: unique symbol };

function profileNamed(directory: string): TerminalScrollbackProfile {
  // The platform's case rule for paths (folded where volumes are case-insensitive by default), after separators and Unicode form.
  const key = caseFoldForMatch(foldCanonicalPathSeparators(directory));
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}-` as TerminalScrollbackProfile;
}

/**
 * The profile whose settings directory is `userDataPath`, named as the filesystem names that directory: a link to it (a symlinked
 * `--user-data-dir`, `/tmp` for `/private/tmp`) or another spelling of it is the same profile. Throws when the directory cannot be resolved.
 */
export function terminalScrollbackProfile(userDataPath: string): TerminalScrollbackProfile {
  return profileNamed(realpathSync.native(userDataPath));
}

/**
 * The profile named from `userDataPath` as given, for a run whose settings directory could not be resolved (terminalScrollbackProfile threw): the
 * store keeps and restores this run's tabs under it. Another spelling of the directory may have named the profile's earlier files, so a caller
 * that uses it sweeps nothing and says why.
 */
export function unresolvedTerminalScrollbackProfile(userDataPath: string): TerminalScrollbackProfile {
  return profileNamed(resolve(userDataPath));
}

/** One file per tab, named by a digest of the tab's id after its profile's prefix: the id comes from a renderer and is never used as a path. */
function nameFor(profile: TerminalScrollbackProfile, tabId: string): string {
  return `${profile}${createHash("sha256").update(tabId).digest("hex").slice(0, 32)}${SUFFIX}`;
}

/** A file named before files carried their profile (a tab's file, or one being staged): no profile owns it, and a sweep deletes it. */
const UNOWNED_NAME = /^[0-9a-f]{32}\.scrollback(?:\.[0-9a-f]{32}\.tmp)?$/u;

/** Every terminal tab a saved layout would bring back: shown in a pane, listed in the sidebar, or a side tab. */
export function savedTerminalTabIds(layout: MainLayoutSnapshot | undefined): Set<string> {
  if (!layout) return new Set();
  const surfaces = [...layout.openSurfaces, ...Object.values(layout.surfaces), ...Object.values(layout.sideTabs).flat()];
  return new Set(surfaces.filter((surface) => surface.kind === "terminal").map((surface) => surface.tabId));
}

export interface TerminalScrollbackStore {
  /** Keep what a tab shows, as its view serialized it; "" keeps nothing and drops what was kept. Nothing larger than a terminal's replay is written. */
  save(tabId: string, output: string): Promise<void>;
  /** The tab's kept output, or null when none was kept. */
  read(tabId: string): Promise<string | null>;
  forget(tabId: string): Promise<void>;
  /** Drop what this profile kept for every tab not in `tabIds` (tabs closed while their window was not showing them, or by another run). Other
   * profiles' files stay. */
  keepOnly(tabIds: ReadonlySet<string>): Promise<void>;
  /** Everything asked of the store so far has finished, whether or not it succeeded. */
  settled(): Promise<void>;
}

/** Reads one kept file without following a link; null when there is none. */
export type KeptFileReader = (path: string) => Promise<Buffer | null>;

/**
 * POSIX: the open itself refuses a link, and the size and the bytes are the opened file's.
 */
const readWithoutFollowing: KeptFileReader = async (path) => {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("kept terminal output is not a file");
    if (info.size > TERMINAL_REPLAY_MAX_BYTES) throw new Error("kept terminal output is larger than a terminal's replay");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

/** The native facts for one path, with the file's content read on the handle the facts describe. */
export type WindowsKeptFileFacts = (path: string) => WindowsDaclFacts | undefined;

/**
 * Windows has no open that refuses a link. The native path walk opens each component without following, reports whether any is a reparse
 * point, and reads the content on the handle it verified: the bytes are those of the object that was checked, whatever the name is pointed at
 * afterwards. It reads at most a terminal's replay and fails on a larger file. A link or any other reparse point, at the file or above it, is
 * refused rather than read.
 */
export function windowsKeptFileReader(facts: WindowsKeptFileFacts = (path) => readWindowsDacls([path], { content: true })[0]): KeptFileReader {
  return async (path) => {
    const row = facts(path);
    if (!row) throw new Error("kept terminal output could not be checked");
    if (!admitWindowsReparse(row, "evidence")) throw new Error("kept terminal output is not a file of its own");
    if (row.exists === false) return null;
    if (row.directory || typeof row.contentHex !== "string") throw new Error("kept terminal output is not a file");
    return Buffer.from(row.contentHex, "hex");
  };
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The store's directory as it must be before anything is read from or written to it: a directory of its own, not a link to one (a link would
 * put the user's output wherever it points, a workspace an agent reads included), and on POSIX closed to everyone but the user. `create` makes
 * it, or closes an existing one that was left open; without it a missing directory is reported as absent.
 */
async function privateDirectory(namespace: FeatureNamespaceHandle, create: boolean): Promise<boolean> {
  const directory = namespace.dir;
  const plain = async (): Promise<boolean> => {
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(directory);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("the kept terminal output directory is not a directory of its own");
    return true;
  };
  const exists = await plain();
  if (!exists && !create) return false;
  if (create) await namespace.childDir(".");
  if (!(await plain())) throw new Error("the kept terminal output directory could not be created");
  if (process.platform !== "win32" && ((await fs.lstat(directory)).mode & 0o077) !== 0) {
    throw new Error("the kept terminal output directory is open to other users");
  }
  return true;
}

/** The store of `profile`'s files, under the Ave home's private namespace for them. Operations run one at a time, in the order they were asked for. */
export function terminalScrollbackStore(
  profile: TerminalScrollbackProfile,
  namespace: FeatureNamespaceHandle = openFeatureNamespace(TERMINAL_SCROLLBACK_DIRECTORY),
  readKept: KeptFileReader = process.platform === "win32" ? windowsKeptFileReader() : readWithoutFollowing,
): TerminalScrollbackStore {
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation);
    tail = run.catch(() => undefined);
    return run;
  };
  // A tab's save that has not started yet: a later save of the tab takes its place instead of queueing behind it, so a tab has at most one save
  // running and one waiting, whatever its view sends. A forget or a sweep that follows it stays after it.
  const waitingSaves = new Map<string, { output: string; done: Promise<void> }>();
  const write = async (tabId: string, output: string): Promise<void> => {
    // Nothing shown (a cleared tab, say): nothing kept, and what was kept before goes.
    if (output === "") {
      if (await privateDirectory(namespace, false)) await fs.rm(join(namespace.dir, nameFor(profile, tabId)), { force: true });
      return;
    }
    if (Buffer.byteLength(output, "utf-8") > TERMINAL_REPLAY_MAX_BYTES) throw new Error("terminal output to keep is larger than a terminal's replay");
    await privateDirectory(namespace, true);
    const name = nameFor(profile, tabId);
    // Staged under a name nobody can have prepared, created exclusively and without following a link, then moved over the tab's file: the
    // move replaces whatever is there (a link included) with this file and its own-user-only mode.
    const staged = `${name}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      const handle = await namespace.createFile(staged);
      try {
        await handle.writeFile(output);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(join(namespace.dir, staged), join(namespace.dir, name));
    } catch (error) {
      await fs.rm(join(namespace.dir, staged), { force: true });
      throw error;
    }
  };
  return {
    save: (tabId, output) => {
      const waiting = waitingSaves.get(tabId);
      if (waiting) {
        waiting.output = output;
        return waiting.done;
      }
      const save = { output, done: Promise.resolve() };
      save.done = inOrder(() => {
        if (waitingSaves.get(tabId) === save) waitingSaves.delete(tabId);
        return write(tabId, save.output);
      });
      waitingSaves.set(tabId, save);
      return save.done;
    },
    read: (tabId) => inOrder(async () => {
      if (!(await privateDirectory(namespace, false))) return null;
      const kept = await readKept(join(namespace.dir, nameFor(profile, tabId)));
      if (kept === null) return null;
      // Written by this module, never larger than a terminal's replay; anything larger is not ours to draw.
      if (kept.byteLength > TERMINAL_REPLAY_MAX_BYTES) throw new Error("kept terminal output is larger than a terminal's replay");
      return kept.toString("utf-8");
    }),
    forget: (tabId) => {
      waitingSaves.delete(tabId);
      return inOrder(async () => {
        if (await privateDirectory(namespace, false)) await fs.rm(join(namespace.dir, nameFor(profile, tabId)), { force: true });
      });
    },
    keepOnly: (tabIds) => {
      waitingSaves.clear();
      return inOrder(async () => {
        if (!(await privateDirectory(namespace, false))) return;
        const wanted = new Set([...tabIds].map((tabId) => nameFor(profile, tabId)));
        // This profile's staging files of a run that did not finish go with the rest, as do files no profile owns; another profile's files are
        // not this layout's to judge.
        for (const name of await fs.readdir(namespace.dir)) {
          const doomed = name.startsWith(profile) ? !wanted.has(name) : UNOWNED_NAME.test(name);
          if (doomed) await fs.rm(join(namespace.dir, name), { force: true, recursive: true });
        }
      });
    },
    settled: () => tail.then(() => undefined),
  };
}
