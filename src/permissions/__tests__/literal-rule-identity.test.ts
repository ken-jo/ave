import "../../__tests__/support/trusted-powershell.js";
import { describe, expect, it } from "vitest";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { canonicalRuleSpecifier, parseRuleSpecifier } from "../rules/rule-specifier.js";
import { evaluatePowerShellSubject, evaluateShellSubject } from "../rules/rule-scopes.js";
import { canonicalPowerShellName } from "../rules/powershell-command-policy.js";
import { inspectPowerShellCommand, proveLiteralPowerShell } from "../rules/powershell-exfiltration.js";
import { encodedPowerShellExecutionReason } from "../rules/powershell-encoded-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";

const CWD = "/work/project";
// #223 executable-bound startup admission: literal identity does not prove win32 startup.
const UNPROVEN_STARTUP = process.platform === "win32";
function powerShellAllow(pattern: string, command: string): string | null {
  return evaluatePowerShellSubject({ command, exactAllowOnly: true, floorSignal: null }, [
    withCurrentShellRuleVersion({ pattern: canonicalRuleSpecifier(pattern), action: "allow" }),
    { pattern: "PowerShell(unrelated *)", action: "deny" },
  ]).decision;
}

describe("literal rule semantic identity", () => {
  it.each(["|", "&", "(", "*", "-eq", "--%"])("keeps quoted PowerShell data distinct from bare %s syntax", (value) => {
    const command = `Write-Output '${value}'`;
    const pattern = canonicalRuleSpecifier(`PowerShell(${command})`);
    expect(powerShellAllow(pattern, command)).toBe(UNPROVEN_STARTUP ? null : "allow");
    expect(powerShellAllow(pattern, `Write-Output ${value}`)).not.toBe("allow");
    expect(canonicalRuleSpecifier(pattern)).toBe(pattern);
  });

  it.each([
    ["Get-ChildItem", true],
    ["Microsoft.PowerShell.Management\\Get-ChildItem", true],
    ["custom-function", false],
    ["Custom.Module\\custom-function", false],
  ] as const)("retains quoted parameter roles for %s", (head, knownGrammar) => {
    for (const parameter of ["-Force", "–Force", "—Force", "―Force"]) {
      const knownBareParameter = knownGrammar && parameter === "-Force";
      const quoted = `${head} '${parameter}'`;
      const bare = `${head} ${parameter}`;
      const quotedRule = `PowerShell(${quoted})`;
      const bareRule = `PowerShell(${bare})`;
      expect(canonicalRuleSpecifier(quotedRule)).toBe(quotedRule);
      expect(canonicalRuleSpecifier(bareRule)).toBe(bareRule);
      expect(quotedRule).not.toBe(bareRule);
      expect(parseRuleSpecifier(quotedRule)).toMatchObject({ tokens: [expect.any(String), `'${parameter}'`] });
      expect(powerShellAllow(quotedRule, quoted)).toBe(knownGrammar ? UNPROVEN_STARTUP ? null : "allow" : "ask");
      expect(powerShellAllow(quotedRule, bare)).not.toBe("allow");
      expect(powerShellAllow(bareRule, bare)).toBe(knownBareParameter ? UNPROVEN_STARTUP ? null : "allow" : "ask");
      expect(powerShellAllow(bareRule, quoted)).not.toBe("allow");
      expect(buildShellRuleApproval("powershell", quoted, CWD, { allow: true, deny: true }).exactRule).toBe(knownGrammar && !UNPROVEN_STARTUP ? quotedRule : null);
    }
  });

  it("keeps module and bare program tokens distinct", () => {
    const qualified = "Microsoft.PowerShell.Utility\\Invoke-Expression 'Get-Date'";
    const bare = "Invoke-Expression 'Get-Date'";
    expect(canonicalRuleSpecifier(`PowerShell(${qualified})`)).not.toBe(canonicalRuleSpecifier(`PowerShell(${bare})`));
    expect(powerShellAllow(`PowerShell(${qualified})`, bare)).not.toBe("allow");
    expect(powerShellAllow(`PowerShell(${bare})`, qualified)).not.toBe("allow");
  });

  it.each(["Microsoft.PowerShell.Management\\Get-ChildItem", "Vendor.Module\\Get-ChildItem"])("shares module leaf normalization with retained visible floors: %s", (command) => {
    expect(canonicalPowerShellName(command)).toBe("get-childitem");
    expect(inspectPowerShellCommand(`${command} ~/.ssh/id_rsa`, CWD).sensitive).not.toBeNull();
  });

  it.each(["pwsh", "pwsh-preview", "powershell", "powershell_ise"])("keeps encoded execution excluded for qualified %s", (name) => {
    for (const head of [name, `${name}.exe`, `Vendor.Module\\${name.toUpperCase()}.EXE`, `C:\\tools\\${name.toUpperCase()}.EXE`]) {
      expect(encodedPowerShellExecutionReason([head, "-EncodedCommand", "literal"])).not.toBeNull();
      expect(proveLiteralPowerShell(`${head} -EncodedCommand literal`).proven).toBe(false);
      expect(powerShellAllow(`PowerShell(${head} -EncodedCommand literal)`, `${head} -EncodedCommand literal`)).not.toBe("allow");
    }
  });

  it("conservatively reads launcher and encoded words across literal arguments", () => {
    expect(encodedPowerShellExecutionReason(["env", "pwsh", "-enc", "literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["env", "-S", "pwsh -enc literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["bash", "-c", "pwsh -enc literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["printf", "pwsh", "-enc", "literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh", "-Command", "pwsh -enc literal"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh", "-WorkingDirectory", "-enc", "literal"])).not.toBeNull();
    const wrappers = Array<string>(17).fill("env");
    expect(encodedPowerShellExecutionReason([...wrappers, "pwsh", "-enc", "literal"])).not.toBeNull();
    expect(proveLiteralPowerShell(`${wrappers.join(" ")} pwsh -enc literal`).proven).toBe(false);
    expect(encodedPowerShellExecutionReason([...wrappers, "printf", "ready"])).toBeNull();
  });

  it.each(["npm exec --call='printf ready'", "fish --command='printf ready'", "custom-function 'x'-Force", "custom-function 'x'+word", "custom-function 'x'=word", "Write-Output 'x'-NoEnumerate"])("refuses mixed quoting without complete argv proof: %s", (command) => {
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("powershell", command, CWD, { allow: true, deny: true }).exactRule).toBeNull();
    expect(powerShellAllow(`PowerShell(${command})`, command)).not.toBe("allow");
  });

  it.each(["*", "$x"])("keeps quoted POSIX data distinct from bare %s syntax", (value) => {
    const pattern = canonicalRuleSpecifier(`Bash(printf '${value}')`);
    expect(evaluateShellSubject({ command: `printf '${value}'`, exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern, action: "allow" })]).decision).toBe("allow");
    expect(evaluateShellSubject({ command: `printf ${value}`, exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern, action: "allow" })]).decision).not.toBe("allow");
    const spec = parseRuleSpecifier(pattern);
    expect(spec).toMatchObject({ tokens: ["printf", `'${value}'`], wildcard: false });
    if (value === "*") expect(evaluateShellSubject({ command: "printf '*'", exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern: "Bash(printf *)", action: "allow" })]).decision).not.toBe("allow");
    else expect(() => parseRuleSpecifier(`Bash(printf ${value})`)).toThrow();
  });
});
