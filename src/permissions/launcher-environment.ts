import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../lib/shell-resolver.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";

const LAUNCHER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
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

export function buildLauncherEnvironment(platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32") return { PATH: LAUNCHER_PATH };
  const systemRoot = windowsSystemRoot();
  return {
    Path: win32SystemBinary(""),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemRoot.slice(0, 2),
  };
}

// Everything exported here came from the fixed launcher or the sandbox runtime.
// Reapply the runtime's proxy, trust, and sandbox settings after the target baseline.
const COLLECT_RUNTIME_ENV = [
  "runtime_env=()",
  "while IFS= read -r name; do",
  '  case "$name" in PATH|PWD|OLDPWD|SHLVL|_) continue ;; esac',
  `  runtime_env+=("$name=\${!name}")`,
  "done < <(compgen -e)",
].join("\n");

function targetAssignments(env: NodeJS.ProcessEnv): string[] {
  const assignments: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    assertTargetOperand(name, value, name);
    assignments.push(`${name}=${value}`);
  }
  return assignments;
}

// Keep configured server and hook values out of the pre-boundary process argv.
// The per-process sandbox HOME grants access only to this target and owns cleanup.
export function stageSandboxTargetEnvironment(home: string, env: NodeJS.ProcessEnv): string {
  const path = join(home, `.launch-environment-${randomBytes(12).toString("hex")}`);
  const assignments = targetAssignments(env);
  writeFileSync(path, assignments.map(value => `${value}\0`).join(""), { flag: "wx", mode: 0o600 });
  return path;
}

export function buildSandboxTargetCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  tempDir?: string,
  stagedEnvPath?: string,
): string {
  const base = targetAssignments({ PATH: LAUNCHER_PATH, ...env });
  const temp = tempDir === undefined ? [] : [`TMPDIR=${tempDir}`, `TMP=${tempDir}`, `TEMP=${tempDir}`];
  const staged = stagedEnvPath === undefined ? "" : [
    "staged_env=()",
    'while IFS= read -r -d "" assignment; do staged_env+=("$assignment"); done <&4',
    "",
  ].join("\n");
  const readStaged = stagedEnvPath === undefined ? "" : ` "\${staged_env[@]}"`;
  // The fixed exec shim keeps the executable and every argument out of env's assignment parser.
  const target = ["/bin/bash", "-c", 'exec -- "$@"', "sandbox-target", command, ...args];
  const bootstrap = `${COLLECT_RUNTIME_ENV}\n${staged}exec /usr/bin/env -i -- ${base.map(shellQuote).join(" ")}${readStaged}`
    + ` "\${runtime_env[@]}" `
    + [...temp, ...target].map(shellQuote).join(" ");
  if (stagedEnvPath === undefined) return bootstrap;
  // Open before running any command and close before exec, so read failures cannot start the target.
  return `exec 4<${shellQuote(stagedEnvPath)} || exit 1\n${bootstrap} 4<&-`;
}
