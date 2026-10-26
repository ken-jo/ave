/** Resolve the test home seam here so every test process refuses paths outside its isolated home. */
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";

// Use real filesystem functions despite suite mocks; allow account-home mocks for guard tests.
const nodeRequire = createRequire(import.meta.url);
const { lstatSync, readlinkSync, realpathSync } = nodeRequire("node:fs") as typeof import("node:fs");
const { basename, dirname, join, resolve, sep } = nodeRequire("node:path") as typeof import("node:path");

export const AVE_HOME_ISOLATION_GUARD_ACTIVE: boolean = true;

/** Only test-tmp may reside under the account's real Ave home. */
export function checkResolvedAveHome(home: string): void {
  refuseUnder(home, "resolve AVE_HOME to", [accountAveHome()]);
}

/** Sandbox cleanup must reject real-home paths, including those derived from HOME. */
export function checkSandboxSweepRoot(root: string): void {
  refuseUnder(root, "sweep", [resolve(join(homedir(), ".ave")), accountAveHome()]);
}

/** Use the per-run sandbox base, never the running app's sandbox; refuse tests without an isolated base. */
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

function accountAveHome(): string {
  let accountHome: string;
  try {
    accountHome = userInfo().homedir;
  } catch (error) {
    // Without an account-database entry, HOME is the only available home.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    accountHome = homedir();
  }
  return resolve(join(accountHome, ".ave"));
}

function refuseUnder(path: string, action: string, realHomes: readonly string[]): void {
  // Check both named and resolved paths so links cannot hide real-home access.
  const homes = [...new Set(realHomes.flatMap((home) => [home, canonicalPath(home)]))];
  const paths = [resolve(path), canonicalPath(path)];
  // Treat Windows and macOS paths case-insensitively by default.
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

/** Resolve existing ancestors and dangling links so missing paths cannot hide a real-home target. */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (let hops = 0; ; ) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        if (/^\\\\(?:\?\\UNC\\|[^?.\\])/i.test(current)) return resolve(path);
        throw error;
      }
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

type Seam = typeof import("../../shared/ave-home-test-guard.js");
const conforms: Seam = { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkResolvedAveHome, checkSandboxSweepRoot, testSandboxPrivateBase };
void conforms;
