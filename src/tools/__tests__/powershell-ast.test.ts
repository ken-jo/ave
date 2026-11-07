import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePowerShellAstSummary, type PowerShellArgument, type PowerShellAstSummary } from "../powershell-ast.js";
import { findPowerShellAstPathViolation, validatePowerShellAst } from "../shell-tools.js";
import { powerShellLiteral as literal } from "../../__tests__/support/powershell-ast.js";

const command = (name: string, args: PowerShellArgument[] = []): PowerShellAstSummary => ({
  errors: [], unsupported: [], redirections: [], commands: [{ name, text: name, arguments: [literal(name), ...args] }],
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function check(summary: PowerShellAstSummary) {
  const root = mkdtempSync(join(tmpdir(), "ave-ps-facts-")); roots.push(root);
  return findPowerShellAstPathViolation(summary, root, root, [], true);
}

describe("native PowerShell AST facts", () => {
  it("keeps detached process invocation structurally denied even with a literal read body", () => {
    expect(validatePowerShellAst(command("Start-Process", [literal("pwsh"),
      { kind: "parameter", name: "ArgumentList", text: "-ArgumentList", argument: literal("-c Get-Content /outside/notes.txt") },
    ]))).toContain("process detachment is not allowed");
  });

  it.skipIf(process.platform !== "win32")("refuses a content argument with ambiguous junction parents", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-ps-facts-")); roots.push(root);
    const target = join(root, "a", "b");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, "link"), "junction");
    expect(findPowerShellAstPathViolation(command("Get-Content", [literal("link/../../ordinary.txt")]), root, root, [], true))
      .toMatchObject({ kind: "invalid-path" });
  });

  it("uses native literal values instead of re-expanding dollar or percent source", () => {
    const summary = command("Set-Content", [literal("$HOME/file.txt", "'$HOME/file.txt'"), literal("%CD%")]);
    expect(check(normalizePowerShellAstSummary(summary))).toBeNull();
  });

  it("checks actual dynamic arguments without guessing their expanded path", () => {
    expect(check(command("Set-Content", [{ kind: "dynamic", text: '"$HOME/file.txt"' }, literal("data")]))?.reason).toContain("dynamic path argument");
  });

  it("checks redirect values independently of a data-only command", () => {
    expect(check({ ...command("Write-Output", [literal("../outside")]), redirections: [literal("../outside/result")] })?.kind).toBe("sandbox-boundary");
    expect(check(command("Write-Output", [literal("../outside")]))).toBeNull();
  });

  it("preserves named literal-path semantics and attached flag values", () => {
    expect(check(command("Get-Content", [{ kind: "parameter", name: "LiteralPath", text: "-LiteralPath", argument: { kind: "literal", text: "'[x].txt'", value: "[x].txt" } }]))).toBeNull();
    const summary = command("Remove-Item", [literal("./safe"),
      { kind: "parameter", name: "Recurse", text: "-Recurse:$false", argument: { kind: "literal", text: "$false", value: "false" } },
      { kind: "parameter", name: "Force", text: "-Force" },
    ]);
    expect(validatePowerShellAst(summary)).toBeNull();
  });

  it.each([
    command("Invoke-WebRequest", [literal("https://example.com/a?b=1")]),
    command("Invoke-WebRequest", [{ kind: "parameter", name: "Uri", text: "-Uri", argument: literal("https://example.com/") }]),
    command("Invoke-RestMethod", [literal("https://example.com/", "'https://example.com/'")]),
    command("curl.exe", [literal("-sS"), literal("https://example.com:8443/x")]),
  ])("leaves a network URL operand to the egress proxy instead of the path policy %#", (summary) => {
    expect(check(summary)).toBeNull();
  });

  it("keeps path checks for a curl output path next to a URL", () => {
    expect(check(command("curl.exe", [literal("-o"), literal("../outside/x"), literal("https://example.com/")]))?.kind).toBe("sandbox-boundary");
  });

  it.each([
    command("curl.exe", [literal("-o"), literal("https://x/../../../escaped")]),
    command("curl.exe", [literal("-o"), literal("https://x?/../../../escaped")]),
    command("curl.exe", [literal("-o"), literal("FTP://x/x./../../../../escaped")]),
    command("Invoke-WebRequest", [{ kind: "parameter", name: "OutFile", text: "-OutFile", argument: literal("https://x/../../../escaped") }]),
    command("tar.exe", [literal("-xf"), literal("https://x/../../../a.tar")]),
  ])("path-checks a URL-shaped operand that resolves outside the working directory %#", (summary) => {
    expect(check(summary)).not.toBeNull();
  });

  it.skipIf(process.platform !== "win32").each(["https://x/NUL", "https://x/com1.txt", "https://x/conin$"])(
    "path-checks %s, a DOS device name Win32 maps out of the path", (operand) => {
      expect(check(command("curl.exe", [literal("-o"), literal(operand)]))).not.toBeNull();
    },
  );

  it.skipIf(process.platform !== "win32").each(["https://x/..\\..\\..\\secret", "https://x/a\\..\\..\\escaped"])(
    "path-checks %s, whose backslashes Win32 reads as separators", (operand) => {
      expect(check(command("curl.exe", [literal("-T"), literal(operand)]))).not.toBeNull();
    },
  );

  it("keeps URL-shaped operands of filesystem cmdlets and redirects as paths", () => {
    const escaping = "https://x/../../../outside";
    expect(check(command("Copy-Item", [literal("./safe"), literal(escaping)]))).not.toBeNull();
    expect(check({ ...command("Invoke-WebRequest", [literal("https://example.com/")]), redirections: [literal(escaping)] })).not.toBeNull();
  });

  it.skipIf(process.platform !== "win32").each(["file:///C:/Windows/win.ini", "file://server/share/x", "\\\\server\\share\\x", "https:///no-authority"])(
    "still path-checks %s", (operand) => {
      expect(check(command("Invoke-WebRequest", [literal(operand)]))).not.toBeNull();
    },
  );

  it("does not treat an additional New-Item path as content data", () => {
    expect(check(command("New-Item", [literal("./safe"), literal("../outside/result")]))?.kind).toBe("sandbox-boundary");
  });

  it.each([
    {}, { errors: [], commands: [] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "literal", text: "x" }] }] },
    { ...command("Get-Content"), redirections: [null] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "parameter", text: "-Path", name: "Path", argument: { kind: "parameter", text: "-x", name: "x" } }] }] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "literal", text: "x", value: "x", start: 3 }] }] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "literal", text: "x", value: "x", start: 4, end: 3 }] }] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "literal", text: "x", value: "x", start: -1, end: 0 }] }] },
  ])("rejects malformed native summary %j", (raw) => {
    expect(() => normalizePowerShellAstSummary(raw)).toThrow("PowerShell AST");
  });

  it("keeps parser element offsets", () => {
    const raw = command("Get-Content", [{ kind: "parameter", name: "Path", text: "-Path:x", start: 12, end: 19,
      argument: { kind: "literal", text: "x", value: "x", start: 18, end: 19 } }]);
    expect(normalizePowerShellAstSummary(raw).commands[0]!.arguments[1]).toEqual(raw.commands[0]!.arguments[1]);
  });
});
