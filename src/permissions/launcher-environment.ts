import type { ChildProcess, StdioOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { shellQuote } from "../lib/shell-resolver.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { srtWinStateEnvironment } from "./srt-win-integrity.js";

const LAUNCHER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// fd 3 is used by the process-group launch gate or by the plugin protocol.
const TARGET_ENV_FD = 4;
// The shim writes one byte here only when setup fails before exec; the exec line closes it.
const TARGET_STATUS_FD = 5;
const SETUP_FAILURE_CODE = 1;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const WINDOWS_LAUNCHER_ROOT_KEYS = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE"]);
const STARTUP_ENV_GROUPS = [
  /^(BASH_ENV|ENV|ZDOTDIR)$/u, // Select shell startup files.
  /^(SHELLOPTS|BASHOPTS|BASH_COMPAT|POSIXLY_CORRECT)$/u, // Change shell startup modes and options.
  /^(PS4|BASH_XTRACEFD)$/u, // Expand tracing text or redirect tracing at startup.
  /^(IFS|CDPATH|GLOBIGNORE)$/u, // Change shell splitting, directory lookup or globbing.
  /^(BASH_FUNC_.*|FPATH)$/u, // Import or autoload shell functions.
  /^(LD_.*|DYLD_.*|_RLD.*|LIBPATH|SHLIB_PATH|GLIBC_TUNABLES)$/u, // Configure dynamic object loading.
  /^(GCONV_PATH|LOCPATH|NLSPATH)$/u, // Redirect loader, locale or message-catalog lookups.
] as const;
const SHELL_PARAMETER_NAMES = new Set([
  "UID", "EUID", "PPID", "BASH", "BASHOPTS", "SHELLOPTS", "BASHPID",
  "DIRSTACK", "FUNCNAME", "GROUPS", "PIPESTATUS", "LINENO", "RANDOM", "SRANDOM", "SECONDS", "SHLVL",
  "_", "HISTCMD", "OPTIND", "EPOCHSECONDS", "EPOCHREALTIME",
]);

class LauncherEnvironmentError extends Error {
  readonly code = "launcher-environment-refused";

  constructor(name: string, reason: string) {
    super(`Environment variable ${JSON.stringify(name)} ${reason}`);
    this.name = "LauncherEnvironmentError";
  }
}

function assertTargetOperand(name: string, value: string, folded: string): void {
  if (!ENV_NAME.test(name) || name.endsWith("\n") || value.includes("\0")) {
    throw new LauncherEnvironmentError(name, "is not a valid environment assignment");
  }
  if (STARTUP_ENV_GROUPS.some(group => group.test(folded))) {
    throw new LauncherEnvironmentError(name, "is reserved for launcher startup");
  }
}

export function assertConfiguredLauncherEnvironment(env: NodeJS.ProcessEnv): void {
  const windows = process.platform === "win32";
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const folded = windows ? name.toUpperCase() : name;
    assertTargetOperand(name, value, folded);
    if (folded === "PATH") {
      throw new LauncherEnvironmentError(name, "is reserved for launcher program lookup");
    }
    if (windows && WINDOWS_LAUNCHER_ROOT_KEYS.has(folded)) {
      throw new LauncherEnvironmentError(name, "is reserved for the launcher's system directory");
    }
  }
}

// The wrapper's outer `/bin/bash -c` runs on the host. With stdin on a socket (a Node "pipe") and SHLVL below 2 after its own
// increment, bash treats itself as started by a remote shell daemon and sources the host user's ~/.bashrc, even with `-c`
// (bash shell.c run_startup_files; "Invoked by remote shell daemon" in the manual). Its exports then reach the target shim as
// runtime environment and outrank the declared entries. A launcher SHLVL of 1 keeps every shell in the chain at 2 or above;
// `exec` lowers it before the next shell raises it again. The shim drops SHLVL from the runtime set, and targets cannot declare it.
const LAUNCHER_SHELL_LEVEL = "1";

export function buildLauncherEnvironment(platform: NodeJS.Platform = process.platform, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (platform !== "win32") return { PATH: LAUNCHER_PATH, SHLVL: LAUNCHER_SHELL_LEVEL };
  const systemRoot = windowsSystemRoot();
  return {
    Path: win32SystemBinary(""),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemRoot.slice(0, 2),
    // The launcher opens its ACL ledger from these. The child's profile starts from the sandbox account's own environment.
    ...srtWinStateEnvironment(hostEnv),
  };
}

const TARGET_ENV_SHIM = [
  // Keep setup diagnostics private. The gate uses fd 3, the payload fd 4 and the setup status fd 5.
  `setup_failed() { printf '\\00${SETUP_FAILURE_CODE}' >&${TARGET_STATUS_FD}; exit 1; }`,
  "exec 9>&2 2>/dev/null || setup_failed",
  "apply_target_env() {",
  "  unset name assignment target_env runtime_env",
  '  export -- "$@"',
  "}",
  // Preserve the runtime's proxy, trust, and sandbox settings over the target baseline.
  "runtime_env=()",
  "while IFS= read -r name; do",
  '  case "$name" in PATH|PWD|OLDPWD|SHLVL|_) continue ;; esac',
  `  runtime_env+=("$name=\${!name}")`,
  "done < <(compgen -e)",
  'if [[ -n "$1" ]]; then runtime_env+=("TMPDIR=$1" "TMP=$1" "TEMP=$1"); fi',
  "shift",
  "target_env=()",
  `while IFS= read -r -d '' assignment <&${TARGET_ENV_FD}; do`,
  '  if [[ -z "$assignment" ]]; then',
  `    exec ${TARGET_ENV_FD}<&-`,
  "    unset OLDPWD",
  `    apply_target_env "\${target_env[@]}" "\${runtime_env[@]}" || setup_failed`,
  `    exec 2>&9 9>&- ${TARGET_STATUS_FD}>&- -- "$@"`,
  "  fi",
  '  target_env+=("$assignment")',
  "done",
  // A complete frame ends with an empty record. A closed or truncated pipe cannot start the target.
  "setup_failed",
].join("\n");

function targetAssignments(env: NodeJS.ProcessEnv): string[] {
  const assignments: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    assertTargetOperand(name, value, name);
    if (SHELL_PARAMETER_NAMES.has(name) || name.startsWith("BASH_")) {
      throw new LauncherEnvironmentError(name, "cannot be delivered by the sandbox shell");
    }
    assignments.push(`${name}=${value}`);
  }
  return assignments;
}

const setupStatus = new WeakMap<ChildProcess, Promise<boolean>>();

// Read from spawn on: unread stdio holds the child's close. Wrapper relays can keep the fd open past exit.
function watchSetupStatus(child: ChildProcess): void {
  const status = (child.stdio as readonly unknown[] | undefined)?.[TARGET_STATUS_FD];
  if (!(status instanceof Readable)) return;
  setupStatus.set(child, new Promise(resolve => {
    status.once("data", () => resolve(true));
    status.once("end", () => resolve(false));
    status.once("close", () => resolve(false));
    status.once("error", () => resolve(false));
    status.resume();
  }));
}

/** True when the shim reported a pre-exec setup failure; undefined for a launch without a status pipe. */
export function sandboxTargetSetupFailed(child: ChildProcess): Promise<boolean> | undefined {
  return setupStatus.get(child);
}

export interface SandboxTargetLaunch {
  readonly command: string;
  withStdio(stdio: StdioOptions): StdioOptions;
  sendEnvironment(child: ChildProcess): void;
}

export function prepareSandboxTargetLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  tempDir?: string,
): SandboxTargetLaunch {
  const assignments = targetAssignments({ ...env, PATH: env.PATH ?? LAUNCHER_PATH });
  const payload = Buffer.from(`${assignments.join("\0")}\0\0`);
  const target = ["/bin/bash", "-c", TARGET_ENV_SHIM, "sandbox-target", tempDir ?? "", command, ...args];
  return {
    command: `exec ${target.map(shellQuote).join(" ")}`,
    withStdio(stdio) {
      const entries = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
      if (entries[TARGET_ENV_FD] != null || entries[TARGET_STATUS_FD] != null) {
        throw new Error("Sandbox environment pipe requires fds 4 and 5");
      }
      entries[3] ??= "ignore";
      entries[TARGET_ENV_FD] = "pipe";
      entries[TARGET_STATUS_FD] = "pipe";
      return entries;
    },
    sendEnvironment(child) {
      watchSetupStatus(child);
      const pipe = child.stdio?.[TARGET_ENV_FD];
      if (!(pipe instanceof Writable)) return;
      // The wrapper can exit before reading. A pipe error leaves the shim without a complete frame.
      pipe.on("error", () => pipe.destroy());
      pipe.end(payload);
    },
  };
}
