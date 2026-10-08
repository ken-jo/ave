/**
 * The test runner's stand-in for `src/shared/ave-home-test-guard.ts`: the
 * checks that keep a test out of the developer's real `~/.ave`.
 *
 * `vitest.analysis.config.ts` resolves every import of the app's module to
 * this one, so the checks run in every test process and in no build. Each test
 * file starts in its own home under `~/.ave/test-tmp`
 * (`src/__tests__/vitest-ave-home.ts`); these refuse one that resolves past
 * it anyway — a test that cleared AVE_HOME, or pointed it into the real home.
 */
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";

// The file system and path arithmetic come from Node itself, past any
// `vi.mock("node:fs")` a suite has: the guard runs inside every suite,
// including those that replace the file system with a handful of stubs.
// `node:os` is imported as usual, so a suite can stand a scratch account in
// for the person's by mocking `userInfo()` or `homedir()`.
const nodeRequire = createRequire(import.meta.url);
const { lstatSync, readlinkSync, realpathSync } = nodeRequire("node:fs") as typeof import("node:fs");
const { basename, dirname, join, resolve, sep } = nodeRequire("node:path") as typeof import("node:path");

export const AVE_HOME_ISOLATION_GUARD_ACTIVE: boolean = true;

/**
 * Refuse an Ave home inside the account's own `~/.ave` other than its
 * `test-tmp`. Only the account's home counts here: a test that points HOME or
 * a mocked `homedir()` at a scratch directory and keeps its Ave home there is
 * isolated.
 */
export function checkResolvedAveHome(home: string): void {
  refuseUnder(home, "resolve AVE_HOME to", [accountAveHome()]);
}

/**
 * Refuse a sandbox root inside the real `~/.ave` other than `test-tmp`: what
 * is there belongs to a running app, the HOMEs and temp directories of its
 * confined processes, which a sweep deletes. Stricter than
 * {@link checkResolvedAveHome} for an action this destructive: HOME's
 * `~/.ave` counts as real too, so the guard's own tests can stand a scratch
 * directory in for it.
 */
export function checkSandboxSweepRoot(root: string): void {
  refuseUnder(root, "sweep", [resolve(join(homedir(), ".ave")), accountAveHome()]);
}

/**
 * For a test that clears AVE_HOME, the per-run directory
 * `vitest.globalSetup.ts` makes (`AVE_TEST_SANDBOX_BASE`) holds the sandbox
 * private roots: never `~/.ave/sandbox`, which a running app's boot empties.
 * A test process without it is refused rather than defaulted to the real one.
 */
export function testSandboxPrivateBase(): string | undefined {
  if (process.env.AVE_HOME !== undefined) return undefined;
  const base = process.env.AVE_TEST_SANDBOX_BASE;
  if (base === undefined || base === "") {
    throw new Error(
      "sandbox: a test process with no AVE_HOME needs AVE_TEST_SANDBOX_BASE, which vitest.globalSetup.ts sets, "
        + "so no test resolves the real ~/.ave/sandbox",
    );
  }
  return base;
}

/** The account's own `~/.ave`, from the account database rather than HOME. */
function accountAveHome(): string {
  let accountHome: string;
  try {
    accountHome = userInfo().homedir;
  } catch (error) {
    // A container user with no passwd entry has no account record; HOME is
    // then the only home there is.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    accountHome = homedir();
  }
  return resolve(join(accountHome, ".ave"));
}

function refuseUnder(path: string, action: string, realHomes: readonly string[]): void {
  // Each side as named and as the file system resolves it: HOME may be reached
  // through a link (`/tmp` is `/private/tmp` on macOS), and so may the path.
  const homes = [...new Set(realHomes.flatMap((home) => [home, canonicalPath(home)]))];
  const paths = [resolve(path), canonicalPath(path)];
  // macOS and Windows file systems ignore case by default: `/Users/Me/.AVE`
  // is the same directory.
  const fold = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
  const inside = (candidate: string, dir: string) =>
    fold(candidate) === fold(dir) || fold(candidate).startsWith(fold(dir).replace(/[\\/]+$/, "") + sep);
  for (const real of homes) {
    const sanctioned = join(real, "test-tmp");
    for (const candidate of paths) {
      if (inside(candidate, real) && !inside(candidate, sanctioned)) {
        throw new Error(`refusing to ${action} ${path} from a test process; it is under the real ${real}`);
      }
    }
  }
}

/**
 * Where `path` lands once created: the nearest ancestor that exists, as the
 * file system resolves it, with the missing components after it. A path that
 * does not exist yet is exactly what a store is about to create, so naming it
 * through a link to the real home (or `/tmp` for `/private/tmp`) must not hide
 * where it goes. A dangling link on the way is followed to its target.
 */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (let hops = 0; ; ) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    let link: string | undefined;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        throw error;
      }
    }
    if (link !== undefined) {
      // Linux allows 40 links in one resolution; past that the path is a loop.
      if (++hops > 40) throw new Error(`too many links resolving ${path}`);
      current = resolve(dirname(current), link);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...missing);
    missing.unshift(basename(current));
    current = parent;
  }
}

// The guard stands in for the app's seam, so it must offer what the seam does.
// Type-only: nothing of the seam loads.
type Seam = typeof import("../../shared/ave-home-test-guard.js");
const conforms: Seam = { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkResolvedAveHome, checkSandboxSweepRoot, testSandboxPrivateBase };
void conforms;
