import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { inspectEncodedPowerShell } from "../rules/powershell-encoded-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
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

// Intended location: src/permissions/__tests__/encoded-bypass-battery.test.ts.
// Command strings are parser inputs only; this suite never executes them.
// These are required outcomes, not snapshots of the current implementation.
// The contract is a flat UTF-16LE Base64 scan, including runs inside tokens and
// recursively decoded text; it does not depend on a launcher's argument grammar.
// After removing an encoding BOM, at least 90% of UTF-16 code units must be in
// U+0009-U+007E, with at least eight such units, to qualify as encoded text.
// Readable payloads, including data-position payloads, require decoded display.
// An unresolved encoded flag requires an earlier token in the same command
// whose basename (without .exe/.com/.cmd/.bat) starts with pwsh or powershell,
// case-insensitively, or a dynamic program token. Without either trigger, an
// encoded-looking flag is ordinary data. An earlier matching data token counts.
// Unresolved encoded operands and stdin-to-interpreter pipelines require the
// hidden-code floor without claiming their final script is statically known.
// Here-strings, stop-parsing and command-variable expansion cannot mint exact
// rules. Literal script-file execution retains its measured mainline behavior.
// Source dialects are modeled independently of the test host. Installed shells
// are not prerequisites, including for native Windows stop-parsing fixtures.
// Layer 2 is the human-only floor, layer 3 a rule/confinement allow, and layer 6
// the ordinary unsandboxed ask. Headless checks here only exclude an allow;
// invocation-level denial and audit are outside this unit suite.
// HIDDEN is asserted through the policy outcome. Inspection may represent it
// with decoded scripts or its unreadable-code flag; either requires layer 2.
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
// Each individual noise word decodes to an odd byte count, and joined windows
// remain mostly zero units. None is qualifying text. A comment keeps the noise
// inert at execution while still exercising the raw scan's finite work budget.
const SCAN_NOISE = Array.from({ length: 128 }, (_, index) => `AAAAAAAA${index.toString(16).padStart(4, "0")}`).join(" ");
// Readable data in a comment must not consume every disclosure slot before the
// actual command's payload. The final script stays below the depth/byte bounds.
const DISCLOSURE_NOISE = Array.from({ length: 8 }, (_, index) => encodeScript(`Write-Output ready${index}`)).join(":");

// A fixture check independent of the production decoder. Count UTF-16 code
// units, not Unicode code points; a surrogate pair contributes two units.
function meetsEncodedTextCriterion(script: string): boolean {
  const text = script.replace(/^\uFEFF/, "");
  let asciiUnits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0x09 && unit <= 0x7e) asciiUnits += 1;
  }
  return asciiUnits >= 8 && asciiUnits * 10 >= text.length * 9;
}

interface EncodedCase {
  readonly name: string;
  readonly dialect: ShellRuleDialect;
  readonly command: string;
  // A pre-existing allow snapshot, independent of the card being tested.
  // Exact literal argv is used where representable; otherwise a launcher prefix.
  readonly allowBody: string;
  readonly decodedScript?: string;
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
  { name: "versioned shell executable", dialect: "bash", command: `ksh93 -c '${INNER_COMMAND}'`, allowBody: "ksh93 *" },
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
  // An encoded benign script still needs the hidden-code floor. Destructive
  // text matching alone must not accidentally satisfy every positive case.
  { name: "UTF-16LE payload decoding to a benign script", command: `printf %s ${encodeScript("Get-Date")}`, allowBody: `printf %s ${encodeScript("Get-Date")}`, decodedScript: "Get-Date" },
  { name: "mostly ASCII UTF-16LE payload with a Korean literal", command: `printf %s ${encodeScript(KOREAN_SCRIPT)}`, allowBody: `printf %s ${encodeScript(KOREAN_SCRIPT)}`, decodedScript: KOREAN_SCRIPT },
] as const;

const ASCII_THRESHOLD_CASES = [
  { name: "exactly ninety percent ASCII-range units", script: "Write-Output '한글'; #", qualifies: true },
  { name: "just below ninety percent ASCII-range units", script: "Write-Output '한글';#", qualifies: false },
  { name: "exactly eight ASCII-range units", script: "Get-Date", qualifies: true },
  { name: "only seven ASCII-range units", script: "Get-Dat", qualifies: false },
  { name: "a surrogate pair counted as two non-ASCII units", script: "Get-Date #😀", qualifies: false },
  { name: "a UTF-16LE data argument below the ASCII ratio", script: LOW_ASCII_SCRIPT, qualifies: false },
  { name: "tab and line endings counted as ASCII-range units", script: "\tGet-Date\r\n", qualifies: true },
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
  { name: "an earlier matching name in ordinary data from a command shell", dialect: "bash", command: "printf %s pwsh -enc 'not-base64!'", allowBody: "printf *" },
  { name: "an earlier matching name in ordinary data from a structured shell", dialect: "powershell", command: "printf %s pwsh -enc 'not-base64!'", allowBody: "printf *" },
];

const PIPELINE_CASES: readonly EncodedCase[] = [
  { name: "literal text piped to a shell", dialect: "bash", command: `printf %s '${DESTRUCTIVE_SCRIPT}' | sh`, allowBody: "sh *" },
  { name: "literal text piped to an alternate shell", dialect: "bash", command: `printf %s '${DESTRUCTIVE_SCRIPT}' | bash`, allowBody: "bash *" },
  { name: "literal text piped to an explicit stdin shell", dialect: "powershell", command: `Write-Output '${DESTRUCTIVE_SCRIPT}' | pwsh -`, allowBody: "pwsh *" },
  { name: "literal text piped to an expression evaluator", dialect: "powershell", command: `Write-Output '${DESTRUCTIVE_SCRIPT}' | iex`, allowBody: "iex *" },
  { name: "UTF-8 Base64 decoded into a shell pipeline", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | sh`, allowBody: "sh *" },
  { name: "UTF-8 Base64 decoded into a shell through a wrapper", dialect: "bash", command: `printf %s ${DESTRUCTIVE_UTF8_PAYLOAD} | base64 -d | env sh`, allowBody: "env *" },
  { name: "text piped to an interpreter's explicit stdin", dialect: "bash", command: "printf %s 'print(1)' | python3 -", allowBody: "python3 *" },
  { name: "text piped to a command-stdin invocation", dialect: "powershell", command: "Write-Output Get-Date | powershell -Command -", allowBody: "powershell *" },
];

// Unknown environment values are intentionally unresolved. TARGET can name a
// shell and PAYLOAD can contain encoded code; no static value or disclosure is
// required by the unresolved-operand contract. A child command string is code
// at the next depth, including when its outer argv word is a quoted literal.
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

function savedAllowSnapshot(fixture: EncodedCase): PermissionRule[] {
  const kind = fixture.dialect === "bash" ? "Bash" : "PowerShell";
  return [
    { pattern: fixture.dialect, action: "allow" },
    { pattern: `${kind}(${fixture.allowBody})`, action: "allow" },
  ];
}

function requireHiddenFloor(fixture: EncodedCase, decodedScript: string | null): void {
  const inspection = inspectEncodedPowerShell(fixture.command, fixture.dialect, cwd);
  const card = buildShellRuleApproval(fixture.dialect, fixture.command, cwd, { allow: true, deny: true }, SESSION_ID);

  // Decode expectations come from the literal fixture, never from another
  // production decoder or from the card's own proposed rule.
  expect.soft(inspection.hidden || inspection.scripts.length > 0, "hidden code must be recognized").toBe(true);
  if (decodedScript !== null) {
    expect.soft(meetsEncodedTextCriterion(decodedScript), "the readable fixture must meet the ASCII-unit criterion").toBe(true);
    const disclosed = (scripts: readonly string[]) => scripts.map((script) => script.replace(/^\uFEFF/, ""));
    expect.soft(disclosed(inspection.scripts), "the readable terminal script must be recovered").toContain(decodedScript);
    expect.soft(disclosed(card.decodedCommands ?? []), "the card must disclose the readable terminal script").toContain(decodedScript);
  }
  expect.soft(card.exactRule, "hidden code must not offer an exact allow").toBeNull();
  expect.soft(card.sessionAllowed).toBe(false);
  expect.soft(card.persistentAllowed).toBe(false);

  // Seed the manager's loaded-policy snapshot directly, so a future save-time
  // rejection cannot make coverage of already-stored allows disappear. Some
  // broad command-shell prefixes are intentionally inert; the exact literal
  // fixtures also exercise eligible rules independently of those prefixes.
  // Quoted/grouped argv cannot have a representable exact rule. For those
  // fixtures the modal and disclosure checks carry the additional coverage;
  // an inert prefix is not evidence of an otherwise-matching allow.
  for (const saved of [false, true]) {
    manager.setRules(saved ? savedAllowSnapshot(fixture) : []);
    for (const runsSandboxed of [true, false]) {
      const label = `${runsSandboxed ? "sandboxed" : "unsandboxed"}, ${saved ? "saved allow present" : "no saved allow"}`;
      expect.soft(check(fixture.command, fixture.dialect, runsSandboxed), label).toMatchObject({
        decision: "ask", layer: 2, forceModal: true,
      });
    }
    // The caller may turn a human-only ask into a headless denial; it may never
    // turn that ask into an allow because an exact or broad grant was loaded.
    for (const runsSandboxed of [true, false]) {
      expect.soft(check(fixture.command, fixture.dialect, runsSandboxed, true).decision, "headless execution").not.toBe("allow");
    }
  }
}

describe("encoded launcher approvals", () => {
  it.each(ENCODED_CASES)("$name", (fixture) => requireHiddenFloor(fixture, DESTRUCTIVE_SCRIPT));
});

describe("composed encoded launcher approvals", () => {
  it.each(COMPOSED_CASES)("$name", (fixture) => requireHiddenFloor(fixture, fixture.decodedScript ?? DESTRUCTIVE_SCRIPT));
});

describe.each(["bash", "powershell"] as const)("UTF-16LE data positions (%s)", (dialect) => {
  it.each(UTF16_DATA_CASES)("forces a modal for $name", (fixture) => {
    requireHiddenFloor({ ...fixture, dialect }, fixture.decodedScript);
  });
});

describe("unresolved encoded operands", () => {
  it.each(UNRESOLVED_OPERAND_CASES)("$name", (fixture) => requireHiddenFloor(fixture, null));
});

describe("stdin interpreter pipelines", () => {
  it.each(PIPELINE_CASES)("$name", (fixture) => requireHiddenFloor(fixture, null));
});

describe("scan bounds and nested code approvals", () => {
  // When a work bound stops decoding, hidden + layer 2 remains mandatory;
  // undiscovered text is not asserted. Disclosure cases above stay within the
  // text byte/depth bounds and must show the executed terminal script itself.
  it.each(BOUNDED_AND_NESTED_CASES)("$name", (fixture) => requireHiddenFloor(fixture, fixture.decodedScript ?? null));
});

// Literal file execution is opaque code outside encoded-token inspection.
// The on-disk text remains inert and is removed by afterEach. Its encoding
// must not change the mainline policy outcome or create an exact-rule offer.
describe.each(["bash", "powershell"] as const)("literal file-execution parity (%s)", (dialect) => {
  it.each(FILE_COMMANDS)("preserves the baseline for $name", ({ command }) => {
    const file = join(cwd, "x.ps1");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DESTRUCTIVE_SCRIPT, "utf16le")]));
    expect(readFileSync(file).toString("utf16le")).toBe(`\uFEFF${DESTRUCTIVE_SCRIPT}`);
    for (const runsSandboxed of [true, false]) {
      const result = check(command, dialect, runsSandboxed);
      const expected = runsSandboxed ? FILE_EXECUTION_BASELINE.sandboxed : FILE_EXECUTION_BASELINE.unsandboxed;
      expect.soft({ decision: result.decision, layer: result.layer }).toEqual(expected);
      expect.soft(result.forceModal ?? false).toBe(false);
    }
    const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID);
    expect.soft(card.exactRule, "the exact-rule offer must preserve the baseline").toBe(FILE_EXECUTION_BASELINE.exactRule);
    expect.soft(card.sessionAllowed).toBe(false);
    expect.soft(card.persistentAllowed).toBe(false);
    expect.soft(card.decodedCommands ?? []).toEqual([]);
  });
});

describe.each(["bash", "powershell"] as const)("ASCII-unit payload threshold (%s)", (dialect) => {
  it.each(ASCII_THRESHOLD_CASES)("classifies $name", ({ name, script, qualifies }) => {
    expect.soft(meetsEncodedTextCriterion(script), "the fixture's declared boundary").toBe(qualifies);
    const command = `printf %s ${encodeScript(script)}`;
    if (qualifies) requireHiddenFloor({ name, dialect, command, allowBody: command }, script);
    else requireLiteralBehavior(command, dialect);
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
  // These UTF-8 bytes form non-ASCII UTF-16LE units and fail the 90% criterion.
  { name: "longer UTF-8 Base64 passed as ordinary data", command: `printf %s ${LONG_UTF8_DATA}` },
  { name: "a commit message containing UTF-8 Base64 text", command: `git commit -m 'snapshot ${LONG_UTF8_DATA}'` },
  { name: "a wrapper passing plain literal text as data", command: "env printf %s 'record fixture changes'" },
  { name: "an encoded-looking flag passed as print data", command: "printf %s -enc 'not-base64!'" },
  { name: "a slash encoded-looking flag passed as print data", command: "printf %s /enc 'not-base64!'" },
  { name: "a dash-like encoded-looking flag passed as print data", command: "printf %s \u2013enc 'not-base64!'" },
  { name: "an inline option of a script runtime", command: "node -e 'x'", sandboxedOrdinaryAskAllowed: true },
  { name: "an inline option of another script runtime", command: "perl -e 'x'", sandboxedOrdinaryAskAllowed: true },
  { name: "a search pattern option", command: "grep -e foo" },
  { name: "a text substitution option", command: "sed -e s/a/b/" },
  // A substring match or a directory component does not meet the basename
  // starts-with requirement, even when the encoded-looking flag follows it.
  { name: "a data basename containing but not starting with a shell name", command: "printf %s notpwsh -enc 'not-base64!'" },
  { name: "a shell name only in a data path's directory component", command: "printf %s pwsh-tools/marker -enc 'not-base64!'" },
  { name: "a matching name confined to an earlier command", command: "printf pwsh; printf %s -enc 'not-base64!'" },
  { name: "a matching name appearing after the encoded-looking flag", command: "printf %s -enc 'not-base64!' pwsh" },
] as const;

function requireLiteralBehavior(command: string, dialect: ShellRuleDialect, sandboxedOrdinaryAskAllowed = false): void {
  const inspection = inspectEncodedPowerShell(command, dialect, cwd);
  const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, SESSION_ID);
  expect.soft(inspection).toEqual({ scripts: [], hidden: false });
  expect.soft(card.decodedCommands ?? []).toEqual([]);
  const sandboxed = check(command, dialect, true);
  // Inline interpreter code may retain its ordinary opaque-code ask. That
  // existing policy must not be confused with an encoded-code forced modal.
  if (sandboxedOrdinaryAskAllowed) {
    expect.soft([
      { decision: "allow", layer: 3 },
      { decision: "ask", layer: 6 },
    ]).toContainEqual({ decision: sandboxed.decision, layer: sandboxed.layer });
  } else expect.soft(sandboxed).toMatchObject({ decision: "allow", layer: 3 });
  expect.soft(sandboxed.forceModal).not.toBe(true);
  // Without an exact allow, the plain-shell policy still asks normally.
  const unsandboxed = check(command, dialect, false);
  expect.soft(unsandboxed).toMatchObject({ decision: "ask", layer: 6 });
  expect.soft(unsandboxed.forceModal).not.toBe(true);
}

describe.each(["bash", "powershell"] as const)("literal argument handling (%s)", (dialect) => {
  it.each(LITERAL_COMMANDS)("does not force a modal for $name", (fixture) => {
    requireLiteralBehavior(fixture.command, dialect, "sandboxedOrdinaryAskAllowed" in fixture && fixture.sandboxedOrdinaryAskAllowed);
  });
});

const NON_LITERAL_CASES = [
  { name: "a here-string argument", command: "Write-Output @'\nready\n'@" },
  { name: "stop-parsing arguments", command: "cmd --% /c echo ready" },
  { name: "a native command-variable expansion", command: "cmd /c echo %GREETING%" },
] as const;

describe("non-literal argument rule proposals", () => {
  it.each(NON_LITERAL_CASES)("does not propose an exact rule for $name", ({ command }) => {
    const card = buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }, SESSION_ID);
    expect.soft(card.exactRule).toBeNull();
    expect.soft(card.sessionAllowed).toBe(false);
    expect.soft(card.persistentAllowed).toBe(false);
    // These ordinary opaque arguments do not mint an exact rule. Preserve
    // either ordinary sandboxed outcome; without a sandbox they must ask.
    const sandboxed = check(command, "powershell", true);
    expect.soft([
      { decision: "allow", layer: 3 },
      { decision: "ask", layer: 6 },
    ]).toContainEqual({ decision: sandboxed.decision, layer: sandboxed.layer });
    expect.soft(sandboxed.forceModal).not.toBe(true);
    const unsandboxed = check(command, "powershell", false);
    expect.soft(unsandboxed).toMatchObject({ decision: "ask", layer: 6 });
    expect.soft(unsandboxed.forceModal).not.toBe(true);
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
    // A hidden-code modal must not replace a matching denial. Exercise each
    // scope combination with ordinary and encoded input, including headless.
    // Encoded project-deny checks include a legacy tool-allow snapshot;
    // encoded global-deny checks compare denial with the hidden-code floor.
    // Neither requires a save API to accept a fresh encoded allow rule.
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
