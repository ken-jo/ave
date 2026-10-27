import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { getPolicyHome } from "../shared/policy-home.js";
import { getBashCapabilities, resolveShell, shellEnvForChild, shellPathForHostPath, shellQuote, type ResolvedShellCommand } from "../lib/shell-resolver.js";
import { createSandboxProcessHome, type SandboxProcessHome } from "../permissions/sandbox-process-home.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { verifiedShellEnvironment, verifiedShellExecution, type VerifiedShellCommand } from "../permissions/verified-shell-command.js";
import type { ShellExecutionFacts } from "../shared/shell-execution.js";
import { buildHostShellChildEnv, buildSafeChildEnv, captureSandboxEnvironmentBaseline, FORWARD_ENV_KEYS, overlaySandboxChildEnv } from "./safe-env.js";
import { collectShellExecutableReadPaths } from "./shell-executable-read-paths.js";
import { createShellCwdProbe, type ShellCwdProbe } from "./shell-cwd-probe.js";

export interface ShellInvocationIdentity {
  readonly command: string;
  readonly requestedCwd?: string;
  readonly executionCwd: string;
  readonly resolvedCwd: string;
  readonly toolUseId?: string;
  readonly plan: HostShellExecutionPlan;
  readonly verifiedShellCommand?: VerifiedShellCommand;
}

declare const preparedShellBrand: unique symbol;
/** An in-process host handle; input JSON and model-supplied analysis cannot issue it. */
export interface PreparedShellInvocation { readonly [preparedShellBrand]: true }
interface PreparedState {
  readonly identity: Readonly<ShellInvocationIdentity>;
  readonly shell: Readonly<ResolvedShellCommand>;
  readonly argv: readonly string[];
  readonly executionCommand: string;
  readonly verifiedExecutable?: string;
  /** Foreground argv: the same command behind the host's fixed cwd probe. */
  readonly probedArgv: readonly string[];
  readonly cwdProbe?: ShellCwdProbe;
  readonly environment: Readonly<Record<string, string>>;
  readonly wrapperBaseline: Readonly<NodeJS.ProcessEnv>;
  readonly facts: Readonly<ShellExecutionFacts>;
  readonly home?: SandboxProcessHome;
  readonly hostHome?: string;
  executableReadPaths?: readonly string[];
  phase: "prepared" | "claimed" | "spawned" | "disposed";
}
const issued = new WeakMap<PreparedShellInvocation, PreparedState>();

export function prepareShellInvocation(identity: ShellInvocationIdentity, signal?: AbortSignal): PreparedShellInvocation {
  signal?.throwIfAborted();
  const verifiedIdentity = { command: identity.command, dialect: "bash" as const, cwd: identity.resolvedCwd };
  const verified = verifiedShellExecution(identity.verifiedShellCommand, verifiedIdentity);
  if (identity.verifiedShellCommand !== undefined && verified === undefined) throw new Error("Verified shell command does not match this invocation");
  const executionCommand = verified?.command ?? identity.command;
  const selected = resolveShell("bash");
  const shell = Object.freeze({ ...selected });
  const wrapperBaseline = captureSandboxEnvironmentBaseline();
  const safe = shellEnvForChild(shell, identity.plan.mode === "plain" ? buildHostShellChildEnv() : buildSafeChildEnv());
  const hostHome = getPolicyHome(safe);
  let home: SandboxProcessHome | undefined;
  try {
    if (identity.plan.mode === "asrt") {
      home = createSandboxProcessHome();
      // The profile may already own a temp root. Atomically create our own directory rather than trusting any existing entry at a fixed name.
      const temporary = mkdtempSync(join(home.path, "shell-tmp-"));
      Object.assign(safe, home.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
    }
    // Bash initializes PWD from its actual cwd. Pin the same initial value for analysis and the final inner shell, independently of the parent's alias.
    safe.PWD = shellPathForHostPath(shell, identity.resolvedCwd);
    const environment = Object.freeze(identity.verifiedShellCommand === undefined ? safe
      : verifiedShellEnvironment(identity.verifiedShellCommand, verifiedIdentity, safe));
    const capabilities = getBashCapabilities(selected, environment, identity.resolvedCwd);
    const argv = Object.freeze([...shell.shellArgs(executionCommand)]);
    const cwdProbe = createShellCwdProbe(executionCommand);
    const probedArgv = cwdProbe === undefined ? argv : Object.freeze([...shell.shellArgs(cwdProbe.script)]);
    signal?.throwIfAborted();
    const handle = Object.freeze({}) as PreparedShellInvocation;
    issued.set(handle, {
      identity: Object.freeze({ ...identity }), shell, argv, executionCommand, verifiedExecutable: verified?.executable, probedArgv, cwdProbe, environment, wrapperBaseline,
      facts: Object.freeze({ dialect: "bash", environment, ...capabilities }),
      home, hostHome, phase: "prepared",
    });
    return handle;
  } catch (error) {
    home?.cleanup();
    throw error;
  }
}

function stateOf(handle: PreparedShellInvocation): PreparedState {
  const state = issued.get(handle);
  if (!state || state.phase === "disposed") throw new Error("Shell preparation was not issued or is no longer live");
  return state;
}

export function matchesPreparedShellInvocation(handle: PreparedShellInvocation, identity: ShellInvocationIdentity): boolean {
  const state = issued.get(handle);
  if (!state || state.phase !== "prepared") return false;
  const original = state.identity;
  return original.plan === identity.plan && original.command === identity.command
    && original.requestedCwd === identity.requestedCwd && original.executionCwd === identity.executionCwd
    && original.resolvedCwd === identity.resolvedCwd && original.toolUseId === identity.toolUseId
    && original.verifiedShellCommand === identity.verifiedShellCommand;
}

/** The provider tool-use id the invocation was prepared for, when it had one. */
export function preparedShellToolUseId(handle: PreparedShellInvocation): string | undefined { return stateOf(handle).identity.toolUseId; }
export function preparedShellFacts(handle: PreparedShellInvocation): Readonly<ShellExecutionFacts> { return stateOf(handle).facts; }

/** Bind only after command policy accepts the final source, before approval. */
export function bindPreparedShellExecutableReadPaths(handle: PreparedShellInvocation): void {
  const state = stateOf(handle);
  if (state.phase !== "prepared") throw new Error("Shell executable reads must be bound before claim");
  state.executableReadPaths ??= Object.freeze([...new Set([
    ...collectShellExecutableReadPaths(state.executionCommand, state.identity.resolvedCwd, state.facts),
    ...(state.verifiedExecutable === undefined ? [] : [state.verifiedExecutable]),
  ])]);
}

export function preparedShellExecutableReadPaths(handle: PreparedShellInvocation): readonly string[] {
  const paths = stateOf(handle).executableReadPaths;
  if (!paths) throw new Error("Shell executable reads were not bound before execution");
  return paths;
}
export function preparedShellCommand(handle: PreparedShellInvocation): Readonly<{
  shell: Readonly<ResolvedShellCommand>; argv: readonly string[]; environment: Readonly<Record<string, string>>; homePath?: string; hostHome?: string;
}> {
  const state = stateOf(handle);
  return Object.freeze({ shell: state.shell, argv: state.argv, environment: state.environment, homePath: state.home?.path, hostHome: state.hostHome });
}

/** Foreground argv carrying the host's cwd probe, with the delimiters the caller strips from stderr; the plain
 * argv and no probe when the command cannot change directory. Background shells use {@link preparedShellCommand}. */
export function preparedShellCwdProbe(handle: PreparedShellInvocation, prelude?: string): Readonly<{
  argv: readonly string[]; probe?: ShellCwdProbe;
}> {
  const state = stateOf(handle);
  const argv = prelude === undefined ? state.probedArgv
    : Object.freeze(state.shell.shellArgs(prelude + (state.cwdProbe?.script ?? state.executionCommand)));
  return Object.freeze({ argv, probe: state.cwdProbe });
}

/** The wrapper runs only this launcher; the command is one exact inner -c argument, behind the fixed cwd probe when `cwdProbe` is set. */
export function preparedSandboxBootstrap(handle: PreparedShellInvocation, options: { cwdProbe?: boolean } = {}): string {
  const state = stateOf(handle);
  if (!state.home) throw new Error("Sandbox shell preparation has no owned HOME");
  const unset = FORWARD_ENV_KEYS.filter((key) => state.environment[key] === undefined);
  const exported = Object.entries(state.environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [
    ...(unset.length ? [`unset ${unset.join(" ")}`] : []),
    `export ${exported.join(" ")}`,
    `exec ${[shellPathForHostPath(state.shell, state.shell.cmd), ...(options.cwdProbe === true ? state.probedArgv : state.argv)].map(shellQuote).join(" ")}`,
  ].join("; ");
}

export function preparedSandboxEnvironment(handle: PreparedShellInvocation, wrappedEnv: NodeJS.ProcessEnv): Record<string, string> {
  const state = stateOf(handle);
  const environment = overlaySandboxChildEnv(wrappedEnv, state.environment, state.wrapperBaseline);
  return state.identity.verifiedShellCommand === undefined ? environment
    : verifiedShellEnvironment(state.identity.verifiedShellCommand, { command: state.identity.command, dialect: "bash", cwd: state.identity.resolvedCwd }, environment);
}

/** Release only preparation-owned resources; a spawned child has a separate owner. */
export function disposePreparedShellInvocation(handle: PreparedShellInvocation | undefined): void {
  if (!handle) return;
  const state = issued.get(handle);
  if (!state || state.phase !== "prepared") return;
  state.phase = "disposed";
  state.home?.cleanup();
}

/** Claim once, synchronously before wrapper/native effects. The helper retaining this cleanup owns pending preparation even if its caller settles or cancels. */
export function claimPreparedShellInvocation(handle: PreparedShellInvocation): () => void {
  const state = stateOf(handle);
  if (state.phase !== "prepared") throw new Error("Shell preparation has already been claimed");
  if (state.identity.verifiedShellCommand !== undefined && verifiedShellExecution(state.identity.verifiedShellCommand, {
    command: state.identity.command, dialect: "bash", cwd: state.identity.resolvedCwd,
  }) === undefined) throw new Error("Verified shell command is no longer available for this invocation");
  state.phase = "claimed";
  return () => {
    if (state.phase !== "claimed") return;
    state.phase = "disposed";
    state.home?.cleanup();
  };
}

/** Call immediately after successful spawn; invoke the returned cleanup only after termination. */
export function transferPreparedShellInvocation(handle: PreparedShellInvocation): () => void {
  const state = stateOf(handle);
  if (state.phase !== "claimed") throw new Error("Shell preparation was not claimed by this execution");
  state.phase = "spawned";
  return () => {
    if (state.phase !== "spawned") return;
    state.phase = "disposed";
    state.home?.cleanup();
  };
}
