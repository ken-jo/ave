import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isHostGitWorkspaceAvailable } from "../shared/host-git.js";
import { resolveHostGit, supportsVerifiedHostGit } from "../shared/host-git-executable.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isPowerShellStartupPinned } from "../shared/powershell-startup-policy.js";
import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";
import { literalShellWord, parseShellFloorCommand } from "./rules/shell-exfiltration.js";
import { parsePowerShellCommand, type ParsedPowerShellCommand } from "./rules/powershell-exfiltration.js";
import type { ParsedShellCommand } from "./rules/shell-prefix-policy.js";
import { bindVerifiedArgvProof } from "./rules/verified-argv-authority.js";
import { gitReadOnlyEnvironment, isSupportedGitVersion, readOnlyGitArguments } from "./rules/git-readonly-argv.js";
import { inspectGitRepositoryAsync } from "./rules/git-repository-inspection-client.js";
import { proveVerifiedLauncherArgv } from "./rules/verified-launcher-argv.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "./rules/shell-prefix-values.js";
import { encodedPowerShellExecutionReason } from "./rules/powershell-encoded-command.js";
import type { VerifiedNativePlan } from "./rules/verified-native-plan.js";

export interface VerifiedShellIdentity { readonly command: string; readonly dialect: "bash" | "powershell"; readonly cwd: string }
declare const verifiedShellBrand: unique symbol;
export interface VerifiedShellCommand { readonly [verifiedShellBrand]: true }
interface VerifiedState { readonly identity: VerifiedShellIdentity; readonly parsed: ParsedShellCommand | ParsedPowerShellCommand; readonly plan: VerifiedNativePlan }
const issued = new WeakMap<VerifiedShellCommand, VerifiedState>();
const gitVersions = new Map<string, Promise<boolean>>();
const REPOSITORY_RESULT_REFUSAL = "Read-only Git output discarded: repository metadata changed during execution.";

/** Any launch, exit, timeout, output-limit or parse failure is an unsupported version. */
function probeGitVersion(executable: string, env: Record<string, string>): Promise<boolean> {
  return new Promise<boolean>((resolveVersion, reject) => {
    execFile(executable, ["--version"], {
      encoding: "utf8", cwd: dirname(executable), env,
      timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 4096,
    }, (error, stdout) => {
      try { resolveVersion(error === null && isSupportedGitVersion(stdout)); } catch (parseError) { reject(parseError); }
    });
  }).catch(() => false);
}

/** A cancelled preparation issues no plan; the caller observes the same signal. */
async function proveNative(argv: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<VerifiedNativePlan | undefined> {
  if (encodedPowerShellExecutionReason(argv) !== null) return undefined;
  const args = readOnlyGitArguments(argv);
  if (args !== null) {
    if (!supportsVerifiedHostGit() || !isHostGitWorkspaceAvailable(cwd)) return undefined;
    const repository = await inspectGitRepositoryAsync(cwd);
    if (signal?.aborted || repository === null) return undefined;
    const executable = await resolveHostGit("verified");
    if (signal?.aborted || executable === null) return undefined;
    // Even revision-only plumbing reads an index. Select a protected absent path
    // so shared-index readers cannot refresh a repository file timestamp.
    const indexFile = join(dirname(executable), ".ave-readonly-index");
    try { await lstat(indexFile); return undefined; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (signal?.aborted) return undefined;
    // A failed or unsupported probe is cached as a refusal for this executable.
    let supported = gitVersions.get(executable);
    if (supported === undefined) {
      supported = probeGitVersion(executable, gitReadOnlyEnvironment({ LANG: "C", LC_ALL: "C" }, repository, indexFile));
      gitVersions.set(executable, supported);
    }
    if (!(await supported) || signal?.aborted) return undefined;
    const prepareEnvironment = (base: Readonly<Record<string, string>>): Record<string, string> => gitReadOnlyEnvironment(base, repository, indexFile);
    return Object.freeze({
      executable,
      args: Object.freeze([`--git-dir=${repository.gitDirectory}`, `--work-tree=${repository.workTree}`, ...args]),
      environment: Object.freeze(prepareEnvironment({})), prepareEnvironment,
      available: () => isHostGitWorkspaceAvailable(repository.workTree),
      resultRefusal: async () => (await inspectGitRepositoryAsync(repository.workTree))?.stateFingerprint === repository.stateFingerprint
        ? undefined : REPOSITORY_RESULT_REFUSAL,
      proof: Object.freeze({ kind: "static-complete", changesState: false }),
    });
  }
  const launcher = await proveVerifiedLauncherArgv(argv);
  return signal?.aborted ? undefined : launcher ?? undefined;
}

function literalArgv(argv: readonly (string | undefined)[]): argv is readonly string[] {
  return argv.length !== 0 && argv.every((word): word is string => word !== undefined);
}

/** Host tools bind one literal simple command; other callers retain default refusal. */
export async function prepareVerifiedShellCommand(identity: VerifiedShellIdentity, executionPlan?: HostShellExecutionPlan, signal?: AbortSignal): Promise<VerifiedShellCommand | undefined> {
  if (identity.command.length > MAX_LITERAL_COMMAND_LENGTH
    || !/^[\t ]*(?:git|bash)(?:[\t ]|$)/.test(identity.command)) return undefined;
  if (identity.dialect === "powershell" && !isPowerShellStartupPinned(executionPlan?.platform, executionPlan)) return undefined;
  let plan: VerifiedNativePlan | undefined;
  let parsed: ParsedShellCommand | ParsedPowerShellCommand;
  if (identity.dialect === "bash") {
    parsed = parseShellFloorCommand(identity.command);
    if (!parsed.analysis.ok) return undefined;
    const root = parsed.analysis.program;
    const command = root.kind === "command" ? root : root.kind === "sequence" && root.statements.length === 1 ? root.statements[0] : undefined;
    if (command?.kind !== "command" || command.assignments.length !== 0 || command.redirects.length !== 0 || command.testForm !== undefined) return undefined;
    const argv = command.words.map(literalShellWord);
    if (!literalArgv(argv)) return undefined;
    plan = await proveNative(argv, identity.cwd, signal);
    if (plan === undefined) return undefined;
    bindVerifiedArgvProof(command, plan.proof);
  } else {
    // The parser asks for argv proof synchronously. A first parse only records the
    // literal argv it would prove; each is proven asynchronously, then the binding
    // parse answers from those results. Unrecorded argv receives no proof.
    const requested: string[][] = [];
    parsePowerShellCommand(identity.command, (argv) => {
      if (literalArgv(argv)) requested.push([...argv]);
      return undefined;
    });
    const plans = new Map<string, VerifiedNativePlan | undefined>();
    for (const argv of requested) {
      const key = JSON.stringify(argv);
      if (!plans.has(key)) plans.set(key, await proveNative(argv, identity.cwd, signal));
      if (signal?.aborted) return undefined;
    }
    parsed = parsePowerShellCommand(identity.command, (argv) => {
      if (!literalArgv(argv)) return undefined;
      plan = plans.get(JSON.stringify(argv));
      return plan?.proof;
    });
    if (parsed.analysisLimited || plan === undefined) return undefined;
  }
  const handle = Object.freeze({}) as VerifiedShellCommand;
  issued.set(handle, { identity: Object.freeze({ ...identity, cwd: resolve(identity.cwd) }), parsed, plan });
  return handle;
}

function stateFor(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): VerifiedState | undefined {
  const state = handle === undefined ? undefined : issued.get(handle);
  return state?.identity.command === identity.command && state.identity.dialect === identity.dialect
    && state.identity.cwd === resolve(identity.cwd) && (state.plan.available?.() ?? true) ? state : undefined;
}
export function verifiedShellParsed(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): ParsedShellCommand | ParsedPowerShellCommand | undefined {
  const state = stateFor(handle, identity);
  return state?.parsed;
}
export function verifiedShellExecution(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): Readonly<{ command: string; executable: string }> | undefined {
  const state = stateFor(handle, identity);
  if (state === undefined) return undefined;
  const quote = identity.dialect === "bash" ? (word: string): string => `'${word.replaceAll("'", "'\\''")}'`
    : (word: string): string => `'${word.replaceAll("'", "''")}'`;
  return Object.freeze({ executable: state.plan.executable,
    command: (identity.dialect === "powershell" ? "& " : "") + [state.plan.executable, ...state.plan.args].map(quote).join(" ") });
}
export function verifiedShellEnvironment(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity, base: Readonly<Record<string, string>>): Record<string, string> {
  const state = stateFor(handle, identity);
  if (state === undefined) {
    if (handle !== undefined) throw new Error("Verified shell command is no longer available for this invocation");
    return { ...base };
  }
  const filtered = state.plan.prepareEnvironment?.(base)
    ?? Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:LD_|DYLD_)/i.test(key)));
  // Config authority comes only from the owned plan, including after wrapping.
  for (const key of Object.keys(state.plan.environment)) {
    for (const inherited of Object.keys(filtered)) if (inherited.toLowerCase() === key.toLowerCase()) delete filtered[inherited];
  }
  return { ...filtered, ...state.plan.environment };
}

/** Output remains private until the issued plan validates its post-run evidence. */
export function verifiedShellRequiresResultCheck(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): boolean {
  if (handle === undefined) return false;
  try {
    const state = stateFor(handle, identity);
    return state === undefined || state.plan.resultRefusal !== undefined;
  } catch { return true; }
}

/** Re-inspects the repository without blocking; any failure, including a rejected inspection, refuses the output. */
export async function verifiedShellResultRefusal(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): Promise<string | undefined> {
  if (handle === undefined) return undefined;
  try {
    const state = stateFor(handle, identity);
    return state === undefined ? REPOSITORY_RESULT_REFUSAL : await state.plan.resultRefusal?.();
  } catch { return REPOSITORY_RESULT_REFUSAL; }
}
