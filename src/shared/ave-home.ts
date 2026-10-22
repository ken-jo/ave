import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";

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
  | { enforcement: "none"; home: string; failedPath?: string; reason: string };

/** Seam for the Windows ACL commands, so the argv can be asserted anywhere. */
export interface AveHomePrivacyRuntime {
  platform: NodeJS.Platform;
  run(file: string, args: readonly string[]): string;
  readDacl(path: string): string;
}

const DEFAULT_PRIVACY_RUNTIME: AveHomePrivacyRuntime = {
  platform: process.platform,
  run: (file, args) =>
    execFileSync(file, [...args], { encoding: "utf-8", windowsHide: true }),
  readDacl: readWindowsDirectoryDacl,
};

/** Read only the access descriptor, without localized account names. */
export function readWindowsDirectoryDacl(path: string): string {
  const literalPath = path.replace(/'/g, "''");
  return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath '${literalPath}'; $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`,
  ], { encoding: "utf-8", windowsHide: true }).trim();
}

function isOwnerOnlyDacl(sddl: string, sid: string): boolean {
  const match = /^D:((?:P|AI|AR)*)\(A;(OICI|CIOI);(FA|0x001f01ff|0x1f01ff);;;(S-1-[0-9-]+)\)$/.exec(sddl.trim());
  return match !== null && match[1].includes("P") && match[4] === sid;
}

let bootHomePrivacy: AveHomePrivacy | undefined;

/** Boot publishes this before any confinement backend can start. */
export function setAveHomePrivacyAtBoot(privacy: AveHomePrivacy): void {
  bootHomePrivacy = Object.freeze({ ...privacy });
}

/** The failed path is safe to show; command diagnostics stay in the host log. */
export function getAveHomePrivacyFailurePath(): string | undefined {
  return process.platform === "win32" && bootHomePrivacy?.enforcement === "none"
    ? bootHomePrivacy.failedPath ?? bootHomePrivacy.home
    : undefined;
}

/** Guard initialization and each confined extension effect boundary. */
export function assertAveHomePrivacyForConfinement(): void {
  const path = getAveHomePrivacyFailurePath();
  if (path !== undefined) {
    throw new Error(`Extension confinement refused: owner-only directory protection could not be verified for ${path}`);
  }
}

/** Test teardown only; production seals the result during boot. */
export function _resetAveHomePrivacyForTest(): void {
  bootHomePrivacy = undefined;
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
 * Parse the current account's SID out of `whoami /user /fo csv /nh`, whose one
 * line is `"DOMAIN\\user","S-1-5-21-…"`. The SID is used rather than the name
 * because account names are localized and domain-qualified, and `icacls`
 * resolves a wrong name into a wrong ACE instead of an error.
 */
function parseCurrentUserSid(whoamiCsv: string): string {
  const match = /"(S-1-[0-9-]+)"\s*$/m.exec(whoamiCsv.trim());
  if (!match) throw new Error(`could not read the current user SID from: ${whoamiCsv.trim()}`);
  return match[1];
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
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const sid = parseCurrentUserSid(
      runtime.run(win32SystemBinary("whoami"), ["/user", "/fo", "csv", "/nh"]),
    );
    for (path of [home, join(home, "secrets")]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      runtime.run(win32SystemBinary("icacls"), [
        path,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "/q",
      ]);
      if (!isOwnerOnlyDacl(runtime.readDacl(path), sid)) {
        throw new Error("Directory DACL is not protected owner-only FullControl with object and container inheritance");
      }
    }
    return { enforcement: "win32-dacl", home, sid };
  } catch (err) {
    return { enforcement: "none", home, failedPath: path, reason: (err as Error).message };
  }
}
