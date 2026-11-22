import { lstatSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import type { HostGit } from "./host-git.js";
import { IGNORE_PREFIX } from "./workspace-layout.js";
import type { SeedRules } from "./workspace-seed.js";

const log = createLogger("work-board-stage-workspace");

/** The matcher takes its rules from the folder's own ignore files alone, and its case rule from the platform's file names: neither comes
 * from a configuration file, a variable or the repository the host made for it. */
const MATCHER_CONFIG = ["-c", "core.excludesFile=", "-c", `core.ignoreCase=${process.platform === "win32" || process.platform === "darwin"}`] as const;

/**
 * A plain folder honours its own `.gitignore` files, read by git's matcher. `check-ignore` runs only against a repository, so an empty one
 * is made on first need in a folder of its own under the run root, and `done` removes it through `remove` whatever happened in between; the
 * folder is its work tree for that call and nothing is written into it. Without an ignore file above a path git is not run.
 */
export function plainFolderIgnore(git: HostGit, runRoot: string, root: string, remove: (scratch: string) => void): { ignored: NonNullable<SeedRules["ignored"]>; done: () => void } {
  let scratch: string | undefined;
  const ruled = new Map<string, boolean>();
  const hasRules = (directory: string): boolean => {
    let known = ruled.get(directory);
    if (known === undefined) {
      known = lstatSync(join(root, directory, ".gitignore"), { throwIfNoEntry: false }) !== undefined;
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
      if (scratch === undefined) {
        scratch = mkdtempSync(join(runRoot, IGNORE_PREFIX));
        const made = await git.run(runRoot, ["init", "-q", "--template=", scratch], { isolated: true });
        if (made.code !== 0) throw new Error("the ignore matcher's repository could not be made");
      }
      const checked = await git.run(root, [`--git-dir=${join(scratch, ".git")}`, `--work-tree=${root}`, "check-ignore", "--no-index", "-z", "--stdin"],
        { stdin: paths.map(path => `${path}\0`).join(""), isolated: true, drivers: MATCHER_CONFIG });
      // Exit 1: none of them is ignored.
      if (checked.code !== 0 && checked.code !== 1) throw new Error("the folder's ignore rules could not be read");
      return new Set(checked.stdout.split("\0").filter(entry => entry !== ""));
    },
    done: () => {
      if (scratch === undefined) return;
      // What stays is removed by the next boot sweep.
      try { remove(scratch); } catch (error) { log.warn("the ignore matcher's folder was not removed: %s", (error as Error).message); }
    },
  };
}
