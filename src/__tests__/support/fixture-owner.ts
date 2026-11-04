import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { decodeWindowsPathFacts, type WindowsDaclFacts } from "../../shared/windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const localAppDataRoots = new Set<string>();

/** A unique per-test %LOCALAPPDATA% directory that setFixtureOwner accepts; the caller removes it in teardown. */
export function createLocalAppDataFixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(process.env.LOCALAPPDATA!, "ave-fixture-")));
  localAppDataRoots.add(root);
  return root;
}

function inside(root: string, path: string): boolean {
  const within = relative(root, path);
  return within !== ".." && !within.startsWith("..\\") && !isAbsolute(within);
}

export function setFixtureOwner(path: string): void {
  if (process.platform !== "win32") return;
  assertFixturePath(path);
  const system = win32.join(process.env.SystemRoot!, "System32");
  // Read fresh ownership from the non-following native handle. Fixture setup
  // must not compile a managed verifier or cache ownership across mutations.
  const output = execFileSync(resolve("resources/windows-path-kind", process.arch, "ave-path-kind.exe"), ["--dacl", path],
    { encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 8 * 1024 * 1024 });
  const [facts] = decodeWindowsPathFacts(output, 1, "--dacl") as WindowsDaclFacts[];
  if (!facts?.dacl) throw new Error("Fixture ownership is unavailable");
  const { currentUserSid } = facts;
  if (facts.dacl.owner === currentUserSid) return;
  execFileSync(win32.join(system, "icacls.exe"), [path, "/setowner", `*${currentUserSid}`, "/L", "/q"],
    { windowsHide: true, stdio: "pipe" });
}

/** Restore inherited deletion rights after a fixture installs protected owner-only descriptors. */
export function resetFixtureAcls(path: string): void {
  if (process.platform !== "win32") return;
  assertFixturePath(path);
  execFileSync(win32.join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [path, "/reset", "/T", "/L", "/q"], { windowsHide: true, stdio: "pipe" });
}

function assertFixturePath(path: string): void {
  const inTmp = relative(tmpdir(), path) !== "" && inside(tmpdir(), path);
  if (!inTmp && ![...localAppDataRoots].some((root) => inside(root, path))) {
    throw new Error("Fixture ownership changes require a path inside the test temporary directory or a registered %LOCALAPPDATA% fixture root");
  }
}
