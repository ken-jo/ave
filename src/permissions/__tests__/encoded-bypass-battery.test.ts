import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import * as shellPolicy from "../rules/shell-prefix-policy.js";
import * as powerShellPolicy from "../rules/powershell-exfiltration.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "../rules/shell-prefix-values.js";
import { normalizeRuleSpecifierInput, parseRuleSpecifier } from "../rules/rule-specifier.js";
import { validatePermissionRule } from "../rules/rule-files.js";
import {
  __resetSessionStoreForTest,
  canonicalStringify,
  captureApprovalWorkingDirectory,
  lookupApproval,
  lookupUserDecision,
  recordApproval,
} from "../user-approval-store.js";
import type { ShellRuleDialect, UserApprovalScope } from "../../shared/permissions-events.js";
import { encodeScript } from "./fixtures/encoded-command.js";

// Commands are inert parser fixtures. The sandbox owns execution confinement;
// unsandboxed exact rules require a complete proof of literal argv.
const DESTRUCTIVE_SCRIPT = "rm -rf /";
const DESTRUCTIVE_PAYLOAD = "cgBtACAALQByAGYAIAAvAA==";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UTF16LE_BOM_PAYLOAD = "//5yAG0AIAAtAHIAZgAgAC8A";

const INNER_COMMAND = `pwsh -enc ${DESTRUCTIVE_PAYLOAD}`;
const DOUBLE_PAYLOAD = encodeScript(INNER_COMMAND);
const TRIPLE_PAYLOAD = encodeScript(`pwsh -enc ${DOUBLE_PAYLOAD}`);
const SPACED_PAYLOAD = DESTRUCTIVE_PAYLOAD.match(/.{1,4}/g)!.join(" ");
const DESTRUCTIVE_UTF8_PAYLOAD = Buffer.from(DESTRUCTIVE_SCRIPT, "utf8").toString("base64");
const LOW_ASCII_SCRIPT = "Write-Output '한글로 작성한 안전한 문자열과 추가 문자열입니다'";
const KOREAN_SCRIPT = "Write-Output '한글'; Get-Date; Get-Location; Write-Output 'ready';";
const PAYLOAD_LEFT = DESTRUCTIVE_PAYLOAD.slice(0, 12);
const PAYLOAD_RIGHT = DESTRUCTIVE_PAYLOAD.slice(12);
const SCAN_NOISE = Array.from({ length: 128 }, (_, index) => `AAAAAAAA${index.toString(16).padStart(4, "0")}`).join(" ");
const DISCLOSURE_NOISE = Array.from({ length: 8 }, (_, index) => encodeScript(`Write-Output ready${index}`)).join(":");
const SPACED_ODD_PAYLOAD = "cgB tAC AAL QBy AGY AIA AvA A==";
// Long input remains unproven without entering either dialect parser.
const OVER_CAP_COMMAND = `echo ${"a".repeat(17_000)}`;
// A lex that runs out of budget (a long trailing comment) must not read as an empty command.
const LEX_BUDGET_COMMAND = `pwsh -enc $env:X # ${"x".repeat(10_000)}`;

interface EncodedCase {
  readonly name: string;
  readonly dialect: ShellRuleDialect;
  readonly command: string;
  readonly allowBody: string;
  readonly decodedScript?: string;
  readonly exactAllowed?: boolean;
  readonly offerAllowed?: boolean;
  readonly visibleFloor?: boolean;
}

const ENCODED_CASES: readonly EncodedCase[] = [
  { name: "alternate executable from a command shell", dialect: "bash", command: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "alternate executable from a structured shell", dialect: "powershell", command: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "nested encoded script from a command shell", dialect: "bash", command: `pwsh -enc ${DOUBLE_PAYLOAD}`, allowBody: `pwsh -enc ${DOUBLE_PAYLOAD}` },
  { name: "nested encoded script from a structured shell", dialect: "powershell", command: `pwsh -enc ${DOUBLE_PAYLOAD}`, allowBody: `pwsh -enc ${DOUBLE_PAYLOAD}` },
  { name: "conditional launcher from a command shell", dialect: "bash", command: `cmd /c if 1==1 ${INNER_COMMAND}`, allowBody: `cmd /c if 1==1 ${INNER_COMMAND}` },
  { name: "conditional launcher from a structured shell", dialect: "powershell", command: `cmd /c if 1==1 ${INNER_COMMAND}`, allowBody: `cmd /c if 1==1 ${INNER_COMMAND}` },
  { name: "alternate shell long command option from a command shell", dialect: "bash", command: `fish --command '${INNER_COMMAND}'`, allowBody: "fish *" },
  { name: "alternate shell long command option from a structured shell", dialect: "powershell", command: `fish --command '${INNER_COMMAND}'`, allowBody: "fish *" },
  { name: "alternate shell initialization option from a command shell", dialect: "bash", command: `fish -C '${INNER_COMMAND}'`, allowBody: "fish *" },
  { name: "alternate shell initialization option from a structured shell", dialect: "powershell", command: `fish -C '${INNER_COMMAND}'`, allowBody: "fish *" },
  { name: "glued split-string launcher from a command shell", dialect: "bash", command: `env -Spwsh -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `env -Spwsh -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "glued split-string launcher from a structured shell", dialect: "powershell", command: `env -Spwsh -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `env -Spwsh -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "attached executable parameter with an argument array", dialect: "powershell", command: `Start-Process -FilePath:pwsh -ArgumentList @('-enc','${DESTRUCTIVE_PAYLOAD}')`, allowBody: "start-process *" },
  { name: "expandable here-string selecting the encoded parameter", dialect: "powershell", command: `$flag = '-enc'; pwsh @"\n$flag\n"@ ${DESTRUCTIVE_PAYLOAD}`, allowBody: "pwsh *" },
  { name: "stop-parsing environment expansion selecting the encoded parameter", dialect: "powershell", command: `$env:E = 'nc'; pwsh --% -e%E% ${DESTRUCTIVE_PAYLOAD}`, allowBody: "pwsh *" },
];

// All payloads below are literal UTF-16LE Base64, including nested encodings.
const COMPOSED_CASES: readonly EncodedCase[] = [
  { name: "versioned shell executable", dialect: "bash", exactAllowed: true, command: `ksh93 -c '${INNER_COMMAND}'`, allowBody: "ksh93 *" },
  { name: "alternate shell with startup files disabled", dialect: "bash", command: `tcsh -f -c '${INNER_COMMAND}'`, allowBody: "tcsh *" },
  { name: "glued long command option", dialect: "bash", command: `fish --command='${INNER_COMMAND}'`, allowBody: "fish *" },
  { name: "glued long initialization option", dialect: "bash", command: `fish --init-command='${INNER_COMMAND}' -c exit`, allowBody: "fish *" },
  { name: "runner with an attached command-string option", dialect: "bash", command: `npm exec --call='${INNER_COMMAND}'`, allowBody: "npm exec *" },
  { name: "runner composing an attached split-string launcher", dialect: "bash", command: `npm exec --call='env -Spwsh -enc ${DESTRUCTIVE_PAYLOAD}'`, allowBody: "npm exec *" },
  { name: "triple encoded script from a command shell", dialect: "bash", command: `pwsh -enc ${TRIPLE_PAYLOAD}`, allowBody: `pwsh -enc ${TRIPLE_PAYLOAD}` },
  { name: "triple encoded script from a structured shell", dialect: "powershell", command: `pwsh -enc ${TRIPLE_PAYLOAD}`, allowBody: `pwsh -enc ${TRIPLE_PAYLOAD}` },
  { name: "payload assembled from adjacent quoted fragments", dialect: "bash", command: `pwsh -enc '${PAYLOAD_LEFT}'"${PAYLOAD_RIGHT}"`, allowBody: `pwsh -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "encoded script with a byte-order mark", dialect: "bash", command: `pwsh -enc ${UTF16LE_BOM_PAYLOAD}`, allowBody: `pwsh -enc ${UTF16LE_BOM_PAYLOAD}` },
  { name: "nested encoded script behind a quoted split-string launcher", dialect: "bash", command: `env -S 'pwsh -enc ${DOUBLE_PAYLOAD}'`, allowBody: "env *" },
  { name: "literal encoded operand containing ignored whitespace from a command shell", dialect: "bash", command: `pwsh -enc '${SPACED_PAYLOAD}'`, allowBody: "pwsh *" },
  { name: "literal encoded operand containing ignored whitespace from a structured shell", dialect: "powershell", command: `pwsh -enc '${SPACED_PAYLOAD}'`, allowBody: "pwsh *" },
  { name: "mostly ASCII encoded script with a Korean literal from a command shell", dialect: "bash", command: `pwsh -enc ${encodeScript(KOREAN_SCRIPT)}`, allowBody: `pwsh -enc ${encodeScript(KOREAN_SCRIPT)}`, decodedScript: KOREAN_SCRIPT },
  { name: "mostly ASCII encoded script with a Korean literal from a structured shell", dialect: "powershell", command: `pwsh -enc ${encodeScript(KOREAN_SCRIPT)}`, allowBody: `pwsh -enc ${encodeScript(KOREAN_SCRIPT)}`, decodedScript: KOREAN_SCRIPT },
];

const UTF16_DATA_CASES = [
  { name: "UTF-16LE payload as a print argument", command: `printf %s ${DESTRUCTIVE_PAYLOAD}`, allowBody: `printf %s ${DESTRUCTIVE_PAYLOAD}`, decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "UTF-16LE payload inside a commit message", command: `git commit -m 'snapshot ${DESTRUCTIVE_PAYLOAD}'`, allowBody: "git commit *", decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "UTF-16LE payload inside quoted data passed through a wrapper", command: `env printf %s '${INNER_COMMAND}'`, allowBody: "env *", decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "UTF-16LE Base64 run inside a larger data token", command: `printf %s 'data:${DESTRUCTIVE_PAYLOAD}:end'`, allowBody: "printf *", decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "UTF-16LE payload decoding to a benign script", command: `printf %s ${encodeScript("Get-Date")}`, allowBody: `printf %s ${encodeScript("Get-Date")}`, decodedScript: "Get-Date" },
  { name: "mostly ASCII UTF-16LE payload with a Korean literal", command: `printf %s ${encodeScript(KOREAN_SCRIPT)}`, allowBody: `printf %s ${encodeScript(KOREAN_SCRIPT)}`, decodedScript: KOREAN_SCRIPT },
] as const;

const LITERAL_TEXT_CASES = [
  { name: "exactly ninety percent ASCII-range units", script: "Write-Output '한글'; #" },
  { name: "just below ninety percent ASCII-range units", script: "Write-Output '한글';#" },
  { name: "exactly eight ASCII-range units", script: "Get-Date" },
  { name: "only seven ASCII-range units", script: "Get-Dat" },
  { name: "a surrogate pair counted as two non-ASCII units", script: "Get-Date #😀" },
  { name: "a UTF-16LE data argument below the ASCII ratio", script: LOW_ASCII_SCRIPT },
  { name: "tab and line endings counted as ASCII-range units", script: "\tGet-Date\r\n" },
] as const;

// These operands cannot be resolved statically. Even where a literal value
// appears in an earlier assignment, this group does not require decoded text.
const UNRESOLVED_OPERAND_CASES: readonly EncodedCase[] = [
  { name: "payload assembled from literal expression tokens", dialect: "powershell", command: `pwsh -enc ('${PAYLOAD_LEFT}' + '${PAYLOAD_RIGHT}')`, allowBody: "pwsh *" },
  { name: "payload in an explicitly assigned environment variable", dialect: "powershell", command: `$env:ENCODED_SCRIPT = '${DESTRUCTIVE_PAYLOAD}'; pwsh -enc $env:ENCODED_SCRIPT`, allowBody: "pwsh *" },
  { name: "payload in an explicitly exported environment variable", dialect: "bash", command: `export ENCODED_SCRIPT='${DESTRUCTIVE_PAYLOAD}'; pwsh -enc "$ENCODED_SCRIPT"`, allowBody: "pwsh *" },
  { name: "short encoded flag with a variable operand", dialect: "powershell", command: "pwsh -e $payload", allowBody: "pwsh *" },
  { name: "slash encoded flag with a splatted operand", dialect: "powershell", command: "pwsh /ec @payload", allowBody: "pwsh *" },
  { name: "dash-like encoded abbreviation with a subexpression operand", dialect: "powershell", command: "pwsh \u2013enco $(Get-Content ./x.txt)", allowBody: "pwsh *" },
  { name: "full encoded flag with an undecodable literal", dialect: "bash", command: "pwsh -EncodedCommand 'not-base64!'", allowBody: "pwsh *" },
  { name: "encoded flag missing its operand", dialect: "bash", command: "pwsh -enc", allowBody: "pwsh -enc" },
  { name: "second dash-like encoded flag with an undecodable literal", dialect: "bash", command: "pwsh \u2014eC 'not-base64!'", allowBody: "pwsh *" },
  { name: "slash encoded abbreviation with an environment operand", dialect: "powershell", command: "pwsh /encodedcomm $env:PAYLOAD", allowBody: "pwsh *" },
  { name: "extended executable name with a variable operand", dialect: "powershell", command: "pwsh-preview -enc $X", allowBody: "pwsh-preview *" },
  { name: "path-prefixed extended executable name with a concatenated operand", dialect: "powershell", command: String.raw`C:\Tools\powershell_ise.exe -enc ('a'+'b')`, allowBody: "powershell_ise *" },
  { name: "distribution wrapper with an inner variable operand", dialect: "bash", command: "wsl pwsh -enc $X", allowBody: "wsl *" },
  { name: "environment wrapper with an inner variable operand", dialect: "bash", command: "env pwsh -enc $X", allowBody: "env *" },
  { name: "dynamic called program with a variable operand", dialect: "powershell", command: "& $p -enc $X", allowBody: "pwsh *" },
  { name: "an earlier matching name in ordinary data from a command shell", exactAllowed: true, dialect: "bash", command: "printf %s pwsh -enc 'not-base64!'", allowBody: "printf *" },
  { name: "an earlier matching name in ordinary data from a structured shell", exactAllowed: true, dialect: "powershell", command: "printf %s pwsh -enc 'not-base64!'", allowBody: "printf *" },
];

const PIPELINE_CASES: readonly EncodedCase[] = [
  { name: "literal text piped to a shell", visibleFloor: true, dialect: "bash", command: `printf %s '${DESTRUCTIVE_SCRIPT}' | sh`, allowBody: "sh *" },
  { name: "literal text piped to an alternate shell", visibleFloor: true, dialect: "bash", command: `printf %s '${DESTRUCTIVE_SCRIPT}' | bash`, allowBody: "bash *" },
  { name: "literal text piped to an explicit stdin shell", visibleFloor: true, dialect: "powershell", command: `Write-Output '${DESTRUCTIVE_SCRIPT}' | pwsh -`, allowBody: "pwsh *" },
  { name: "literal text piped to an expression evaluator", visibleFloor: true, dialect: "powershell", command: `Write-Output '${DESTRUCTIVE_SCRIPT}' | iex`, allowBody: "iex *" },
  { name: "UTF-8 Base64 decoded into a shell pipeline", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh`, allowBody: "sh *" },
  { name: "UTF-8 Base64 decoded into a shell through a wrapper", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | env sh`, allowBody: "env *" },
  { name: "text piped to an interpreter's explicit stdin", dialect: "bash", command: "printf %s 'print(1)' | python3 -", allowBody: "python3 *" },
  { name: "text piped to a command-stdin invocation", dialect: "powershell", command: "Write-Output Get-Date | powershell -Command -", allowBody: "powershell *" },
];

const BOUNDED_AND_NESTED_CASES: readonly EncodedCase[] = [
  { name: "bash: scan budget", dialect: "bash", command: `# ${SCAN_NOISE}\npwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "powershell: scan budget", dialect: "powershell", command: `# ${SCAN_NOISE}\npwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: `pwsh-preview -enc ${DESTRUCTIVE_PAYLOAD}` },
  { name: "powershell: double-dash encoded flag", dialect: "powershell", command: "pwsh --enc $env:PAYLOAD", allowBody: "pwsh *" },
  { name: "bash: double-dash encoded flag", dialect: "bash", command: 'pwsh --enc "$PAYLOAD"', allowBody: "pwsh *" },
  { name: "bash: dynamic child program", dialect: "bash", command: "pwsh -Command '& $env:TARGET -enc $env:PAYLOAD'", allowBody: "pwsh *" },
  { name: "powershell: dynamic child program", dialect: "powershell", command: "pwsh -Command '& $env:TARGET -enc $env:PAYLOAD'", allowBody: "pwsh *" },
  { name: "powershell: dynamic cmd child", dialect: "powershell", command: "cmd /c $env:TARGET -enc $env:PAYLOAD", allowBody: "cmd *" },
  { name: "bash: sh stdin after --", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh -s -- -c ignored`, allowBody: "sh *" },
  { name: "bash: bash stdin after --", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | bash -s -- -c ignored`, allowBody: "bash *" },
  { name: "bash: child pipeline", dialect: "bash", command: `bash -c 'printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh'`, allowBody: "bash *" },
  { name: "powershell: child pipeline", dialect: "powershell", command: `pwsh -Command 'Write-Output ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh'`, allowBody: "pwsh *" },
  { name: "bash: ninth decoded script", dialect: "bash", command: `# ${DISCLOSURE_NOISE}\n${INNER_COMMAND}`, allowBody: INNER_COMMAND, decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "powershell: ninth decoded script", dialect: "powershell", command: `# ${DISCLOSURE_NOISE}\n${INNER_COMMAND}`, allowBody: INNER_COMMAND, decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "bash: input over the hard cap", dialect: "bash", command: OVER_CAP_COMMAND, allowBody: "echo *" },
  { name: "powershell: input over the hard cap", dialect: "powershell", command: OVER_CAP_COMMAND, allowBody: "echo *" },
  { name: "bash: lex budget exhausted", dialect: "bash", command: LEX_BUDGET_COMMAND, allowBody: "pwsh *" },
  { name: "powershell: lex budget exhausted", dialect: "powershell", command: LEX_BUDGET_COMMAND, allowBody: "pwsh *" },
  { name: "bash: alternate launcher with a dynamic child", dialect: "bash", command: "pwsh-preview -Command '& $env:TARGET -enc $env:PAYLOAD'", allowBody: "pwsh-preview *" },
  { name: "powershell: alternate launcher with a dynamic child", dialect: "powershell", command: "pwsh-preview -Command '& $env:TARGET -enc $env:PAYLOAD'", allowBody: "pwsh-preview *" },
  { name: "bash: glued long option feeds a pipeline", dialect: "bash", command: `fish --command='printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh'`, allowBody: "fish *" },
  { name: "powershell: glued long option feeds a pipeline", dialect: "powershell", command: `fish --command='printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh'`, allowBody: "fish *" },
  { name: "bash: glued cmd slash option carries encoded code", dialect: "bash", command: 'cmd /c"pwsh -enc %PAYLOAD%"', allowBody: "cmd *" },
  { name: "powershell: spaced cmd slash option carries encoded code", dialect: "powershell", command: 'cmd /c "pwsh -enc %PAYLOAD%"', allowBody: "cmd *" },
];

const WHITESPACE_PAYLOAD_CASES: readonly EncodedCase[] = [
  { name: "bash: whitespace-split payload in a data position", exactAllowed: true, dialect: "bash", command: `printf %s ${SPACED_ODD_PAYLOAD}`, allowBody: `printf %s ${SPACED_ODD_PAYLOAD}`, decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "powershell: whitespace-split payload in a data position", exactAllowed: true, dialect: "powershell", command: `printf %s ${SPACED_ODD_PAYLOAD}`, allowBody: `printf %s ${SPACED_ODD_PAYLOAD}`, decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "bash: whitespace-split payload in a quoted encoded operand", dialect: "bash", command: `pwsh -enc '${SPACED_ODD_PAYLOAD}'`, allowBody: "pwsh *", decodedScript: DESTRUCTIVE_SCRIPT },
  { name: "powershell: whitespace-split payload in a quoted encoded operand", dialect: "powershell", command: `pwsh -enc '${SPACED_ODD_PAYLOAD}'`, allowBody: "pwsh *", decodedScript: DESTRUCTIVE_SCRIPT },
];

const FILE_COMMANDS = [
  { name: "an explicit script-file operand", command: "pwsh -f ./x.ps1" },
  { name: "an implicit script-file operand", command: "pwsh ./x.ps1" },
] as const;

// Frozen observations from real modules at origin/main commit
// d3a90c8144cd30fd3b1eb514ceee037aa74b1256: allow mode, no saved rules,
// both source dialects and both file commands below, with the same BOM file.
// The baseline card builder was Bash-only and returned exactRule:null for
// both commands; the other dialect had no exact-rule offer. Keeping these
// observations inline makes the regression suite require no second checkout.
const FILE_EXECUTION_BASELINE = {
  sandboxed: { decision: "allow", layer: 3 },
  unsandboxed: { decision: "ask", layer: 6 },
  exactRule: null,
} as const;

let cwd: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "encoded-approval-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});

afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

function check(command: string, dialect: ShellRuleDialect, runsSandboxed: boolean, headless = false) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed },
    sessionId: SESSION_ID,
    headless,
  });
}


function storedAllowPattern(fixture: EncodedCase): string {
  const kind = fixture.dialect === "bash" ? "Bash" : "PowerShell";
  const candidate = normalizeRuleSpecifierInput(`${kind}(${fixture.command})`);
  try {
    validatePermissionRule({ pattern: candidate, action: "allow" });
    const spec = parseRuleSpecifier(candidate);
    if ((spec.kind === "bash" || spec.kind === "powershell") && !spec.wildcard) return candidate;
  } catch {
    // Unrepresentable syntax still exercises a previously saved broad allow.
  }
  return `${kind}(${fixture.allowBody})`;
}

function requireLaneBehavior(fixture: EncodedCase): void {
  const { command, dialect, exactAllowed = false, visibleFloor = false } = fixture;
  const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID);
  const offerAllowed = fixture.offerAllowed ?? exactAllowed;
  if (offerAllowed) expect.soft(card.exactRule, "literal data can be remembered").not.toBeNull();
  else expect.soft(card.exactRule, "unproven or sensitive commands cannot be remembered").toBeNull();
  expect.soft(card.sessionAllowed).toBe(offerAllowed);
  expect.soft(card.persistentAllowed).toBe(offerAllowed);
  for (const saved of [false, true]) {
    // The legacy snapshot also tests rules saved before literal proof existed.
    const rules: PermissionRule[] = saved ? [
      { pattern: dialect, action: "allow" },
      { pattern: storedAllowPattern(fixture), action: "allow" },
    ] : [];
    manager.setRules(rules);
    const ordinary = check(command, dialect, false);
    expect.soft(ordinary.decision, `unsandboxed, saved=${saved}`).toBe(saved && exactAllowed ? "allow" : "ask");
    expect.soft(check(command, dialect, false, true).decision, `headless, saved=${saved}`).toBe(saved && exactAllowed ? "allow" : "deny");
    const sandboxed = check(command, dialect, true);
    expect.soft(sandboxed, `sandboxed, saved=${saved}`).toMatchObject(visibleFloor
      ? { decision: "ask", layer: 2, forceModal: true }
      : { decision: "allow", layer: 3 });
    if (!visibleFloor) expect.soft(sandboxed.forceModal).not.toBe(true);
  }
}

const CARRIER_AND_DATA_CASES: readonly EncodedCase[] = [
  ...ENCODED_CASES,
  ...COMPOSED_CASES,
  ...UTF16_DATA_CASES.flatMap((fixture) => (["bash", "powershell"] as const).map((dialect) => ({ ...fixture, dialect, exactAllowed: true }))),
  ...UNRESOLVED_OPERAND_CASES,
  ...PIPELINE_CASES,
  ...BOUNDED_AND_NESTED_CASES,
  ...WHITESPACE_PAYLOAD_CASES,
];

describe("literal proof and execution lanes", () => {
  it.each(CARRIER_AND_DATA_CASES)("$dialect: $name", requireLaneBehavior);
});

const OPAQUE_CARRIER_CASES: readonly EncodedCase[] = [
  { name: "redirect with a variable operand", dialect: "bash", command: "pwsh -enc $env:PAYLOAD > out.txt", allowBody: "pwsh *" },
  { name: "redirect with a backtick escaped operand", dialect: "powershell", command: "pwsh -enc cgBtACAALQBy`AGYAIAAvAA== > out.txt", allowBody: "pwsh *" },
  { name: "caret escape inside a command string", dialect: "powershell", command: 'cmd /c "pwsh -en^c %PAYLOAD%"', allowBody: "cmd *" },
  { name: "caret escape inside a command string from bash", dialect: "bash", command: 'cmd /c "pwsh -en^c %PAYLOAD%"', allowBody: "cmd *" },
  { name: "nine padding chunks before a stdin carrier", dialect: "bash", command: `printf %s ${"AAAA ".repeat(9)}${DESTRUCTIVE_PAYLOAD} | pwsh -Command -`, allowBody: "pwsh *" },
  { name: "two hundred fifty-six padding chunks in an encoded operand", dialect: "powershell", command: `pwsh -enc '${"AAAA ".repeat(256)}${DESTRUCTIVE_PAYLOAD}'`, allowBody: "pwsh *" },
  { name: "one hundred kilobyte input", dialect: "bash", command: `echo ${"a".repeat(100_000)}`, allowBody: "echo *" },
  { name: "stdin to a script-file interpreter", dialect: "bash", command: "printf input | python3 scripts/consume.py", allowBody: "python3 *" },
  ...(["bash", "powershell"] as const).flatMap((dialect) => [
    { name: "quoted padding remains literal data", dialect, command: `printf %s '${"AAAA ".repeat(9)}${DESTRUCTIVE_PAYLOAD}'`, allowBody: "printf *", exactAllowed: true },
    { name: "quoted padding remains a carrier operand", dialect, command: `pwsh -enc '${"AAAA ".repeat(9)}${DESTRUCTIVE_PAYLOAD}'`, allowBody: "pwsh *" },
    { name: "literal operand after sixty-four decoys", dialect, command: `# ${Array.from({ length: 64 }, (_, index) => encodeScript(`Write-Output decoy${index}`)).join(" ")}
pwsh -enc ${DESTRUCTIVE_PAYLOAD}`, allowBody: "pwsh *" },
  ]),
];

describe("opaque carriers and padded data", () => {
  it.each(OPAQUE_CARRIER_CASES)("$dialect: $name", (fixture) => {
    requireLaneBehavior(fixture);
    if (fixture.name === "literal operand after sixty-four decoys") {
      const card = buildShellRuleApproval(fixture.dialect, fixture.command, cwd, { allow: true, deny: true }, SESSION_ID);
      expect(card.decodedCommands).toEqual([DESTRUCTIVE_SCRIPT]);
    }
  });
});

describe.each(["bash", "powershell"] as const)("literal file-execution parity (%s)", (dialect) => {
  it.each(FILE_COMMANDS)("preserves the baseline for $name", ({ command }) => {
    const file = join(cwd, "x.ps1");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DESTRUCTIVE_SCRIPT, "utf16le")]));
    expect(readFileSync(file).toString("utf16le")).toBe(`\uFEFF${DESTRUCTIVE_SCRIPT}`);
    requireLaneBehavior({ name: "script file", dialect, command, allowBody: command });
    for (const runsSandboxed of [true, false]) {
      manager.setRules([]);
      expect(check(command, dialect, runsSandboxed)).toMatchObject(runsSandboxed
        ? FILE_EXECUTION_BASELINE.sandboxed : FILE_EXECUTION_BASELINE.unsandboxed);
    }
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID).decodedCommands ?? []).toEqual([]);
  });
});

describe.each(["bash", "powershell"] as const)("literal encoded data (%s)", (dialect) => {
  it.each(LITERAL_TEXT_CASES)("treats $name as data", ({ name, script }) => {
    const command = `printf %s ${encodeScript(script)}`;
    requireLaneBehavior({ name, dialect, command, allowBody: command, exactAllowed: true });
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID).decodedCommands ?? []).toEqual([]);
  });
});

describe.each(["bash", "powershell"] as const)("permission decision input bounds (%s)", (dialect) => {
  it.each([16_384, 100_000])("decides %i characters through the complete manager path", (length) => {
    const command = `printf %s ${"cgB tAC AAL QBy AGY AIA AvA ".repeat(Math.ceil(length / 28))}`.slice(0, length);
    expect(command.length).toBe(length);
    expect(command.length).toBeGreaterThan(MAX_LITERAL_COMMAND_LENGTH);
    const bashParser = vi.spyOn(shellPolicy, "parseShellCommand");
    const powerShellParser = vi.spyOn(powerShellPolicy, "inspectPowerShellCommand");
    const powerShellShape = vi.spyOn(powerShellPolicy, "powerShellRuleShape");
    try {
      const start = performance.now();
      const result = check(command, dialect, false);
      const elapsed = performance.now() - start;
      expect(result).toMatchObject({ decision: "ask", layer: 6 });
      process.stdout.write(`permission decision ${dialect} ${length} chars: ${elapsed.toFixed(3)} ms\n`);
      expect(elapsed).toBeLessThan(250);
      expect(bashParser).not.toHaveBeenCalled();
      expect(powerShellParser).not.toHaveBeenCalled();
      expect(powerShellShape).not.toHaveBeenCalled();
      const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID);
      expect(card.exactRule).toBeNull();
      expect(bashParser).not.toHaveBeenCalled();
      expect(powerShellParser).not.toHaveBeenCalled();
      expect(powerShellShape).not.toHaveBeenCalled();
    } finally {
      bashParser.mockRestore();
      powerShellParser.mockRestore();
      powerShellShape.mockRestore();
    }
  });
});


const BASE64_SHA256 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DATA_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl";
const UTF8_DATA = "Zml4dHVyZS1kYXRh";
const LONG_UTF8_DATA = "cmVjb3JkIGZpeHR1cmUgY2hhbmdlcw==";
const LITERAL_COMMANDS = [
  { name: "a Base64 hash argument", command: `printf %s ${BASE64_SHA256}` },
  { name: "a synthetic JWT argument", command: `printf %s ${DATA_JWT}` },
  { name: "a plain commit message", command: "git commit -m 'record fixture changes'" },
  { name: "a literal distribution directory listing", command: "wsl ls" },
  { name: "a literal command-string invocation", command: "pwsh -Command Get-Date" },
  { name: "a hexadecimal hash argument", command: `git show ${SHA256_HEX}` },
  { name: "UTF-8 Base64 passed as ordinary data", command: `printf %s ${UTF8_DATA}` },
  { name: "longer UTF-8 Base64 passed as ordinary data", command: `printf %s ${LONG_UTF8_DATA}` },
  { name: "a commit message containing UTF-8 Base64 text", command: `git commit -m 'snapshot ${LONG_UTF8_DATA}'` },
  { name: "a wrapper passing plain literal text as data", command: "env printf %s 'record fixture changes'" },
  { name: "an encoded-looking flag passed as print data", command: "printf %s -enc 'not-base64!'" },
  { name: "a slash encoded-looking flag passed as print data", command: "printf %s /enc 'not-base64!'" },
  { name: "a dash-like encoded-looking flag passed as print data", command: "printf %s \u2013enc 'not-base64!'" },
  { name: "an inline option of a script runtime", command: "node -e 'x'" },
  { name: "an inline option of another script runtime", command: "perl -e 'x'" },
  { name: "a search pattern option", command: "grep -e foo" },
  { name: "a text substitution option", command: "sed -e s/a/b/" },
  { name: "a data basename containing but not starting with a shell name", command: "printf %s notpwsh -enc 'not-base64!'" },
  { name: "a shell name only in a data path's directory component", command: "printf %s pwsh-tools/marker -enc 'not-base64!'" },
  { name: "a matching name confined to an earlier command", command: "printf pwsh; printf %s -enc 'not-base64!'" },
  { name: "a matching name appearing after the encoded-looking flag", command: "printf %s -enc 'not-base64!' pwsh" },
] as const;


const UNPROVEN_LITERAL_CASE_NAMES = new Set([
  "a literal distribution directory listing",
  "a literal command-string invocation",
  "an inline option of a script runtime",
  "an inline option of another script runtime",
  "a matching name confined to an earlier command",
]);

describe.each(["bash", "powershell"] as const)("literal argument handling (%s)", (dialect) => {
  it.each(LITERAL_COMMANDS)("proves only literal data for $name", ({ name, command }) => {
    requireLaneBehavior({ name, command, dialect, allowBody: UNPROVEN_LITERAL_CASE_NAMES.has(name) ? "printf *" : command, exactAllowed: !UNPROVEN_LITERAL_CASE_NAMES.has(name), offerAllowed: name === "a synthetic JWT argument" ? false : !UNPROVEN_LITERAL_CASE_NAMES.has(name) });
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID).decodedCommands ?? []).toEqual([]);
  });
});

const NON_LITERAL_CASES = [
  { name: "a here-string argument", command: "Write-Output @'\nready\n'@" },
  { name: "stop-parsing arguments", command: "cmd --% /c echo ready" },
  { name: "a native command-variable expansion", command: "cmd /c echo %GREETING%" },
] as const;

describe("non-literal argument rule proposals", () => {
  it.each(NON_LITERAL_CASES)("does not propose an exact rule for $name", ({ name, command }) => {
    requireLaneBehavior({ name, command, dialect: "powershell", allowBody: "cmd *" });
  });
});

describe.each(["bash", "powershell"] as const)("quoted literal rule persistence (%s)", (dialect) => {
  it("saves the canonical literal argv and matches equivalent quoting", async () => {
    const command = "git commit -m 'record fixture changes'";
    const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID);
    const kind = dialect === "bash" ? "Bash" : "PowerShell";
    expect(card.exactRule).toBe(`${kind}(git commit -m 'record fixture changes')`);
    await manager.addRulePersist({ pattern: card.exactRule!, action: "allow" }, { kind: "user" });
    expect(check(command, dialect, false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(check('git commit -m "record fixture changes"', dialect, false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(check("git commit -m 'different message'", dialect, false).decision).toBe("ask");
  });

  it.each([
    { name: "variable expansion", command: 'git commit -m "$MESSAGE"' },
    { name: "command expansion", command: 'git commit -m "$(echo ready)"' },
    { name: "escape expansion", command: dialect === "bash" ? 'git commit -m "line\\n"' : 'git commit -m "line`n"' },
  ])("keeps $name unproven inside quotes", ({ name, command }) => {
    requireLaneBehavior({ name, command, dialect, allowBody: "git commit *" });
  });
});


const RULE_SCOPE_CASES = [
  { dialect: "bash", denyScope: "global" },
  { dialect: "bash", denyScope: "project" },
  { dialect: "powershell", denyScope: "global" },
  { dialect: "powershell", denyScope: "project" },
] as const;

describe("shell rule deny precedence", () => {
  it.each(RULE_SCOPE_CASES)("$dialect: $denyScope deny beats other scopes' allows", async ({ dialect, denyScope }) => {
    const kind = dialect === "bash" ? "Bash" : "PowerShell";
    const subjects = [
      {
        command: dialect === "bash" ? "printf ready" : "Get-ChildItem src",
        exact: dialect === "bash" ? "Bash(printf ready)" : "PowerShell(get-childitem src)",
        deny: dialect === "bash" ? "Bash(printf *)" : "PowerShell(get-childitem *)",
        encoded: false,
      },
      {
        command: INNER_COMMAND,
        exact: `${kind}(${INNER_COMMAND})`,
        deny: `${kind}(pwsh *)`,
        encoded: true,
      },
    ];
    // Denial precedes both confinement and remembered exact allows.
    for (const { command, exact, deny, encoded } of subjects) {
      manager.setRules([{
        pattern: denyScope === "global" ? deny : encoded ? dialect : exact,
        action: denyScope === "global" ? "deny" : "allow",
      }]);
      if (!encoded || denyScope === "project") {
        await manager.addRulePersist({
          pattern: denyScope === "project" ? deny : exact,
          action: denyScope === "project" ? "deny" : "allow",
        }, { kind: "project", projectCwd: cwd });
      }
      if (!encoded) manager.addSessionRule(SESSION_ID, exact);

      for (const runsSandboxed of [true, false]) {
        for (const headless of [false, true]) {
          expect(manager.checkDetailed(dialect, "builtin", "shell", null, {
            ruleSubject: { kind: "shell", dialect, command, cwd },
            projectRulesCwd: cwd,
            sessionId: SESSION_ID,
            shellExecution: { runsSandboxed },
            headless,
          })).toMatchObject({ decision: "deny", layer: 1 });
        }
      }
    }
  });
});

const EXACT_SCOPE_CASES = [
  { denyScope: "session", allowScope: "persistent" },
  { denyScope: "session", allowScope: "global" },
  { denyScope: "persistent", allowScope: "session" },
  { denyScope: "persistent", allowScope: "global" },
  { denyScope: "global", allowScope: "session" },
  { denyScope: "global", allowScope: "persistent" },
] as const;

async function recordExactDecision(args: string, scope: UserApprovalScope, decision: "allow" | "deny"): Promise<void> {
  await recordApproval("read_file", args, "builtin", {
    scope,
    decision,
    verdictAtApproval: "medium",
    nlJustification: null,
    ...(scope === "session" ? { sessionId: SESSION_ID } : {}),
    ...(scope === "global" ? {} : { workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity }),
  });
}

describe("exact decision deny precedence", () => {
  it.each(EXACT_SCOPE_CASES)("$denyScope deny beats $allowScope allow", async ({ denyScope, allowScope }) => {
    // Both write orders use independent input identities, so an earlier deny
    // cannot accidentally supply the expected result for the second order.
    for (const denyFirst of [false, true]) {
      const args = canonicalStringify({ path: denyFirst ? "deny-first.md" : "allow-first.md" });
      const entries = denyFirst
        ? [[denyScope, "deny"], [allowScope, "allow"]] as const
        : [[allowScope, "allow"], [denyScope, "deny"]] as const;
      for (const [scope, decision] of entries) await recordExactDecision(args, scope, decision);

      const stored = await lookupUserDecision("read_file", args, "builtin", undefined, undefined, cwd, SESSION_ID);
      expect(stored).toMatchObject({ decision: "deny", scope: denyScope });
      expect(await lookupApproval("read_file", args, "builtin", undefined, undefined, cwd, SESSION_ID)).toBeNull();
    }
    expect(await lookupUserDecision("read_file", canonicalStringify({ path: "unrelated.md" }), "builtin", undefined, undefined, cwd, SESSION_ID)).toBeNull();
  });
});
