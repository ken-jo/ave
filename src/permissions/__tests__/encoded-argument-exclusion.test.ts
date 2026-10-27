import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { decodePowerShellEncodedCommands, encodedPowerShellExecutionReason } from "../rules/powershell-encoded-command.js";
import { canonicalRuleSpecifier } from "../rules/rule-specifier.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { proveLiteralPowerShell } from "../rules/powershell-exfiltration.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "../rules/shell-prefix-values.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";

const SCRIPT = "Write-Output PROBE_OK";
const PAYLOAD = Buffer.from(SCRIPT, "utf16le").toString("base64");
const LAUNCHERS = ["pwsh", "pwsh-preview", "powershell", "powershell_ise"] as const;
const EXCLUDED_TAILS = [
  `' -enc ' ${PAYLOAD}`,
  `-File - -enc ${PAYLOAD}`,
  `-f - -ec ${PAYLOAD}`,
  `/fi - /enc ${PAYLOAD}`,
  `-- -enc ${PAYLOAD}`,
  `-Command ready -EncodedArguments ${PAYLOAD}`,
  `-ea ${PAYLOAD}`,
  "-ExecutionPolicy Bypass -Command ready",
  "-Command echo",
  "example",
  "-enc",
] as const;

let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "encoded-argument-"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe.each(["bash", "powershell"] as const)("conservative launcher argument exclusion (%s)", (dialect) => {
  function requireUnproven(command: string, rememberedCommands: readonly string[] = [command]): void {
    expect((dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command)).proven).toBe(false);
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules(rememberedCommands.map((remembered) => withCurrentShellRuleVersion({
      pattern: canonicalRuleSpecifier(`${dialect === "bash" ? "Bash" : "PowerShell"}(${remembered})`), action: "allow" as const,
    })));
    const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd }, shellExecution: { runsSandboxed: false } };
    expect(manager.checkDetailed(dialect, "builtin", "shell", null, context).decision).toBe("ask");
    expect(manager.checkDetailed(dialect, "builtin", "shell", null, { ...context, headless: true }).decision).toBe("deny");
  }

  it.each(EXCLUDED_TAILS)("refuses every e-leading explicit argument: %s", (tail) => requireUnproven(`pwsh ${tail}`));

  it.each(["-", "/", "–", "—", "―", "--", "//", "-/–—―/"])("strips all leading dash and slash characters: %s", (prefix) => {
    requireUnproven(`pwsh '${prefix}EnCoDeDCommand' ${PAYLOAD}`);
    requireUnproven(`pwsh ' \t${prefix}eC \t' ${PAYLOAD}`);
  });

  it.each(LAUNCHERS)("uses only the exact launcher name %s", (launcher) => {
    for (const head of [launcher, `${launcher}.exe`, `${launcher.toUpperCase()}.EXE`]) requireUnproven(`${head} -enc ${PAYLOAD}`);
  });

  it("finds launcher words after arbitrary literal prefixes", () => {
    requireUnproven(`${"env ".repeat(17)}pwsh -File - -enc ${PAYLOAD}`);
  });

  it.each([
    "cmd /c", "env cmd /c", "cmd /c start /b", "nohup timeout 2", "custom-prefix --unknown",
  ])("excludes a launcher following %s", (prefix) => {
    requireUnproven(`${prefix} pwsh -enc ${PAYLOAD}`);
    requireUnproven(`${prefix} 'pwsh -enc ${PAYLOAD}'`);
  });

  it.each([
    `cmd /c 'cmd /c "pwsh -enc ${PAYLOAD}"'`,
    `cmd /c '"pwsh" "-enc" ${PAYLOAD}'`,
    `cmd /c 'ready;pwsh -enc ${PAYLOAD}'`,
    `cmd /c 'ready|pwsh -enc ${PAYLOAD}'`,
    `cmd /c 'C:\\Program Files\\PowerShell\\7\\PWSH.EXE -enc ${PAYLOAD}'`,
    `cmd /c 'Vendor.Module\\PWSH.EXE -enc ${PAYLOAD}'`,
  ])("scans nested literal command text once: %s", (command) => requireUnproven(command));

  it.each([
    `fish --command='pwsh -enc ${PAYLOAD}'`,
    `fish --init-command='pwsh -enc ${PAYLOAD}' -c exit`,
    `npm exec --call='pwsh -enc ${PAYLOAD}'`,
    'cmd /c"pwsh -enc %PAYLOAD%"',
  ])("retains launcher boundaries in attached quoted words: %s", (command) => {
    if (dialect === "bash") requireUnproven(command);
    else {
      expect(proveLiteralPowerShell(command).proven).toBe(false);
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    }
  });

  it("excludes launcher words in a pipeline's literal stages", () => {
    const first = `cmd /c 'pwsh -enc ${PAYLOAD}'`;
    requireUnproven(`${first} | printf ready`, [first, "printf ready"]);
    const second = `pwsh -enc ${PAYLOAD}`;
    requireUnproven(`printf ready | ${second}`, ["printf ready", second]);
  });

  it.each(["|", ";"])("retains launcher exclusion across the %s command boundary", (separator) => {
    const first = "printf pwsh";
    const second = `printf -enc ${PAYLOAD}`;
    requireUnproven(`${first} ${separator} ${second}`, [first, second]);
  });

  it("separates non-encoded option detection from nested startup proof", () => {
    const command = "pwsh -Command 'Write-Output ready'";
    expect(encodedPowerShellExecutionReason(["pwsh", "-Command", "Write-Output ready"])).toBeNull();
    expect((dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command)).proven).toBe(false);
    const pattern = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule;
    expect(pattern).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`, action: "allow" as const })]);
    const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd }, shellExecution: { runsSandboxed: false }, headless: true };
    expect(manager.checkDetailed(dialect, "builtin", "shell", null, context)).toMatchObject({ decision: "deny", layer: 2 });
    expect(encodedPowerShellExecutionReason(["sh", "-c", "pwsh -enc literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["printf", "data", "pwsh", "-enc", PAYLOAD])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh-custom", "-enc", PAYLOAD])).toBeNull();
  });
});

describe("bounded literal proof and display disclosure", () => {
  it("caps reusable literal commands at two thousand characters", () => {
    expect(MAX_LITERAL_COMMAND_LENGTH).toBe(2_000);
    const command = `printf ${"x".repeat(2_000)}`;
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(proveLiteralPowerShell(command).proven).toBe(false);
  });

  it("does not confuse conservative e-prefix exclusion with encoded display evidence", () => {
    expect(encodedPowerShellExecutionReason(["pwsh", "-ExecutionPolicy", PAYLOAD])).not.toBeNull();
    expect(decodePowerShellEncodedCommands(`pwsh -ExecutionPolicy ${PAYLOAD}`, "powershell")).toEqual([]);
    expect(decodePowerShellEncodedCommands(`pwsh example ${PAYLOAD}`, "powershell")).toEqual([]);
    expect(decodePowerShellEncodedCommands(`pwsh -enc ${PAYLOAD}`, "powershell")).toEqual([SCRIPT]);
  });
});
