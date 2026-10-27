import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isHostGitWorkspaceAvailable } from "../shared/host-git.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { resolveVerifiedExecutable, type VerifiedExecutableCandidate } from "../shared/verified-executable.js";
import { isPowerShellStartupPinned } from "../shared/powershell-startup-policy.js";
import { literalShellWord, parseShellFloorCommand } from "./rules/shell-exfiltration.js";
import { parsePowerShellCommand, type ParsedPowerShellCommand } from "./rules/powershell-exfiltration.js";
import type { ParsedShellCommand } from "./rules/shell-prefix-policy.js";
import { bindVerifiedArgvProof } from "./rules/verified-argv-authority.js";
import { gitReadOnlyEnvironment, isSupportedGitVersion, readOnlyGitArguments } from "./rules/git-readonly-argv.js";
import { inspectGitRepository } from "./rules/git-repository-inputs.js";
import { proveVerifiedLauncherArgv } from "./rules/verified-launcher-argv.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "./rules/shell-prefix-values.js";
import { encodedPowerShellExecutionReason } from "./rules/powershell-encoded-command.js";
import type { VerifiedNativePlan } from "./rules/verified-native-plan.js";

export interface VerifiedShellIdentity { readonly command: string; readonly dialect: "bash" | "powershell"; readonly cwd: string }
declare const verifiedShellBrand: unique symbol;
export interface VerifiedShellCommand { readonly [verifiedShellBrand]: true }
interface VerifiedState { readonly identity: VerifiedShellIdentity; readonly parsed: ParsedShellCommand | ParsedPowerShellCommand; readonly plan: VerifiedNativePlan }
const issued = new WeakMap<VerifiedShellCommand, VerifiedState>();
const gitVersions = new Map<string, boolean>();
const REPOSITORY_RESULT_REFUSAL = "Read-only Git output discarded: repository metadata changed during execution.";
const GIT_INSTALLATIONS: Readonly<Partial<Record<NodeJS.Platform, readonly VerifiedExecutableCandidate[]>>> = Object.freeze({
  darwin: Object.freeze([
    { executable: "/Library/Developer/CommandLineTools/usr/bin/git", installationRoots: ["/Library/Developer/CommandLineTools"] },
    { executable: "/opt/git/bin/git", installationRoots: ["/opt/git"] },
  ]),
  linux: Object.freeze([
    { executable: "/usr/bin/git", installationRoots: ["/usr/bin/git"] },
    { executable: "/opt/git/bin/git", installationRoots: ["/opt/git"] },
  ]),
});

function proveNative(argv: readonly string[], cwd: string): VerifiedNativePlan | undefined {
  if (encodedPowerShellExecutionReason(argv) !== null) return undefined;
  const args = readOnlyGitArguments(argv);
  if (args !== null) {
    const candidates = GIT_INSTALLATIONS[process.platform];
    if (candidates === undefined || !isHostGitWorkspaceAvailable(cwd)) return undefined;
    const repository = inspectGitRepository(cwd);
    if (repository === null) return undefined;
    const installation = resolveVerifiedExecutable(candidates);
    if (installation === null) return undefined;
    // Even revision-only plumbing reads an index. Select a protected absent path
    // so shared-index readers cannot refresh a repository file timestamp.
    const indexFile = join(dirname(installation.executable), ".ave-readonly-index");
    try { lstatSync(indexFile); return undefined; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    let supported = gitVersions.get(installation.executable);
    if (supported === undefined) {
      try {
        const version = execFileSync(installation.executable, ["--version"], {
          encoding: "utf8", cwd: dirname(installation.executable),
          env: gitReadOnlyEnvironment({ LANG: "C", LC_ALL: "C" }, repository, indexFile),
          timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 4096,
        });
        supported = isSupportedGitVersion(version);
      } catch { supported = false; }
      gitVersions.set(installation.executable, supported);
    }
    if (!supported) return undefined;
    const prepareEnvironment = (base: Readonly<Record<string, string>>): Record<string, string> => gitReadOnlyEnvironment(base, repository, indexFile);
    return Object.freeze({
      executable: installation.executable,
      args: Object.freeze([`--git-dir=${repository.gitDirectory}`, `--work-tree=${repository.workTree}`, ...args]),
      environment: Object.freeze(prepareEnvironment({})), prepareEnvironment,
      available: () => isHostGitWorkspaceAvailable(repository.workTree),
      resultRefusal: () => inspectGitRepository(repository.workTree)?.stateFingerprint === repository.stateFingerprint
        ? undefined : REPOSITORY_RESULT_REFUSAL,
      proof: Object.freeze({ kind: "static-complete", changesState: false }),
    });
  }
  return proveVerifiedLauncherArgv(argv) ?? undefined;
}

/** Host tools bind one literal simple command; other callers retain default refusal. */
export function prepareVerifiedShellCommand(identity: VerifiedShellIdentity): VerifiedShellCommand | undefined {
  if (identity.command.length > MAX_LITERAL_COMMAND_LENGTH
    || !/^[\t ]*(?:git|bash)(?:[\t ]|$)/.test(identity.command)) return undefined;
  if (identity.dialect === "powershell" && !isPowerShellStartupPinned()) return undefined;
  let plan: VerifiedNativePlan | undefined;
  let parsed: ParsedShellCommand | ParsedPowerShellCommand;
  if (identity.dialect === "bash") {
    parsed = parseShellFloorCommand(identity.command);
    if (!parsed.analysis.ok) return undefined;
    const root = parsed.analysis.program;
    const command = root.kind === "command" ? root : root.kind === "sequence" && root.statements.length === 1 ? root.statements[0] : undefined;
    if (command?.kind !== "command" || command.assignments.length !== 0 || command.redirects.length !== 0 || command.testForm !== undefined) return undefined;
    const argv = command.words.map(literalShellWord);
    if (argv.length === 0 || !argv.every((word): word is string => word !== undefined)) return undefined;
    plan = proveNative(argv, identity.cwd);
    if (plan === undefined) return undefined;
    bindVerifiedArgvProof(command, plan.proof);
  } else {
    parsed = parsePowerShellCommand(identity.command, (argv) => {
      if (argv.length === 0 || !argv.every((word): word is string => word !== undefined)) return undefined;
      plan = proveNative(argv, identity.cwd);
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

export function verifiedShellResultRefusal(handle: VerifiedShellCommand | undefined, identity: VerifiedShellIdentity): string | undefined {
  if (handle === undefined) return undefined;
  try {
    const state = stateFor(handle, identity);
    return state === undefined ? REPOSITORY_RESULT_REFUSAL : state.plan.resultRefusal?.();
  } catch { return REPOSITORY_RESULT_REFUSAL; }
}
