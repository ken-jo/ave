import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";

/**
 * Single source of truth for the Ave user-data root.
 *
 * Default: `~/.ave` per architecture §5 + project CLAUDE.md storage
 * namespace convention.
 *
 * Override via `AVE_HOME` env — used by e2e fixtures to point host state at
 * a per-test temp dir so encrypted-secret blobs from a previous dev run on
 * `~/.ave/secrets/` do not bleed into isolated test runs. Consumers that
 * resolve Ave sub-paths MUST go through this helper rather than calling
 * `homedir()` directly, otherwise the env override leaks past one feature.
 */
export function aveHome(): string {
  const home = resolve(process.env.AVE_HOME ?? defaultAveHome());
  // Every store resolves its directory here, so this is where the test runner
  // stops a test that would reach the person's real data (an audit log, a
  // session, a secret). A no-op in the app: see ave-home-test-guard.ts.
  checkResolvedAveHome(home);
  return home;
}

/**
 * The default root, `~/.ave`, whatever `AVE_HOME` says. For the few callers
 * that must recognise the person's real data even while a test or an e2e run
 * points `AVE_HOME` elsewhere.
 */
export function defaultAveHome(): string {
  return resolve(join(homedir(), ".ave"));
}

/**
 * The three names the agent-context doc occupies in `~/.ave`.
 *
 * They are spelled once here because four modules have to agree on them and
 * disagreement is invisible: the seeder decides which file an upgrade marker
 * belongs to, the memory manager decides which file the prompt reads, the IPC
 * domain decides which file an apply writes, and the merge job decides which
 * file it may never write. A second spelling anywhere makes one of those four
 * act on a file the other three do not know about.
 */

/** Live agent context. Seeded from packaged resources; read on every turn. */
export const AGENTS_DOC_NAME = "AGENTS.md";

/**
 * The user's own agent context under keep-latest, composed after the live doc
 * so it wins on conflict. Absent while keep-latest has never been engaged.
 */
export const AGENTS_CUSTOM_DOC_NAME = "agents.custom.md";

/**
 * Review artifact of the model-assisted merge. It is never what the runtime
 * reads: applying it is a separate, explicit write onto the live doc.
 */
export const AGENTS_MERGED_DOC_NAME = "AGENTS.md.merged";

/**
 * How the Ave home directory ended up being protected.
 *
 * Not an implementation detail: `0o700`/`0o600` is a POSIX-only control, so on
 * Windows the same call establishes nothing at all, and the caller has to be
 * able to say which of the two happened rather than assume the first.
 */
export type AveHomePrivacy =
  | { enforcement: "posix-mode"; home: string }
  | { enforcement: "win32-dacl"; home: string; sid: string }
  | {
    enforcement: "none";
    home: string;
    failedPath?: string;
    reason: string;
    category: AveHomePrivacyFailureCategory;
    extraPrincipals?: AveHomePrincipal[];
  };

export type AveHomePrivacyFailureCategory =
  | "system-root-missing"
  | "directory-failed"
  | "identity-failed"
  | "icacls-failed"
  | "read-back-failed"
  | "extra-principals"
  | "not-protected"
  | "invalid-owner-grant";

export interface AveHomePrincipal {
  sid: string;
  account?: string;
}

export interface WindowsDirectoryDacl {
  path: string;
  currentUserSid?: string;
  elevated?: boolean;
  ownerSid?: string;
  protected?: boolean;
  child?: boolean;
  rules?: WindowsAccessRule[];
  category?: AveHomePrivacyFailureCategory;
  error?: string;
}

export interface WindowsAccessRule extends AveHomePrincipal {
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}

/** Seam for the Windows ACL commands, so the argv can be asserted anywhere. */
export interface AveHomePrivacyRuntime {
  platform: NodeJS.Platform;
  readDacls(paths: readonly string[], protect?: boolean): WindowsDirectoryDacl[];
}

const DEFAULT_PRIVACY_RUNTIME: AveHomePrivacyRuntime = {
  platform: process.platform,
  readDacls: readWindowsDirectoryDacls,
};

/**
 * One read-back process for all directories; a read failure keeps its path.
 *
 * The inputs travel as one JSON value in `AVE_DACL_REQUEST`, decoded by
 * ConvertFrom-Json; nothing is spliced into the fixed `-Command` text. This is
 * deliberately not the request-line channel of the resident ACL host
 * (windows-acl-host.ts): that host is spawned once and serves many requests,
 * and a process's environment is fixed at spawn, so per-request data there can
 * only travel on stdin — which in turn needs ASCII-escaped JSON because stdin
 * is decoded through the console input code page. This is a one-shot
 * `execFileSync` per boot with two paths: the environment carries the request
 * exactly once, as UTF-16 on Windows, so no code page can alter a path, and
 * the value is a few hundred characters against a 32,767-character limit.
 * The icacls path rides in the same JSON, resolved here like the PowerShell
 * binary, so no second variable names the system root.
 */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false): WindowsDirectoryDacl[] {
  if (!(process.env.SystemRoot ?? process.env.windir)?.trim()) {
    return paths.map((path) => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $icacls = [string]$request.icacls;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $sid = $identity.User.Value;
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    function Read-Dacl($path, $child) {
      try {
        $acl = Get-Acl -LiteralPath $path;
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
          $principal = @{ sid = $_.IdentityReference.Value; accessControlType = [int]$_.AccessControlType;
            fileSystemRights = [int]$_.FileSystemRights; inheritanceFlags = [int]$_.InheritanceFlags;
            propagationFlags = [int]$_.PropagationFlags; isInherited = $_.IsInherited };
          try { $principal.account = $_.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch {}
          $principal
        });
        @{ path = $path; currentUserSid = $sid; elevated = $elevated;
          ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
          protected = $acl.AreAccessRulesProtected; child = $child; rules = $rules }
      } catch { @{ path = $path; error = $_.Exception.Message } }
    }
    $results = @(foreach ($path in $request.paths) {
      # A directory this call creates is owned by the token user from the start, with
      # the same protected owner-only DACL icacls then grants. A token whose default
      # owner is Administrators would otherwise own it as that group, and a parent's
      # CREATOR OWNER entry would leave an explicit Administrators grant behind.
      if ($request.protect -and -not [System.IO.Directory]::Exists($path)) {
        try {
          $security = [System.Security.AccessControl.DirectorySecurity]::new();
          $security.SetOwner($identity.User);
          $security.SetAccessRuleProtection($true, $false);
          $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'));
          [System.IO.Directory]::CreateDirectory($path, $security) | Out-Null;
        } catch { @{ path = $path; category = 'directory-failed'; error = $_.Exception.Message }; continue }
      }
      if ($request.protect) {
        & $icacls $path '/inheritance:r' '/grant:r' ('*' + $sid + ':(OI)(CI)F') '/q' | Out-Null;
        if ($LASTEXITCODE -ne 0) { @{ path = $path; category = 'icacls-failed'; error = 'Directory permission command failed' }; continue }
      }
      Read-Dacl $path $false
    });
    if ($request.paths.Count -gt 1 -and (Test-Path -LiteralPath $request.paths[1])) {
      try {
        # Immediate children only; deeper entries inherit from the verified, protected secrets/ DACL.
        $results += @(Get-ChildItem -LiteralPath $request.paths[1] -Force | ForEach-Object { Read-Dacl $_.FullName $true });
      } catch { $results += @{ path = $request.paths[1]; error = $_.Exception.Message } }
    }
    ConvertTo-Json -InputObject @($results) -Depth 5 -Compress`,
  ], { encoding: "utf-8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ paths, protect, icacls: win32SystemBinary("icacls") }) }) });
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length < paths.length) {
    throw new Error("Directory DACL read-back returned an invalid result set");
  }
  return results;
}

function isOwnerOnlyDacl(descriptor: WindowsDirectoryDacl, sid: string): boolean {
  // A home this app creates is owned by the user (rule 1 of "Windows object
  // ownership" in docs/architecture/architecture.md). One that already exists,
  // chosen by the user or left by an earlier run, follows rule 2: an elevated
  // token may have created it Administrators-owned. The grant
  // still belongs only to the token user; group Allow entries are never accepted.
  const ownerValid = descriptor.ownerSid === sid ||
    (descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544");
  const rule = descriptor.rules?.[0];
  return ownerValid && descriptor.rules?.length === 1 && rule?.sid === sid &&
    rule.accessControlType === 0 && rule.fileSystemRights === 2032127 &&
    rule.inheritanceFlags === 3 && rule.propagationFlags === 0 && rule.isInherited === false;
}

let bootHomePrivacy: AveHomePrivacy | undefined;
let extensionsWithoutIsolationApproved = false;
let reportPrivacyRefusal: ((message: string) => void) | undefined;

/** Main-process audit wiring; no renderer or extension owns this state. */
export function setAveHomePrivacyRefusalReporter(reporter: (message: string) => void): void {
  reportPrivacyRefusal = reporter;
}

export function areExtensionsWithoutIsolationApproved(): boolean {
  return getAveHomePrivacyFailure() !== undefined && extensionsWithoutIsolationApproved;
}

/** Called only by the trusted, gesture-checked permissions IPC handler. */
export function approveExtensionsWithoutIsolation(): void {
  if (getAveHomePrivacyFailure() === undefined) throw new Error("Home privacy approval is not applicable");
  extensionsWithoutIsolationApproved = true;
}

/** Boot publishes this once before confinement starts; folder permission repairs require a restart. */
export function setAveHomePrivacyAtBoot(privacy: AveHomePrivacy): void {
  if (JSON.stringify(bootHomePrivacy) !== JSON.stringify(privacy)) extensionsWithoutIsolationApproved = false;
  bootHomePrivacy = Object.freeze(structuredClone(privacy));
}

/** The failed path is safe to show; command diagnostics stay in the host log. */
export function getAveHomePrivacyFailure(): Extract<AveHomePrivacy, { enforcement: "none" }> | undefined {
  return process.platform === "win32" && bootHomePrivacy?.enforcement === "none"
    ? bootHomePrivacy
    : undefined;
}

/** Guard initialization and each confined extension effect boundary. */
export function assertAveHomePrivacyForConfinement(): void {
  if (process.platform !== "win32") return;
  if (bootHomePrivacy?.enforcement !== "win32-dacl" && bootHomePrivacy?.enforcement !== "none") {
    throw new Error("Extension confinement refused: home privacy not established (boot did not publish AVE_HOME protection)");
  }
  const failure = getAveHomePrivacyFailure();
  if (failure !== undefined) {
    const principals = failure.extraPrincipals?.map(({ sid, account }) => account ? `${sid} (${account})` : sid).join(", ");
    const message = `Extension isolation is off: AVE_HOME privacy could not be established (${failure.category}, ${failure.failedPath ?? failure.home}). Approve running without isolation in Settings > Permissions, or fix the folder permissions.${principals ? ` Extra principals: ${principals}.` : ""}`;
    reportPrivacyRefusal?.(message);
    throw new Error(message);
  }
}

/** Test teardown only; production seals the result during boot. */
export function _resetAveHomePrivacyForTest(): void {
  bootHomePrivacy = undefined;
  extensionsWithoutIsolationApproved = false;
  reportPrivacyRefusal = undefined;
}

/**
 * Resolve a Windows system executable by absolute path rather than letting
 * `PATH` decide which binary answers to the name.
 *
 * Both reasons are load-bearing for a security control. A PATH that puts a
 * POSIX toolchain (Git Bash, MSYS2, Cygwin) ahead of `System32` — the ordinary
 * state of a developer machine, and reachable on an end-user one — resolves
 * `whoami` to a coreutils binary that rejects `/user` as an operand. The DACL
 * call below then never runs, `ensureAveHomePrivate` reports `"none"`, and
 * `~/.ave` keeps whatever ACL it inherited while the app carries on. And a
 * control that decides who may read `secrets/` must not execute whichever
 * `whoami.exe` an earlier PATH entry happens to name.
 *
 * `SystemRoot` is set by the Windows session itself. If it is somehow absent
 * the bare name is still tried, which is exactly today's behaviour rather than
 * a new failure mode.
 */
export function win32SystemBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, "System32", `${name}.exe`) : name;
}

/**
 * Create `~/.ave` and restrict it to the account running the app.
 *
 * `~/.ave` holds `settings.json`, `audit.log` and `secrets/`, and the whole
 * tree is created with `mode: 0o700` / `0o600` — which Windows ignores. Node
 * maps `mode` onto the FAT read-only ATTRIBUTE there and never onto an ACL, so
 * on Win32 those numbers describe an intent that nothing enforces: what
 * actually decides who may read the file is the DACL the directory hands down.
 * Inside `%USERPROFILE%` that inherited DACL happens to already exclude other
 * users; anywhere else `AVE_HOME` may point — `C:\\ProgramData`, a data drive,
 * a share — it does not, and nothing in the app would notice.
 *
 * So on Win32 this sets the DACL explicitly: inheritance dropped, one Full
 * Control ACE for the current user's SID, marked `(OI)(CI)` so every file and
 * folder created underneath inherits it. That is the closest equivalent of
 * `0o700` the platform has. SYSTEM and Administrators are deliberately not
 * granted — they can still take ownership, which is exactly the residual root
 * holds under `0o700` as well.
 *
 * Failure is REPORTED, never swallowed: the result says `"none"` with the
 * reason so boot can refuse confinement whose private storage is unprotected.
 * Secrets also get an independent protected DACL, checked by the same reader.
 */
export function ensureAveHomePrivate(
  home = aveHome(),
  runtime: AveHomePrivacyRuntime = DEFAULT_PRIVACY_RUNTIME,
): AveHomePrivacy {
  if (runtime.platform !== "win32") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return { enforcement: "posix-mode", home };
  }
  let path = home;
  let category: AveHomePrivacyFailureCategory = "directory-failed";
  try {
    // The protecting step creates the home and its secrets directory itself, so
    // each is owned by the current user from the start ("Windows object
    // ownership" in docs/architecture/architecture.md). Only the parent is made here.
    mkdirSync(dirname(home), { recursive: true });
    category = "read-back-failed";
    path = home;
    const paths = [home, join(home, "secrets")];
    const descriptors = runtime.readDacls(paths, true);
    const sid = descriptors[0]?.currentUserSid;
    for (const target of paths) {
      if (!descriptors.some((entry) => entry.path === target && !entry.child)) {
        throw new Error("Directory DACL read-back missing");
      }
    }
    for (const descriptor of descriptors) {
      path = descriptor.path;
      if (descriptor.error !== undefined) {
        category = descriptor.category ?? "read-back-failed";
        throw new Error(descriptor?.error ?? "Directory DACL read-back missing");
      }
      if (typeof sid !== "string" || !/^S-1-[0-9-]+$/.test(sid) || descriptor.currentUserSid !== sid) {
        category = "identity-failed";
        throw new Error("Current account SID read-back is invalid");
      }
      if (!Array.isArray(descriptor.rules) || descriptor.rules.some((rule) =>
        typeof rule.sid !== "string" || !/^S-1-[0-9-]+$/.test(rule.sid) ||
        ![0, 1].includes(rule.accessControlType) || !Number.isInteger(rule.fileSystemRights) ||
        !Number.isInteger(rule.inheritanceFlags) || !Number.isInteger(rule.propagationFlags) ||
        typeof rule.isInherited !== "boolean")) {
        throw new Error("Directory DACL rules read-back is invalid");
      }
      const extraPrincipals = [...new Map(descriptor.rules
        .filter((rule) => rule.sid !== sid && (!descriptor.child || (rule.accessControlType === 0 && !rule.isInherited)))
        .map(({ sid, account }) => [sid, { sid, ...(account ? { account } : {}) }])).values()];
      if (extraPrincipals.length > 0) {
        return { enforcement: "none", home, failedPath: path, category: "extra-principals", extraPrincipals,
          reason: "Remove the extra principal entries or move AVE_HOME" };
      }
      if (descriptor.child) continue;
      if (descriptor.protected !== true) {
        return { enforcement: "none", home, failedPath: path, category: "not-protected", reason: "Directory DACL is not protected against inheritance" };
      }
      if (!isOwnerOnlyDacl(descriptor, sid)) {
        return { enforcement: "none", home, failedPath: path, category: "invalid-owner-grant", reason: "Directory DACL is not owner-only FullControl with object and container inheritance" };
      }
    }
    if (!sid) throw new Error("Current account SID read-back missing");
    return { enforcement: "win32-dacl", home, sid };
  } catch (err) {
    return { enforcement: "none", home, failedPath: path, category, reason: (err as Error).message };
  }
}
