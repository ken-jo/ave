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
  function requireUnproven(command: string): void {
    expect((dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command)).proven).toBe(false);
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    const pattern = canonicalRuleSpecifier(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
    manager.setRules([{ pattern, action: "allow" }]);
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

  it("follows existing transparent wrappers within the input bound", () => {
    requireUnproven(`${"env ".repeat(17)}pwsh -File - -enc ${PAYLOAD}`);
  });

  it("retains literal non-e arguments without reading their nested program text", () => {
    const command = "pwsh -Command 'Write-Output ready'";
    expect((dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command)).proven).toBe(true);
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["sh", "-c", "pwsh -enc literal"])).toBeNull();
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
