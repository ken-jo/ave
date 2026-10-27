import { resolve } from "node:path";
import { isPowerShellStartupPinned } from "../shared/powershell-startup-policy.js";
import { literalShellWord, parseShellFloorCommand } from "./rules/shell-exfiltration.js";
import { parsePowerShellCommand, type ParsedPowerShellCommand } from "./rules/powershell-exfiltration.js";
import type { ParsedShellCommand } from "./rules/shell-prefix-policy.js";
import { bindVerifiedArgvProof } from "./rules/verified-argv-authority.js";
import { proveVerifiedLauncherArgv } from "./rules/verified-launcher-argv.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "./rules/shell-prefix-values.js";
import { encodedPowerShellExecutionReason } from "./rules/powershell-encoded-command.js";
import type { VerifiedNativePlan } from "./rules/verified-native-plan.js";

export interface VerifiedShellIdentity { readonly command: string; readonly dialect: "bash" | "powershell"; readonly cwd: string }
declare const verifiedShellBrand: unique symbol;
export interface VerifiedShellCommand { readonly [verifiedShellBrand]: true }
interface VerifiedState { readonly identity: VerifiedShellIdentity; readonly parsed: ParsedShellCommand | ParsedPowerShellCommand; readonly plan: VerifiedNativePlan }
const issued = new WeakMap<VerifiedShellCommand, VerifiedState>();
function proveNative(argv: readonly string[]): VerifiedNativePlan | undefined {
  if (encodedPowerShellExecutionReason(argv) !== null) return undefined;
  return proveVerifiedLauncherArgv(argv) ?? undefined;
}

/** Host tools bind one literal simple command; other callers retain default refusal. */
export function prepareVerifiedShellCommand(identity: VerifiedShellIdentity): VerifiedShellCommand | undefined {
  if (identity.command.length > MAX_LITERAL_COMMAND_LENGTH
    || !/^[\t ]*bash(?:[\t ]|$)/.test(identity.command)) return undefined;
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
    plan = proveNative(argv);
    if (plan === undefined) return undefined;
    bindVerifiedArgvProof(command, plan.proof);
  } else {
    parsed = parsePowerShellCommand(identity.command, (argv) => {
      if (argv.length === 0 || !argv.every((word): word is string => word !== undefined)) return undefined;
      plan = proveNative(argv);
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
    && state.identity.cwd === resolve(identity.cwd) ? state : undefined;
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
  const filtered = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:LD_|DYLD_)/i.test(key)));
  // Config authority comes only from the owned plan, including after wrapping.
  for (const key of Object.keys(state.plan.environment)) {
    for (const inherited of Object.keys(filtered)) if (inherited.toLowerCase() === key.toLowerCase()) delete filtered[inherited];
  }
  return { ...filtered, ...state.plan.environment };
}
