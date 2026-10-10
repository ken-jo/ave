/**
 * Spawn a child process confined by ASRT.
 *
 * Extracted from `worker-spawn.ts`, where the identical sequence — wrap the
 * argv, mark the process as genuinely wrapped, check managed-child admission,
 * spawn with the composed environment, register the child — was written twice,
 * once for Windows and once for POSIX. Only two things actually differed
 * between them, and both are parameters here.
 *
 * A separate module rather than another export from `worker-spawn.ts`: that
 * file is dominated by the Python worker's Unix-socket control channel, which
 * has nothing to do with confinement. A JS plugin child will need this and
 * must not import a module whose subject is the Python worker's socket.
 *
 * THE DENY FLOOR IS OWNED HERE, and that is the point of the extraction.
 * In ASRT a per-command `denyRead`/`denyWrite` REPLACES the shared boot floor
 * rather than adding to it — an empty-but-present array is not nullish — so a
 * caller that omits it silently hands the child back read of `~/.ave/secrets`,
 * `~/.ssh`, `~/.aws`. Six call sites restate that floor today and each one is
 * correct, but nothing tells the seventh. Callers of this primitive pass allow
 * paths only; the floor is not theirs to forget.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

import {
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  isAsrtSandboxActive,
  sandboxTempEnvLaunch,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
  type WrapOptions,
} from "./asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { shellQuote } from "../lib/shell-resolver.js";

/**
 * How the child's filesystem access is granted.
 *
 * `allow-list` puts the paths in the ASRT command itself (macOS seatbelt,
 * Linux bwrap `--bind`). `deny-only` is Windows, where reachability is an ACL
 * question decided outside the wrap — a grant against a holder process the
 * caller owns for the process's lifetime (`windows-acl-grant-holder.ts`; a
 * worker in `worker-spawn.ts`, a plugin child in `spawnConfinedPluginChild`) —
 * so the wrap carries
 * the deny floor and nothing else: passing allow paths there would imply a
 * confinement the wrap does not perform.
 */
type ConfinementGrantMode = "allow-list" | "deny-only";

export interface ConfinedChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Used for the managed-child registration and in errors. */
  readonly label: string;
  readonly grantMode: ConfinementGrantMode;
  /** Ignored under `deny-only`, where ACLs grant reachability instead. */
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  /**
   * Whose temp directory the child gets: the plugin it belongs to. Required
   * under `allow-list`, where the wrap grants that directory alone and sets
   * the child's `TMPDIR` to it; ignored under `deny-only`, where the sandbox
   * HOME's own `TEMP`/`TMP` is already per process
   * (`sandbox-process-home.ts`).
   */
  readonly tempPrincipal?: SandboxTempPrincipal;
  /**
   * The child may write INSIDE each write root but not unlink, rename or
   * replace the root itself, its temp directory included. For a child whose
   * write roots are directories the host created and keeps resolving — a
   * plugin's data root above all — so that the child cannot `rmdir` one and
   * leave a link in its place. Carried to the wrap as
   * `PerCommandFilesystem.pinWriteRoots` (`asrt-sandbox.ts`), the one place
   * every wrap of plugin-owned code pins its roots.
   */
  readonly pinWriteRoots?: boolean;
  /**
   * The reads, among `allowRead`, this child may hold inside the protected
   * read floor: a plugin's declared `hostDirectory` that pierces it. Carried
   * to the wrap as `PerCommandFilesystem.floorPierces`; absent, none.
   */
  readonly floorPierces?: readonly string[];
  /**
   * Refuse the child the plugins root beyond the protected floor, its own
   * directories re-allowed through `allowRead`. Carried to the wrap as
   * `PerCommandFilesystem.denyPluginsRoot` (`asrt-sandbox.ts`), which says why
   * and why Windows refuses it: set only under `allow-list`.
   */
  readonly denyPluginsRoot?: boolean;
  /** Secret-stripped base environment the child starts from. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Overlaid last — the sandbox process HOME, which must win. */
  readonly extraEnv?: Record<string, string>;
  /**
   * Checked before and after the wrap. Throw to abort.
   *
   * Windows uses this for holder-process liveness: the ACL grant is only real
   * while the holder is alive, so a holder that died between the grant and the
   * spawn would otherwise produce a child believed to be confined by a grant
   * that no longer exists.
   */
  readonly assertStillValid?: () => void;
  /**
   * Called the instant the wrap succeeds, BEFORE the spawn.
   *
   * The wrap increments ASRT per-command state (the Linux active-sandbox count
   * and proxy refcount). From that moment a later failure must decrement it,
   * and only the caller knows how its own cleanup is arranged — so this is
   * where the caller records that the wrap happened.
   */
  readonly onWrapped?: () => void;
  /**
   * The child's standard streams.
   *
   * Defaults to `["ignore", "pipe", "pipe"]`, so a caller with no use for
   * stdin does not hand an idle descriptor into a confined process. Both
   * callers pipe stdin today, for different reasons: the JS plugin child is a
   * JSON-RPC server whose pipes the host owns, and the plugin worker's stdin is
   * the host's liveness pipe (see `worker-spawn.ts`) — it carries no bytes and
   * closes only when the host process is gone.
   */
  readonly stdio?: StdioOptions;
  /**
   * How the wrapped command line is rendered on Windows; ignored elsewhere and
   * on the unwrapped path. `"powershell"` (the default, every caller but one)
   * runs it as `powershell -Command "& '<command>' …"`. `"cmd"` runs it under
   * `cmd.exe /d /v:off /s /c`, for a GUI-subsystem binary such as
   * `electron.exe`, which PowerShell starts without waiting for and without
   * its standard streams (measured: no output, exit 0 at once). The tokens are
   * checked rather than escaped — see {@link buildCmdCommandLine}.
   */
  readonly windowsShell?: "powershell" | "cmd";
  /**
   * Environment set ON the `"cmd"` command line, ahead of the command. srt-win
   * gives the target the sandbox account's profile environment plus its own
   * proxy overlay, never `baseEnv`/`extraEnv`, so a variable that must exist
   * before the binary starts — `ELECTRON_RUN_AS_NODE` — can only arrive this
   * way. Values are held to the same check as the tokens. Requires
   * `windowsShell: "cmd"`.
   */
  readonly windowsCommandLineEnv?: Readonly<Record<string, string>>;
}

/**
 * The wrap a spawn actually applied — never the `features.osToolSandbox`
 * setting. A child spawned unwrapped is `unconfined` whatever the setting
 * says, because "confined" is a claim about this process, and only the wrap
 * makes it true. One value per substrate ASRT wraps with.
 */
export type SpawnConfinement = "macos-sandbox" | "linux-bubblewrap" | "windows-srt" | "unconfined";

/** A spawned, registered child and the wrap it runs under. */
export interface ConfinedChildSpawn {
  readonly child: ChildProcess;
  readonly confinement: SpawnConfinement;
}

/**
 * Spawn and register a child, wrapped when the host is sandboxed.
 *
 * A child is confined exactly as much as the host is — no more, no less. With
 * the OS sandbox active the command is wrapped by ASRT and the caller's
 * {@link ConfinedChildSpec.onWrapped} fires; with it inactive the command is
 * spawned as given, `onWrapped` does not fire, and no confinement marker is
 * left anywhere, so every reader of "is this child confined" answers no. The
 * host's own tools take the same two paths on the same setting; a child that
 * demanded a wrap the host itself does not run under would be asserting a
 * promise the host never made.
 *
 * Throws with the ASRT per-command state already incremented if the failure
 * happens after `onWrapped` fires; the caller's cleanup owns the decrement.
 */
export async function spawnConfinedChild(spec: ConfinedChildSpec): Promise<ConfinedChildSpawn> {
  spec.assertStillValid?.();

  const { executable, args, wrappedEnv, confinement } = await resolveSpawnLine(spec);
  spec.assertStillValid?.();

  assertManagedChildProcessAdmissionOpen(spec.label);
  const child = spawn(executable, args, {
    stdio: spec.stdio ?? ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: composeConfinedEnv(spec.baseEnv, wrappedEnv, spec.extraEnv ?? {}),
  });
  trackManagedChildProcess(child, { label: spec.label });
  return { child, confinement };
}

/**
 * The substrate ASRT wraps with on this platform. Asked only on the wrapped
 * path; a platform ASRT does not wrap on is an internal contract violation,
 * because `isAsrtSandboxActive()` reported a live sandbox there.
 */
function wrapConfinement(label: string): Exclude<SpawnConfinement, "unconfined"> {
  switch (process.platform) {
    case "darwin":
      return "macos-sandbox";
    case "linux":
      return "linux-bubblewrap";
    case "win32":
      return "windows-srt";
    default:
      throw new Error(`[confined-child] ${label}: the sandbox is active on '${process.platform}', which no wrap substrate serves`);
  }
}

/**
 * What actually gets spawned: the ASRT-wrapped argv while the sandbox is
 * active, the caller's own command otherwise. The two are one function so the
 * decision is made in one place and `onWrapped` cannot fire on the plain path.
 */
async function resolveSpawnLine(
  spec: ConfinedChildSpec,
): Promise<{ executable: string; args: string[]; wrappedEnv: NodeJS.ProcessEnv; confinement: SpawnConfinement }> {
  if (!isAsrtSandboxActive()) {
    return { executable: spec.command, args: [...spec.args], wrappedEnv: {}, confinement: "unconfined" };
  }
  const confinement = wrapConfinement(spec.label);
  const temp = spec.grantMode === "allow-list" ? ensureSandboxTempPrincipalDir(requireTempPrincipal(spec)) : undefined;
  const launch = temp ? sandboxTempEnvLaunch(temp.dir, spec.command, spec.args) : spec;
  const { cmdline, binShell } = buildConfinedCommandLine(launch.command, launch.args, spec);
  const { argv, env } = await wrapWorkerCommand(cmdline, {
    filesystem: buildFilesystemConfinement(spec, temp),
    ...(binShell !== undefined ? { binShell } : {}),
  });
  spec.onWrapped?.();
  const [executable, ...args] = argv;
  if (executable === undefined) {
    throw new Error(`[confined-child] ASRT returned an empty argv for ${spec.label}`);
  }
  return { executable, args, wrappedEnv: env, confinement };
}

function requireTempPrincipal(spec: ConfinedChildSpec): SandboxTempPrincipal {
  if (spec.tempPrincipal === undefined) {
    throw new Error(`[confined-child] ${spec.label}: an allow-list confinement needs the temp principal it belongs to`);
  }
  return spec.tempPrincipal;
}

/**
 * The filesystem section of the ASRT command.
 *
 * The deny floor is restated unconditionally in BOTH modes, because a
 * per-command array replaces the shared one rather than extending it.
 */
function buildFilesystemConfinement(spec: ConfinedChildSpec, temp: { dir: string } | undefined): {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead: string[];
  denyWrite: string[];
  pinWriteRoots?: boolean;
  floorPierces?: readonly string[];
  denyPluginsRoot?: boolean;
} {
  const floor = {
    denyRead: getDefaultSensitiveReadDenyPaths(),
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
  };
  if (spec.grantMode === "deny-only") {
    if (spec.denyPluginsRoot === true) {
      throw new Error(`[confined-child] ${spec.label}: denyPluginsRoot needs an allow-list confinement to re-allow the child's own directories`);
    }
    return floor;
  }
  if (temp === undefined) throw new Error(`[confined-child] ${spec.label}: an allow-list confinement was built without its temp directory`);
  // The temp directory is granted here for the same reason the deny floor is
  // restated here: no caller should have to remember it, and one that forgot
  // would produce a child whose `os.tmpdir()` names a directory it cannot
  // write — a failure with no obvious cause, arriving inside whatever library
  // wanted a temp file. It is the principal's OWN directory, read and write;
  // the shared root above it is read-denied by the floor, with the sandbox
  // HOME root beside it, and ASRT's reads are deny-only, so that deny is what
  // keeps one plugin from reading another's temp files or HOME.
  return {
    allowRead: [temp.dir, ...(spec.allowRead ?? [])],
    allowWrite: [temp.dir, ...(spec.allowWrite ?? [])],
    denyRead: floor.denyRead,
    denyWrite: floor.denyWrite,
    ...(spec.pinWriteRoots === true ? { pinWriteRoots: true } : {}),
    ...(spec.floorPierces !== undefined ? { floorPierces: spec.floorPierces } : {}),
    ...(spec.denyPluginsRoot === true ? { denyPluginsRoot: true } : {}),
  };
}

/**
 * Assemble the command line ASRT will run.
 *
 * Every token is quoted so a path containing spaces or shell metacharacters
 * cannot mis-split: ASRT runs this through a shell on both platforms.
 */
function buildConfinedCommandLine(
  command: string,
  args: readonly string[],
  spec: Pick<ConfinedChildSpec, "label" | "windowsShell" | "windowsCommandLineEnv">,
): { readonly cmdline: string; readonly binShell?: WrapOptions["binShell"] } {
  if (spec.windowsCommandLineEnv !== undefined && spec.windowsShell !== "cmd") {
    throw new Error(`[confined-child] ${spec.label}: windowsCommandLineEnv needs windowsShell "cmd"`);
  }
  if (process.platform === "win32") {
    if (spec.windowsShell === "cmd") {
      return {
        cmdline: buildCmdCommandLine(spec.label, command, args, spec.windowsCommandLineEnv ?? {}),
        binShell: cmdBinShell(spec.label),
      };
    }
    return {
      cmdline: ["&", powershellQuote(command), ...args.map((part) => powershellQuote(part))].join(" "),
      binShell: "powershell",
    };
  }
  return { cmdline: [command, ...args].map((part) => shellQuote(part)).join(" ") };
}

/**
 * `cmd.exe` limits its command line to 8191 characters; this leaves room for
 * nothing else to be added to it.
 */
const CMD_LINE_LIMIT = 8_000;
const CMD_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `"cmd"` rendering: `set "NAME=VALUE"&& "<command>" "<arg>" …`, run as
 * `cmd.exe /d /v:off /s /c <line>`.
 *
 * Every token is double-quoted, which makes `& | < > ^ ( )` literal, and
 * `/v:off` makes `!` literal whatever the registry says. What quoting cannot
 * neutralise is REFUSED rather than escaped: a `"` (it would end the quoting;
 * no Windows path contains one), a `%` (cmd expands `%NAME%` inside quotes
 * too), and CR, LF or NUL (a second command, or a truncated one). A trailing
 * run of backslashes is doubled so the target's MSVCRT argument parser does
 * not read the closing quote as escaped. Refusing fails the load with the
 * offending token named; a plugin path with `%` in it is the case that will
 * meet it, and the message says so.
 */
export function buildCmdCommandLine(
  label: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!CMD_ENV_NAME_RE.test(name)) {
      throw new Error(`[confined-child] ${label}: '${name}' is not an environment variable name`);
    }
    assertCmdSafe(label, `${name}=${value}`);
    parts.push(`set "${name}=${value}"&&`);
  }
  for (const token of [command, ...args]) {
    assertCmdSafe(label, token);
    parts.push(`"${token.replace(/(\\+)$/, "$1$1")}"`);
  }
  const line = parts.join(" ");
  if (line.length > CMD_LINE_LIMIT) {
    throw new Error(
      `[confined-child] ${label}: the cmd.exe command line is ${line.length} characters, over the ${CMD_LINE_LIMIT} it can carry`,
    );
  }
  return line;
}

function assertCmdSafe(label: string, token: string): void {
  const bad = /["%\r\n\0]/.exec(token);
  if (bad !== null) {
    const what = bad[0] === '"' ? "a double quote" : bad[0] === "%" ? "'%'" : "a control character";
    throw new Error(
      `[confined-child] ${label}: '${token.slice(0, 200)}' contains ${what}, which cmd.exe cannot be given safely; `
        + "move the plugin, or the app, to a path without it",
    );
  }
}

/** `cmd.exe` from the system root, never from `PATH`, with AutoRun and delayed expansion off. */
function cmdBinShell(label: string): { exe: string; args: string[] } {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (root === undefined || root.trim().length === 0) {
    throw new Error(`[confined-child] ${label}: cannot locate cmd.exe: SystemRoot is unset`);
  }
  return { exe: `${root.replace(/[\\/]+$/, "")}\\System32\\cmd.exe`, args: ["/d", "/v:off", "/s", "/c"] };
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Compose the child's environment.
 *
 * Only the variables ASRT actually CHANGED are overlaid. Taking its whole
 * composed environment would drag in this process's own values under the guise
 * of proxy configuration, so it is diffed against a baseline composed from
 * `process.env` and only the differences carry over.
 */
function composeConfinedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const asrtComposed: Record<string, string> = buildSandboxedChildEnv(wrappedEnv);
  const safeBaseline: Record<string, string> = buildSandboxedChildEnv(process.env);
  const proxyOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(asrtComposed)) {
    if (value === undefined) continue;
    if (safeBaseline[key] === value) continue;
    proxyOverlay[key] = value;
  }
  return { ...baseEnv, ...proxyOverlay, ...extraEnv };
}
