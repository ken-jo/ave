import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { hostScriptInvocationReadPaths, hostScriptRuntimePaths, isVerifiedHostScript } from "../../main/host-script-runtime.js";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";
import { findPowerShellAstPathViolation } from "../shell-tools.js";
import { collectShellExecutableReadPaths } from "../shell-executable-read-paths.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import type { PowerShellAstSummary } from "../powershell-ast.js";

let root: string;
let workspace: string;
let script: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-script-policy-")));
  workspace = join(root, "project");
  mkdirSync(workspace);
  const resources = join(root, "resources");
  mkdirSync(join(resources, "skill-scripts"), { recursive: true });
  script = join(resources, "skill-scripts", "command.cjs");
  writeFileSync(script, "console.log('ready');\n");
  writeFileSync(join(resources, "skill-scripts", "manifest.json"), JSON.stringify({ version: 1,
    scripts: { "command.cjs": createHash("sha256").update(readFileSync(script)).digest("hex") } }));
  configureHostResources({ resourcePath: resources, isPackaged: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function command(...paths: string[]): string {
  return `ELECTRON_RUN_AS_NODE=1 ${[process.execPath, script, ...paths].map(shellQuote).join(" ")}`;
}
function violation(source: string) {
  return findShellPathPolicyViolation(source, workspace, workspace, [], true);
}
function ast(...paths: string[]): PowerShellAstSummary {
  return { errors: [], redirections: [], unsupported: [], commands: [{ name: process.execPath,
    text: "literal runtime command", arguments: [process.execPath, script, ...paths].map((value) => ({ kind: "literal", text: value, value })) }] };
}
const powershellSource = (summary: PowerShellAstSummary) => `$env:ELECTRON_RUN_AS_NODE='1'; ${summary.commands[0]!.text}`;

describe("host-owned script roles", () => {
  it("admits the exact runtime/script pair in both shell policy dialects", () => {
    const workbook = join(workspace, "book.xlsx");
    const request = join(workspace, "edits.json");
    expect(isVerifiedHostScript(script)).toBe(true);
    expect(violation(command(workbook, request))).toBeNull();
    const summary = ast(workbook, request);
    expect(findPowerShellAstPathViolation(summary, workspace, workspace, [], true, powershellSource(summary))).toBeNull();
    const paths = collectShellExecutableReadPaths(command(workbook, request), workspace, { dialect: "bash", environment: {} });
    expect(paths).toContain(process.execPath);
    expect(paths).toContain(script);
    expect(hostScriptRuntimePaths()?.javascriptRuntime).toBe(process.execPath);
  });

  it("keeps workbook operands and redirections inside the admitted write roots", () => {
    expect(violation(command(join(root, "outside.xlsx"), join(workspace, "edits.json")))?.kind).toBe("sandbox-boundary");
    expect(violation(`${command(join(workspace, "book.xlsx"), join(workspace, "edits.json"))} > ${shellQuote(join(root, "outside.txt"))}`)?.kind).toBe("sandbox-boundary");
    const summary = ast(join(root, "outside.xlsx"));
    expect(findPowerShellAstPathViolation(summary, workspace, workspace, [], true, powershellSource(summary))?.kind).toBe("sandbox-boundary");
  });

  it("never grants scripts write authority even inside a broader workspace", () => {
    expect(isSensitivePath(script, "write")).toBe("host-script-resources");
    expect(findShellPathPolicyViolation(`echo changed > ${shellQuote(script)}`, root, root, [], false)?.kind).toBe("sensitive-path");
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(root, "resources", "skill-scripts"));
  });

  it("refuses changed bytes, traversal spellings, links and arbitrary runtime aliases", () => {
    const bytes = readFileSync(script);
    writeFileSync(script, "modified");
    expect(isVerifiedHostScript(script)).toBe(false);
    expect(violation(command())?.kind).not.toBeUndefined();
    writeFileSync(script, bytes);
    const alias = join(workspace, process.platform === "win32" ? "runtime.exe" : "runtime");
    symlinkSync(process.execPath, alias);
    expect(hostScriptInvocationReadPaths([alias, script], { ELECTRON_RUN_AS_NODE: "1" })).toEqual([]);
    expect(isVerifiedHostScript(`${join(root, "resources", "skill-scripts")}/sub/../command.cjs`)).toBe(false);
    const linked = join(root, "resources", "skill-scripts", "linked.cjs");
    symlinkSync(script, linked);
    expect(isVerifiedHostScript(linked)).toBe(false);
    expect(violation([process.execPath, "--require", script].map(shellQuote).join(" "))).not.toBeNull();
    expect(violation(["sh", script].map(shellQuote).join(" "))?.kind).toBe("sensitive-path");
  });

  it("requires the exact runtime mode and refuses code-loading environment in both dialects", () => {
    const args = [process.execPath, script];
    expect(hostScriptInvocationReadPaths(args)).toEqual([]);
    expect(hostScriptInvocationReadPaths(args, { ELECTRON_RUN_AS_NODE: "0" })).toEqual([]);
    for (const variable of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      expect(violation(`${variable}=payload ${command()}`)).not.toBeNull();
      expect(collectShellExecutableReadPaths(`${variable}=payload ${command()}`, workspace,
        { dialect: "bash", environment: {} })).not.toContain(script);
    }
    expect(violation(command().replace("ELECTRON_RUN_AS_NODE=1 ", ""))).not.toBeNull();
    const summary = ast(join(workspace, "book.xlsx"), join(workspace, "edits.json"));
    for (const source of [summary.commands[0]!.text, powershellSource(summary).replace("='1'", "='0'"),
      `$env:NODE_OPTIONS='--require evil'; ${powershellSource(summary)}`]) {
      expect(findPowerShellAstPathViolation(summary, workspace, workspace, [], true, source)).not.toBeNull();
    }
  });

  it("advertises canonical resource paths through an aliased parent directory", () => {
    const alias = join(root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      configureHostResources({ resourcePath: join(alias, "resources"), isPackaged: true });
      expect(hostScriptRuntimePaths()?.bundledScriptsDirectory).toBe(realpathSync.native(join(root, "resources", "skill-scripts")));
      expect(violation(command(join(workspace, "book.xlsx"), join(workspace, "edits.json")))).toBeNull();
    } finally {
      if (process.platform === "win32") rmdirSync(alias);
      else unlinkSync(alias);
    }
  });

  it("pins both the resource directory identity and manifest against replacement", () => {
    expect(isVerifiedHostScript(script)).toBe(true);
    const directory = join(root, "resources", "skill-scripts");
    const manifest = join(directory, "manifest.json");
    const originalManifest = readFileSync(manifest);
    const originalScript = readFileSync(script);
    writeFileSync(script, "changed");
    writeFileSync(manifest, JSON.stringify({ version: 1, scripts: {
      "command.cjs": createHash("sha256").update("changed").digest("hex"),
    } }));
    expect(isVerifiedHostScript(script)).toBe(false);
    writeFileSync(script, originalScript);
    writeFileSync(manifest, originalManifest);
    expect(isVerifiedHostScript(script)).toBe(true);
    renameSync(directory, `${directory}-retired`);
    mkdirSync(directory);
    writeFileSync(script, originalScript);
    writeFileSync(manifest, originalManifest);
    expect(isVerifiedHostScript(script)).toBe(false);
  });
});
