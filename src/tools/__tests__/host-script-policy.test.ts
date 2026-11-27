import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { windowsPathKindHelperIn } from "../../main/windows-path-kind-launcher.js";
import { checkWindowsWorkbookAccess, hostScriptInvocationReadPaths, hostScriptRuntimePaths, isVerifiedHostScript } from "../../main/host-script-runtime.js";
import * as windowsPathFacts from "../../shared/windows-path-facts.js";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";
import { findPowerShellAstPathViolation, powerShellHostScriptReadPaths } from "../shell-tools.js";
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
  // Windows path admission runs the shipped path-kind helper from the configured resources.
  if (process.platform === "win32") {
    mkdirSync(dirname(windowsPathKindHelperIn(resources)), { recursive: true });
    copyFileSync(windowsPathKindHelperIn(join(process.cwd(), "resources")), windowsPathKindHelperIn(resources));
  }
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
function firstCommand(summary: PowerShellAstSummary) {
  const [command] = summary.commands;
  if (!command) throw new Error("Expected a PowerShell command");
  return command;
}
const powershellSource = (summary: PowerShellAstSummary) => `$env:ELECTRON_RUN_AS_NODE='1'; ${firstCommand(summary).text}`;

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

  it("grants the main runtime/script paths for literal workbook commands", () => {
    const workbookScript = join(root, "resources", "skill-scripts", "edit-xlsx.cjs");
    const source = "console.log('ready');\n";
    const digest = createHash("sha256").update(source).digest("hex");
    writeFileSync(workbookScript, source);
    writeFileSync(join(root, "resources", "skill-scripts", "manifest.json"), JSON.stringify({ version: 1,
      scripts: { "command.cjs": digest, "edit-xlsx.cjs": digest } }));
    const runtime = realpathSync.native(process.execPath);
    const requests = [process.execPath, workbookScript, join(workspace, "book.xlsx"), join(workspace, "edits.json")];
    const expected = [...new Set([process.execPath, runtime, dirname(runtime), workbookScript])];
    const summary: PowerShellAstSummary = { errors: [], redirections: [], unsupported: [], commands: [{
      name: process.execPath, text: "literal runtime command",
      arguments: requests.map(value => ({ kind: "literal", text: value, value })),
    }] };
    expect.soft(powerShellHostScriptReadPaths(summary, powershellSource(summary))).toEqual(expected);
    if (process.platform === "win32") {
      const invocation = firstCommand(summary);
      const request = invocation.arguments[3];
      if (!request) throw new Error("Expected a workbook edit request");
      const dynamic = { ...summary, commands: [{ ...invocation, arguments: [
        ...invocation.arguments.slice(0, 2), { kind: "dynamic" as const, text: "$workbook" }, request,
      ] }] };
      expect.soft(powerShellHostScriptReadPaths(dynamic, powershellSource(dynamic))).toEqual([]);
      const bashCommand = `ELECTRON_RUN_AS_NODE=1 ${requests.map(shellQuote).join(" ")}`;
      expect(collectShellExecutableReadPaths(bashCommand, workspace, { dialect: "bash", environment: {} })).not.toContain(workbookScript);
      expect(violation(bashCommand)?.reason).toContain("[workbook-acl-unreadable]");
    }
    try {
      vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
      expect(hostScriptInvocationReadPaths(requests, { ELECTRON_RUN_AS_NODE: "1" })).toEqual(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps workbook operands and redirections inside the admitted write roots", () => {
    expect(violation(command(join(root, "outside.xlsx"), join(workspace, "edits.json")))?.kind).toBe("sandbox-boundary");
    expect(violation(`${command(join(workspace, "book.xlsx"), join(workspace, "edits.json"))} > ${shellQuote(join(root, "outside.txt"))}`)?.kind).toBe("sandbox-boundary");
    const summary = ast(join(root, "outside.xlsx"));
    expect(findPowerShellAstPathViolation(summary, workspace, workspace, [], true, powershellSource(summary))?.kind).toBe("sandbox-boundary");
  });

  it.skipIf(process.platform !== "win32")("binds workbook approval to the descriptor from the pinned leaf", () => {
    const workbook = join(workspace, "book.xlsx");
    writeFileSync(workbook, "workbook fixture");
    const stats = lstatSync(workbook, { bigint: true });
    const access = vi.spyOn(windowsPathFacts, "readWindowsDacls");
    const separate = vi.spyOn(windowsPathFacts, "readWindowsFileDacls");
    try {
      const decision = checkWindowsWorkbookAccess(workbook);
      expect(decision).toHaveProperty("identity");
      if (!("identity" in decision)) throw new Error(decision.reason);
      const [device, inode, change] = decision.identity.split(":").map(value => BigInt(value));
      expect(device).toBe(stats.dev);
      expect(inode).toBe(stats.ino);
      if (change === undefined) throw new Error("Workbook identity has no change time");
      expect((change - 116444736000000000n) * 100n).toBe(stats.ctimeNs);
      expect(access).toHaveBeenCalledExactlyOnceWith([workbook], { parent: true, access: true });
      expect(separate).not.toHaveBeenCalled();
    } finally {
      access.mockRestore();
      separate.mockRestore();
    }
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
    for (const source of [firstCommand(summary).text, powershellSource(summary).replace("='1'", "='0'"),
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
