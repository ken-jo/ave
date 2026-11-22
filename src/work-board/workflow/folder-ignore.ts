import { lstatSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import type { HostGit } from "./host-git.js";
import { IGNORE_PREFIX } from "./workspace-layout.js";
import { isInside, type SeedRules } from "./workspace-seed.js";

const log = createLogger("work-board-stage-workspace");

const RULES = ".gitignore";

/** The matcher takes its rules from the folder's own ignore files alone: none comes from a configuration file or a variable. */
const MATCHER_CONFIG = ["-c", "core.excludesFile="] as const;

interface NameReader {
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

/**
 * Whether file names fold case in `directory`, which holds an ignore file. Git finds this out for a repository by writing into it; the
 * host writes nothing into the folder, so it asks for the ignore file under its name in the other case: the same file answers where
 * names fold, nothing where they do not. Throws when neither is the case, and the seed is then refused.
 */
export function namesFoldCase(directory: string, fs: NameReader = onDisk): boolean {
  const named = fs.list(directory).filter(entry => entry.toLowerCase() === RULES);
  // Two names that differ by case alone stand side by side only where names do not fold.
  if (named.length > 1) return false;
  const name = named[0];
  if (name === undefined) throw new Error("the folder's ignore file is not listed");
  const own = fs.id(join(directory, name));
  const other = fs.id(join(directory, name === RULES ? RULES.toUpperCase() : RULES));
  if (own === undefined) throw new Error("the folder's ignore file is gone");
  if (other === undefined) return false;
  if (other === own) return true;
  throw new Error("the folder's file name rule cannot be told");
}

/** Whether `path` is `folder` or lies beneath it, as both really are on disk. */
function physicallyWithin(folder: string, path: string): boolean {
  const real = (value: string): string => process.platform === "win32" ? realpathSync.native(value).toLowerCase() : realpathSync.native(value);
  const [outer, inner] = [real(folder), real(path)];
  return outer === inner || isInside(outer, inner);
}

/**
 * A plain folder honours its own `.gitignore` files, read by git's matcher. `check-ignore` runs only against a repository, so an empty one
 * is made on first need in a folder of its own under the run root, and `done` removes it through `held.remove` whatever happened in between;
 * `held.check` throws once the run root is no longer the folder the caller holds, and is asked before the folder is made and each time
 * before git is pointed at it. The
 * folder is its work tree for that call and nothing is written into it. Without an ignore file above a path git is not run. A run root that
 * lies inside the folder gets no repository: the call throws before anything is made.
 */
export function plainFolderIgnore(git: HostGit, runRoot: string, root: string, held: { check: () => void; remove: (scratch: string) => void }): { ignored: NonNullable<SeedRules["ignored"]>; done: () => void } {
  let scratch: string | undefined;
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
      // Git reads a repository's case rule from where the repository is; the matcher's is in the run folder, so the rule is read from the
      // folder itself, where its outermost ignore file lies.
      if (folds === undefined) {
        const outermost = [...ruled].filter(([, known]) => known).map(([directory]) => directory).sort((left, right) => left.length - right.length)[0] ?? "";
        folds = namesFoldCase(join(root, outermost));
      }
      if (scratch === undefined) {
        // A home relocated beneath the project would put the repository into the folder the host only reads.
        if (physicallyWithin(root, runRoot)) throw new Error("the run root lies inside the project");
        held.check();
        scratch = mkdtempSync(join(runRoot, IGNORE_PREFIX));
        held.check();
        const made = await git.run(runRoot, ["init", "-q", "--template=", scratch], { isolated: true });
        if (made.code !== 0) throw new Error("the ignore matcher's repository could not be made");
      }
      held.check();
      const checked = await git.run(root, [`--git-dir=${join(scratch, ".git")}`, `--work-tree=${root}`, "check-ignore", "--no-index", "-z", "--stdin"],
        { stdin: paths.map(path => `${path}\0`).join(""), isolated: true, drivers: [...MATCHER_CONFIG, "-c", `core.ignoreCase=${folds}`] });
      // Exit 1: none of them is ignored.
      if (checked.code !== 0 && checked.code !== 1) throw new Error("the folder's ignore rules could not be read");
      return new Set(checked.stdout.split("\0").filter(entry => entry !== ""));
    },
    done: () => {
      if (scratch === undefined) return;
      // What stays is removed by the next boot sweep.
      try { held.remove(scratch); } catch (error) { log.warn("the ignore matcher's folder was not removed: %s", (error as Error).message); }
    },
  };
}
