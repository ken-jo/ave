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

// Summaries are synthetic: provider commands must never reach a real shell.
it.each([String.raw`HKCU:\Software\Foo`, String.raw`HKLM:\Software\Foo`, String.raw`Cert:\CurrentUser\My\fixture`,
  String.raw`WSMan:\localhost\Client`, String.raw`Registry::HKEY_CURRENT_USER\Software\Foo`,
  "Env:fixture", "Function:fixture", "Variable:fixture"])("rejects provider target before filesystem resolution: %s", path => {
  expect(check(command("Remove-Item", [literal(path)]))).toMatchObject({ kind: "dynamic-path" });
});

// URL operands are not provider drives; the gate inspects every argument on every route.
it.each([
  ["iwr", command("iwr", [literal("https://example.com"), { kind: "parameter", name: "OutFile", text: "-OutFile", argument: literal("x.txt") }])],
  ["Invoke-WebRequest -Uri", command("Invoke-WebRequest", [{ kind: "parameter", name: "Uri", text: "-Uri", argument: literal("https://example.com/a") }])],
  ["git clone", command("git", [literal("clone"), literal("https://github.com/a/b")])],
  ["git+https", command("git", [literal("clone"), literal("git+https://github.com/a/b")])],
] as const)("allows a URL operand at the runtime gate: %s", (_name, summary) => {
  expect(check(summary)).toBeNull();
});

it.each([String.raw`HKCU:\Software\Foo`, "file:///C:/Users/example/.ssh/id_test"])("still refuses %s beside the URL exception", path => {
  expect(check(command("Remove-Item", [literal(path)]))).toMatchObject({ kind: "dynamic-path" });
});

it.each(["HKCU://Software/Foo", "cert://CurrentUser/My/ABC", "Temp://x", "Registry://HKEY_CURRENT_USER/Software/Foo"])("refuses non-network scheme %s as a provider path", path => {
  expect(check(command("Remove-Item", [literal(path)]))).toMatchObject({ kind: "dynamic-path" });
});

it.each([
  ["positional", command("Get-Content", [literal("C://Users/example/.ssh/id_rsa")])],
  ["-LiteralPath", command("Get-Content", [{ kind: "parameter", name: "LiteralPath", text: "-LiteralPath", argument: literal("C://Users/example/.ssh/id_rsa") }])],
] as const)("checks a drive path written with // as a filesystem path: %s", (_name, summary) => {
  expect(check(summary)).not.toBeNull();
});

it("allows an ssh URL operand", () => {
  expect(check(command("git", [literal("clone"), literal("ssh://git@example.com/a/b")]))).toBeNull();
});
