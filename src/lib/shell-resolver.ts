import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";

export class ShellMismatchError extends Error {
  readonly code = "SHELL_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "ShellMismatchError";
  }
}

type WindowsShellFlavor = "msys" | "wsl" | "unknown";

export type ResolvedShellCommand = {
  cmd: string;
  shellArgs: (script: string) => string[];
  windowsFlavor?: WindowsShellFlavor;
};

type ShellDialect = "posix" | "bash";

const cachedShells = new Map<ShellDialect, ResolvedShellCommand>();
const cachedErrors = new Map<ShellDialect, ShellMismatchError>();
const SHELL_PROBE_TIMEOUT_MS = 20_000;
export interface BashCapabilities {
  readonly unicodeEscapes: boolean;
  readonly prefixAssignmentRhs: "incoming" | "sequential";
}
const bashCapabilities = new WeakMap<ResolvedShellCommand, Map<string, Readonly<BashCapabilities>>>();

/** Probes run fixed native controls, never caller command text. */
export function getBashCapabilities(
  shell: ResolvedShellCommand,
  environment: Readonly<Record<string, string>>,
  cwd: string,
): Readonly<BashCapabilities> {
  const locale = JSON.stringify([environment.LC_ALL, environment.LC_CTYPE, environment.LANG]);
  let entries = bashCapabilities.get(shell);
  const cached = entries?.get(locale);
  if (cached) return cached;
  const child = `${shellQuote(shellPathForHostPath(shell, shell.cmd))} -c ${shellQuote('printf "%s\\0" "$AVE_PROBE_RHS"')}`;
  const source = `AVE_PROBE_VALUE=parent; AVE_PROBE_VALUE=child AVE_PROBE_RHS=$AVE_PROBE_VALUE ${child}; printf '%s\\0' $'\\u0041\\U00000042\\uac00\\U0001f600'`;
  const output = execFileSync(shell.cmd, shell.shellArgs(source), {
    cwd, env: { ...environment }, stdio: "pipe", timeout: SHELL_PROBE_TIMEOUT_MS, maxBuffer: 4096,
  }).toString("utf8").split("\0");
  if (output.length !== 3 || output[2] !== "" || !["parent", "child"].includes(output[0]!)) {
    throw new ShellMismatchError("The selected Bash did not satisfy the execution-state probe contract.");
  }
  const capabilities = Object.freeze({
    unicodeEscapes: output[1] === "AB가😀",
    prefixAssignmentRhs: output[0] === "child" ? "sequential" as const : "incoming" as const,
  });
  if (!entries) { entries = new Map(); bashCapabilities.set(shell, entries); }
  // Cache at most eight locale observations per resolved interpreter identity.
  if (entries.size >= 8) entries.delete(entries.keys().next().value!);
  entries.set(locale, capabilities);
  return capabilities;
}

export function resolveShell(dialect: ShellDialect = "posix"): ResolvedShellCommand {
  if (process.platform !== "win32" && dialect === "posix") {
    return { cmd: "sh", shellArgs: (script: string) => ["-c", script] };
  }

  const cachedShell = cachedShells.get(dialect);
  const cachedError = cachedErrors.get(dialect);
  if (cachedShell) return cachedShell;
  if (cachedError) throw cachedError;

  const candidates: ResolvedShellCommand[] = process.platform === "win32"
    ? windowsShellCandidates().filter((candidate) => dialect !== "bash" || /(?:^|[\\/])bash(?:\.exe)?$/.test(candidate.cmd))
    : ["/bin/bash", "/usr/bin/bash"].map((cmd) => ({ cmd, shellArgs: (script: string) => ["-c", script] }));
  const probeCommand = dialect === "bash"
    ? 'test -n "$BASH_VERSION" && values=(__ave_shell_ok__) && read -r value <<< "${values[0]}" && printf "%s" "$value"'
    : "printf __ave_shell_ok__";

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      if (process.platform === "win32") candidate.cmd = resolveWindowsShellCandidate(candidate.cmd, dialect);
      // Non-interactive shell tools must not load login profiles.
      if (dialect === "bash") candidate.shellArgs = (script: string) => ["-c", script];
      const probe = execFileSync(candidate.cmd, candidate.shellArgs(probeCommand), {
        windowsHide: true,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: SHELL_PROBE_TIMEOUT_MS,
        env: buildSafeChildEnv(),
      });
      if (probe !== "__ave_shell_ok__") {
        throw new Error(`unexpected shell probe output: ${JSON.stringify(probe)}`);
      }
      if (process.platform === "win32") candidate.windowsFlavor = detectWindowsShellFlavor(candidate);
      const selected = Object.freeze({ ...candidate });
      cachedShells.set(dialect, selected);
      return selected;
    } catch (err) {
      lastError = err;
    }
  }

  const error = new ShellMismatchError(
    dialect === "bash"
      ? `The bash tool requires Bash. Install Bash${process.platform === "win32" ? " (Git for Windows or WSL)" : " at /bin/bash or /usr/bin/bash"}.${lastError instanceof Error ? ` (${lastError.message})` : ""}`
      : `This feature requires a POSIX shell (sh or bash). On Windows, install Git for Windows or WSL to provide sh.exe or bash.exe in PATH.${lastError instanceof Error ? ` (${lastError.message})` : ""}`,
  );
  cachedErrors.set(dialect, error);
  throw error;
}

function windowsShellCandidates(): ResolvedShellCommand[] {
  return [
    // Prefer the installed native shell; subsystem launchers use a different path dialect and may stall under concurrency.
    { cmd: "C:\\Program Files\\Git\\usr\\bin\\sh.exe", shellArgs: (script: string) => ["-c", script] },
    { cmd: "C:\\Program Files\\Git\\bin\\bash.exe", shellArgs: (script: string) => ["-lc", script] },
    { cmd: "C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe", shellArgs: (script: string) => ["-c", script] },
    { cmd: "C:\\Program Files (x86)\\Git\\bin\\bash.exe", shellArgs: (script: string) => ["-lc", script] },
    { cmd: "sh", shellArgs: (script: string) => ["-c", script] },
    { cmd: "bash", shellArgs: (script: string) => ["-lc", script] },
  ];
}

function resolveWindowsShellCandidate(cmd: string, dialect: ShellDialect): string {
  if (/^[A-Za-z]:[\\/]/.test(cmd)) return cmd;
  const matches = execFileSync(win32SystemBinary("where.exe"), [cmd], { windowsHide: true, stdio: "pipe", encoding: "utf-8", env: buildSafeChildEnv() });
  if (dialect === "posix") return cmd;
  // Pin the first PATH result before probing so later execution cannot resolve another binary.
  const executable = matches.split(/\r?\n/)[0]?.trim();
  if (!executable || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(executable) || !/\.exe$/i.test(executable)) {
    throw new Error("Bash lookup did not return an absolute executable path");
  }
  return win32.normalize(executable);
}

function detectWindowsShellFlavor(shell: ResolvedShellCommand): WindowsShellFlavor {
  if (/^[A-Za-z]:[\\/]/.test(shell.cmd) && /[\\/]Git[\\/]/i.test(shell.cmd)) {
    return "msys";
  }
  try {
    const output = execFileSync(shell.cmd, shell.shellArgs("uname -s"), {
      windowsHide: true,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: SHELL_PROBE_TIMEOUT_MS,
      env: buildSafeChildEnv(),
    }).trim();
    if (/^(MINGW|MSYS|CYGWIN)/i.test(output)) return "msys";
    if (/linux/i.test(output)) return "wsl";
  } catch {
    // Probe failure must leave generic shell commands usable.
  }
  return "unknown";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellPathForHostPath(shell: ResolvedShellCommand, hostPath: string): string {
  if (process.platform !== "win32") return hostPath;
  const normalized = hostPath.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!driveMatch) return normalized;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2];
  if (shell.windowsFlavor === "wsl") return `/mnt/${drive}/${rest}`;
  if (shell.windowsFlavor === "msys") return `/${drive}/${rest}`;
  return normalized;
}

/** Return undefined for unmapped Windows shell paths so callers retain the prior directory. */
export function hostPathForShellPath(shell: ResolvedShellCommand, shellPath: string): string | undefined {
  if (process.platform !== "win32") return shellPath;
  const pattern = shell.windowsFlavor === "wsl"
    ? /^\/mnt\/([A-Za-z])(?:\/(.*))?$/
    : shell.windowsFlavor === "msys"
      ? /^\/([A-Za-z])(?:\/(.*))?$/
      : undefined;
  if (pattern === undefined) return win32.isAbsolute(shellPath) ? win32.normalize(shellPath) : undefined;
  const match = pattern.exec(shellPath);
  if (!match) return undefined;
  return win32.normalize(`${match[1].toUpperCase()}:\\${match[2] ?? ""}`);
}

export function shellCommandForHookPath(shell: ResolvedShellCommand, hookPath: string): string {
  const shellPath = shellPathForHostPath(shell, hookPath);
  if (process.platform === "win32" && isAbsolute(hookPath)) {
    return `${shellInterpreterCommand(shell)} ${shellQuote(shellPath)}`;
  }
  return shellQuote(shellPath);
}

export function shellEnvForChild(shell: ResolvedShellCommand, env: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32" || shell.windowsFlavor !== "msys") return env;
  const additions = msysPathEntriesForShell(shell);
  if (additions.length === 0) return env;

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey];
  return {
    ...env,
    [pathKey]: [additions.join(delimiter), currentPath].filter(Boolean).join(delimiter),
  };
}

function shellInterpreterCommand(shell: ResolvedShellCommand): string {
  if (process.platform !== "win32") return "sh";
  if (shell.windowsFlavor === "msys") return "/usr/bin/sh";
  if (shell.windowsFlavor === "wsl") return "/bin/sh";
  return "sh";
}

function msysPathEntriesForShell(shell: ResolvedShellCommand): string[] {
  if (!/^[A-Za-z]:[\\/]/.test(shell.cmd)) return [];
  const shellDir = dirname(shell.cmd);
  const lowerShellDir = shellDir.toLowerCase();
  if (lowerShellDir.endsWith("\\usr\\bin") || lowerShellDir.endsWith("/usr/bin")) {
    return [shellDir];
  }
  const gitRoot = dirname(shellDir);
  const usrBin = join(gitRoot, "usr", "bin");
  return [usrBin, shellDir];
}

export function __resetShellResolverCache(): void {
  cachedShells.clear();
  cachedErrors.clear();
}
