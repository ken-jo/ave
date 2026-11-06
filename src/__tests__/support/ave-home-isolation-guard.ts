/** Resolve the test home seam here so every test process refuses paths outside its isolated home. */
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { inject } from "vitest";
import { canonicalPath } from "./test-tmp-root.js";

export { canonicalPath };

declare module "vitest" {
  export interface ProvidedContext {
    realProgramData: string | null;
    realAccountHome: string;
    /** The AVE_TEST_TMP_ROOT global setup validated, or null when the run uses the default roots. */
    explicitTestTmpRoot: string | null;
  }
}

// Use real filesystem functions despite suite mocks; allow account-home mocks for guard tests.
const nodeRequire = createRequire(import.meta.url);
const { join, resolve, sep } = nodeRequire("node:path") as typeof import("node:path");

export const AVE_HOME_ISOLATION_GUARD_ACTIVE: boolean = true;

/** Only test-tmp may reside under the account's real Ave home. */
export function checkResolvedAveHome(home: string): void {
  refuseUnder(home, "resolve AVE_HOME to", [accountAveHome()]);
}

/** Sandbox cleanup must reject real-home paths, including those derived from HOME. */
export function checkSandboxSweepRoot(root: string): void {
  refuseUnder(root, "sweep", [resolve(join(homedir(), ".ave")), accountAveHome()]);
}

/** Never let policy readers or native sandbox setup enter the machine policy root. */
export function checkAdminPolicyPath(path: string): void {
  const realProgramData = inject("realProgramData");
  if (realProgramData === undefined) {
    throw new Error("admin policy isolation requires realProgramData captured by vitest.globalSetup.ts before redirecting ProgramData");
  }
  if (realProgramData === null) return;
  refuseUnder(path, "access admin policy at", [resolve(realProgramData), resolve("C:\\ProgramData")], false, true);
}

export function checkSandboxStampTargets(paths: readonly string[]): void {
  const realAccountHome = inject("realAccountHome");
  const realProgramData = inject("realProgramData");
  if (!realAccountHome || realProgramData === undefined) {
    throw new Error("sandbox stamp isolation requires realAccountHome and realProgramData captured by vitest.globalSetup.ts before redirecting paths");
  }
  for (const path of paths) {
    const action = "stamp or grant sandbox target; constrain the test's deny/allow targets to fixtures:";
    // Windows runs keep TEMP under the profile (runTmpRoot in test-run-dirs.ts), so fixtures there are the run's own.
    const sanctioned = [
      join(realAccountHome, ".ave", "test-tmp"),
      ...(process.platform === "win32" ? [join(realAccountHome, ".ave-test-tmp")] : []),
      ...explicitTestTmpRoot(),
    ];
    refuseUnder(path, action, [resolve(realAccountHome)], true, true, sanctioned);
    if (realProgramData !== null) {
      refuseUnder(path, action, [resolve(realProgramData), resolve("C:\\ProgramData")], false, true);
    }
  }
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

/** The caller's explicit scratch root, as global setup validated it against the real account home; nothing wider is
 * sanctioned. It is read only from the provided context, so a test that changes AVE_TEST_TMP_ROOT cannot widen the guard. */
function explicitTestTmpRoot(): string[] {
  const root = inject("explicitTestTmpRoot");
  if (root === undefined) {
    throw new Error("Ave home isolation requires explicitTestTmpRoot provided by vitest.globalSetup.ts");
  }
  return root === null ? [] : [root];
}

function refuseUnder(path: string, action: string, realHomes: readonly string[], allowTestTmp = true, caseInsensitive = process.platform !== "linux", testTmpRoots?: readonly string[]): void {
  // Check both named and resolved paths so links cannot hide real-home access.
  const homes = [...new Set(realHomes.flatMap((home) => [home, canonicalPath(home)]))];
  const paths = [resolve(path), canonicalPath(path)];
  // Treat Windows and macOS paths case-insensitively by default.
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const inside = (candidate: string, dir: string) =>
    fold(candidate) === fold(dir) || fold(candidate).startsWith(fold(dir).replace(/[\\/]+$/, "") + sep);
  for (const real of homes) {
    // A guard test may mock the account home into the run's own scratch; never sanction a root that holds the home checked.
    const sanctioned = testTmpRoots ?? [join(real, "test-tmp"), ...explicitTestTmpRoot().filter((root) => !inside(real, root))];
    for (const candidate of paths) {
      if (inside(candidate, real) && !(allowTestTmp && sanctioned.some((root) => inside(candidate, root)))) {
        throw new Error(`refusing to ${action} ${path} from a test process; it is under the real ${real}`);
      }
    }
  }
}

type Seam = typeof import("../../shared/ave-home-test-guard.js");
const conforms: Seam = { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkResolvedAveHome, checkSandboxSweepRoot, checkAdminPolicyPath, checkSandboxStampTargets, testSandboxPrivateBase };
void conforms;
