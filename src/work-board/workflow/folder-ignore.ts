import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import type { HostGit } from "./host-git.js";
import { type OwnedDir, realWithin } from "./owned-fs.js";
import type { SeedRules } from "./workspace-seed.js";

const log = createLogger("work-board-stage-workspace");

const RULES = ".gitignore";

/** The matcher takes its rules from the folder's own ignore files alone: none comes from a configuration file or a variable. */
const MATCHER_CONFIG = ["-c", "core.excludesFile="] as const;

export interface NameReader {
  list(directory: string): string[];
  /** Device and file id of what the path names, without following a link; undefined when nothing is there. */
  id(path: string): string | undefined;
}
const onDisk: NameReader = {
  list: directory => readdirSync(directory),
  id: (path) => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
  },
};

const swapAsciiCase = (name: string): string => name.replace(/[A-Za-z]/gu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
const asciiLower = (name: string): string => name.replace(/[A-Z]/gu, letter => letter.toLowerCase());

/**
 * Whether file names fold case in the project root, as git's `core.ignoreCase` would say of a repository there. Git finds it out by
 * writing into the repository; the host writes nothing into the project, so it asks for an entry of the root under its name in the other
 * case: the same entry answers where names fold, nothing where they do not. Undefined when no entry has a letter to ask with; a throw when
 * the answer is neither, and the seed is then refused.
 */
export function projectFoldsCase(root: string, reader: NameReader = onDisk): boolean | undefined {
  const names = reader.list(root);
  // Two names that differ by case alone stand side by side only where names do not fold.
  if (new Set(names.map(asciiLower)).size < names.length) return false;
  for (const name of names) {
    if (!/[A-Za-z]/u.test(name)) continue;
    const own = reader.id(join(root, name));
    if (own === undefined) continue;
    const other = reader.id(join(root, swapAsciiCase(name)));
    if (other === undefined) return false;
    if (other === own) return true;
    throw new Error("the project root's file name rule cannot be told");
  }
  return undefined;
}

/** The volume part of a reader's id. */
const volumeOf = (id: string | undefined): string | undefined => id?.slice(0, id.lastIndexOf(":"));

/**
 * A plain folder honours its own `.gitignore` files, read by git's matcher. `check-ignore` runs only against a repository, so an empty one
 * is made on first need in a folder of its own that `held.makeTemp` makes under the run root, and `done` removes it through `held.remove`
 * whatever happened in between; `held.check` throws once the run root is no longer the folder the caller holds, and is asked each time
 * before and after git is pointed at it. The
 * folder is its work tree for that call and nothing is written into it. Without an ignore file above a path git is not run. A run root that
 * lies inside the folder gets no repository: the call throws before anything is made.
 *
 * The matcher's case rule is the project root's. A root whose names cannot tell it (none has a letter of the alphabet) is answered for by
 * a folder made and removed in the run root, when that is on the root's volume; on another volume there is no answer and the call throws.
 */
export function plainFolderIgnore(git: HostGit, runRoot: string, root: string, held: { check: () => void; makeTemp: () => OwnedDir; remove: (scratch: OwnedDir) => Promise<void> }, reader: NameReader = onDisk): { ignored: NonNullable<SeedRules["ignored"]>; done: () => Promise<void> } {
  let scratch: OwnedDir | undefined;
  let folds: boolean | undefined;
  const ruled = new Map<string, boolean>();
  const hasRules = (directory: string): boolean => {
    let known = ruled.get(directory);
    if (known === undefined) {
      known = lstatSync(join(root, directory, RULES), { throwIfNoEntry: false }) !== undefined;
      ruled.set(directory, known);
    }
    return known;
  };
  return {
    ignored: async (paths) => {
      const reached = paths.some((path) => {
        const segments = path.replace(/\/$/u, "").split("/");
        return segments.some((_, depth) => hasRules(segments.slice(0, depth).join("/")));
      });
      if (!reached) return new Set<string>();
      // A home relocated beneath the project would put the host's own folders into the folder it only reads.
      if (realWithin(root, runRoot)) throw new Error("the run root lies inside the project");
      // Git reads a repository's case rule from where the repository is; the matcher's is in the run folder, so the rule is read from the
      // project root.
      folds ??= projectFoldsCase(root, reader);
      if (folds === undefined) {
        const volume = volumeOf(reader.id(root));
        if (volume === undefined || volume !== volumeOf(reader.id(runRoot))) throw new Error("the project root's file name rule cannot be told");
        const probe = held.makeTemp();
        try {
          folds = projectFoldsCase(runRoot, { list: () => [basename(probe.path)], id: reader.id });
        } finally {
          await held.remove(probe);
        }
        if (folds === undefined) throw new Error("the project root's file name rule cannot be told");
      }
      if (scratch === undefined) {
        scratch = held.makeTemp();
        const made = await git.run(runRoot, ["init", "-q", "--template=", scratch.path], { isolated: true });
        held.check();
        if (made.code !== 0) throw new Error("the ignore matcher's repository could not be made");
      }
      held.check();
      const checked = await git.run(root, [`--git-dir=${join(scratch.path, ".git")}`, `--work-tree=${root}`, "check-ignore", "--no-index", "-z", "--stdin"],
        { stdin: paths.map(path => `${path}\0`).join(""), isolated: true, drivers: [...MATCHER_CONFIG, "-c", `core.ignoreCase=${folds}`] });
      // Exit 1: none of them is ignored.
      held.check();
      if (checked.code !== 0 && checked.code !== 1) throw new Error("the folder's ignore rules could not be read");
      return new Set(checked.stdout.split("\0").filter(entry => entry !== ""));
    },
    done: async () => {
      if (scratch === undefined) return;
      // What stays is removed by the next boot sweep.
      try { await held.remove(scratch); } catch (error) { log.warn("the ignore matcher's folder was not removed: %s", (error as Error).message); }
    },
  };
}
