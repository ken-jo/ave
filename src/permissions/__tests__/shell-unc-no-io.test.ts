import "../../__tests__/support/trusted-powershell.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { canonicalizePathForMatch, createPathCanonicalizer } from "../sensitive-paths.js";
import { isWindowsNetworkOrDevicePath } from "../../shared/shell-native-path.js";
import { inspectPhysicalFilesystemPath, physicalParentReading, resolvePhysicalFilesystemPath, resolveShellFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { editDepthCandidates } from "../rules/scoped-rule-matcher.js";
import { captureReplayRootDigest } from "../reviewer/replay-root-binding.js";
import { projectRootFor, projectRulesLocation } from "../rules/project-rule-files.js";
import { getVendoredApplySeccompPath } from "../asrt-sandbox.js";

const probes = vi.hoisted(() => ({ calls: [] as { operation: string; path: string; unc: boolean; stack: string }[] }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrap = <T extends (...args: never[]) => unknown>(operation: string, original: T) => vi.fn((...args: Parameters<T>) => {
    const path = String(args[0]);
    const unc = path.startsWith("\\\\") || path.startsWith("//");
    probes.calls.push({ operation, path, unc, stack: new Error().stack ?? "" });
    // Observe attempted network opens without ever contacting the supplied host.
    if (unc) throw Object.assign(new Error("Network path intercepted by probe"), { code: "ENOENT" });
    return original(...args);
  });
  return { ...actual,
    realpathSync: Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) }),
    lstatSync: wrap("lstatSync", actual.lstatSync), statSync: wrap("statSync", actual.statSync),
    existsSync: wrap("existsSync", actual.existsSync), accessSync: wrap("accessSync", actual.accessSync),
    readdirSync: wrap("readdirSync", actual.readdirSync), openSync: wrap("openSync", actual.openSync),
  };
});

let directory: string;
let sequence = 0;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "ave-unc-no-io-")); mkdirSync(join(directory, "project")); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function check(dialect: "bash" | "powershell", command: string, headless = false) {
  const manager = new PermissionManager(join(directory, `${sequence++}.json`));
  manager.setMode("allow");
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd: join(directory, "project") },
    shellExecution: { runsSandboxed: false }, headless,
  });
}

describe("network operands before approval", () => {
  it.each([
    { dialect: "bash", command: "cp x //e/s" },
    { dialect: "bash", command: String.raw`cp x '\\e\s'` },
    { dialect: "bash", command: String.raw`cp x '\\?\UNC\e\s\out.txt'` },
    { dialect: "bash", command: String.raw`cp x '\\.\pipe\example'` },
    { dialect: "bash", command: String.raw`cp x '\\?\Volume{example}\out.txt'` },
    { dialect: "bash", command: String.raw`git -C '\\e\s' status` },
    { dialect: "bash", command: String.raw`git -C '\\e\s' -C sub status` },
    { dialect: "powershell", command: String.raw`Copy-Item x \\e\s` },
    { dialect: "powershell", command: String.raw`Copy-Item $env:APPDATA\Microsoft\Credentials\* \\e\share` },
  ] as const)("classifies $dialect $command without opening a share", ({ dialect, command }) => {
    probes.calls.length = 0;
    const result = check(dialect, command);
    const headless = check(dialect, command, true);
    const unc = probes.calls.filter(call => call.unc);
    console.info("UNC-SPY", JSON.stringify({ dialect, command, decision: result.decision, reasonCode: result.reasonCode, uncCalls: unc.length,
      sites: unc.map(call => ({ operation: call.operation, path: call.path, stack: call.stack })) }));
    if (process.platform === "win32" || dialect === "powershell") {
      expect(result).toMatchObject({ decision: "ask", reasonCode: "project-escape", forceModal: true,
        pipelineRequest: { floor: { code: "project-escape" } } });
      expect(headless).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
      expect(result.reviewer).toBeUndefined();
      expect(unc).toEqual([]);
    } else {
      // On this host, quoted backslashes name a local file; slash roots follow host rules.
      expect(result).toMatchObject({ decision: "allow" });
      expect(result.forceModal).not.toBe(true);
    }
  });

  it.each([String.raw`\\e\s`, "//e/s", String.raw`\\?\UNC\e\s`, String.raw`\\.\pipe\example`, String.raw`\\?\Volume{example}\x`])("canonicalizes %s lexically on the native network platform", path => {
    probes.calls.length = 0;
    canonicalizePathForMatch(path);
    createPathCanonicalizer()(path);
    if (process.platform === "win32") expect(probes.calls.filter(call => call.unc)).toEqual([]);
    else expect(probes.calls.length).toBeGreaterThan(0);
  });

  it("retains drive-root-relative canonicalization for a single leading separator", () => {
    probes.calls.length = 0;
    const canonical = canonicalizePathForMatch(String.raw`\es`);
    if (process.platform === "win32") {
      expect(canonical).toMatch(/^[a-z]:\/es$/u);
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } else expect(canonical).toContain("\\es");
  });

  it("observes filesystem resolution for an ordinary destination", () => {
    probes.calls.length = 0;
    check("bash", "cp x out.txt");
    const realpaths = probes.calls.filter(call => call.operation.startsWith("realpathSync"));
    console.info("UNC-SPY positive control", JSON.stringify({ realpaths: realpaths.length, uncCalls: probes.calls.filter(call => call.unc).length }));
    expect(realpaths.length).toBeGreaterThan(0);
  });

  it("audits operand and host-root filesystem calls on the classification path", () => {
    const sites = ["shell-filesystem-path.ts", "sensitive-paths.ts", "scoped-rule-matcher.ts", "asrt-sandbox.ts",
      "replay-root-binding.ts", "git-repository-inputs.ts", "project-rule-files.ts", "persisted-policy-version.ts",
      "permission-audit-runner.ts", "permission-settings-store.ts"];
    probes.calls.length = 0;
    for (const command of [String.raw`cp x '\\e\s'`, String.raw`git -C '\\e\s' status`, "git status"])
      check("bash", command);
    const classificationCalls = [...probes.calls];
    console.info("UNC-AUDIT", JSON.stringify(sites.map(site => ({ site,
      calls: classificationCalls.filter(call => call.stack.includes(site)).length,
      uncCalls: classificationCalls.filter(call => call.unc && call.stack.includes(site)).length,
    }))));
    if (process.platform === "win32") expect(classificationCalls.filter(call => call.unc)).toEqual([]);
    // The approval-depth UI accepts model paths, but the shared resolver rejects
    // a native share before its stat(target) and subsequent root discovery.
    probes.calls.length = 0;
    const choices = editDepthCandidates(String.raw`\\e\s`, join(directory, "project"));
    if (process.platform === "win32") {
      expect(choices).toEqual([]);
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    }
    console.info("UNC-AUDIT depth", JSON.stringify({ choices: choices.length, uncCalls: probes.calls.filter(call => call.unc).length }));
  });

  it("probes root-only readers with an explicit host working directory", () => {
    probes.calls.length = 0;
    const cwd = join(directory, "project");
    expect(captureReplayRootDigest(cwd)).toEqual(expect.any(String));
    expect(projectRootFor(cwd)).toBe(canonicalizePathForMatch(cwd));
    expect(projectRulesLocation(directory, cwd).filePath).toContain("project-rules");
    if (process.platform === "win32") expect(getVendoredApplySeccompPath()).toBeUndefined();
    for (const site of ["replay-root-binding.ts", "project-rule-files.ts"]) {
      const calls = probes.calls.filter(call => call.stack.includes(site));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter(call => call.unc)).toEqual([]);
      console.info("UNC-AUDIT host root", JSON.stringify({ site, calls: calls.length, uncCalls: 0 }));
    }
  });

  it.each([String.raw`\\e\s`, "//e/s", String.raw`\\.\pipe\example`, String.raw`\\?\UNC\e\s`])("guards all physical resolver entrypoints for %s", path => {
    probes.calls.length = 0;
    for (const run of [() => resolveShellFilesystemPath(path, directory), () => resolvePhysicalFilesystemPath(path, directory, 8),
      () => inspectPhysicalFilesystemPath(path, directory, 8), () => physicalParentReading(path)]) {
      if (process.platform === "win32") expect(run).toThrow(expect.objectContaining({ code: "ENETWORKSHAREPATH" }));
      else { try { run(); } catch { /* Host path resolution can reject a missing local path. */ } }
    }
    if (process.platform === "win32") expect(probes.calls).toEqual([]);
  });
});

describe("lexical native network and device identities", () => {
  const network = [String.raw`\\server\share\x`, "//server/share/x", String.raw`\\server`, "//server/",
    String.raw`\\?\UNC\server\share`, String.raw`\\.\pipe\example`, String.raw`\\?\Volume{example}\x`,
    "\\\\?\\", "\\\\.\\", String.raw`\\?\C:relative`, String.raw`\/server\share`];
  const local = [String.raw`\es`, String.raw`\e\s`, String.raw`C:\x`, String.raw`\\?\C:\x`, "//?/C:/x", "/es", "x", "", "//", "\\\\", "///server/share"];
  it.each(network)("recognizes %s only on the native network platform", path => {
    expect(isWindowsNetworkOrDevicePath(path, "win32")).toBe(true);
    expect(isWindowsNetworkOrDevicePath(path, "linux")).toBe(false);
    expect(isWindowsNetworkOrDevicePath(path, "darwin")).toBe(false);
  });
  it.each(local)("keeps %s outside the network/device boundary", path => {
    expect(isWindowsNetworkOrDevicePath(path, "win32")).toBe(false);
    expect(isWindowsNetworkOrDevicePath(path, "linux")).toBe(false);
  });
});
