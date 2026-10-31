import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, win32 } from "node:path";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "../../shared/windows-owner-claim.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";

let currentUserSid: string | undefined;
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
  currentUserSid ??= /\bS-1-(?:\d+-)*\d+\b/.exec(execFileSync(win32.join(system, "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }))?.[0];
  if (!currentUserSid) throw new Error("Fixture current-user SID is unavailable");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${WINDOWS_OWNER_CLAIM_SOURCE}\n'@\n[WindowsOwnerClaim]::Owner($env:AVE_OWNER_FIXTURE)`;
  const owner = execFileSync(win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env, AVE_OWNER_FIXTURE: path }) }).trim();
  if (owner === currentUserSid) return;
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
