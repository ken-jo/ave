import "../../__tests__/support/trusted-powershell.js";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { canonicalizePathForMatch, createPathCanonicalizer } from "../sensitive-paths.js";
import { isWindowsNetworkOrDevicePath } from "../../shared/shell-native-path.js";
import { inspectPhysicalFilesystemPath, physicalParentReading, resolvePhysicalFilesystemPath, resolveShellFilesystemPath, verifyLocalFilesystemChain } from "../../shared/shell-filesystem-path.js";
import { editDepthCandidates } from "../rules/scoped-rule-matcher.js";
import { captureReplayRootDigest } from "../reviewer/replay-root-binding.js";
import { projectRootFor, projectRulesLocation } from "../rules/project-rule-files.js";
import { getVendoredApplySeccompPath } from "../asrt-sandbox.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";

const probes = vi.hoisted(() => ({
  calls: [] as { operation: string; path: string; unc: boolean; stack: string }[],
  links: new Map<string, string>(),
  errors: new Map<string, string>(),
  syntheticRoot: "",
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const paths = await import("node:path");
  const wrap = <T extends (...args: never[]) => unknown>(operation: string, original: T) => vi.fn((...args: Parameters<T>): unknown => {
    const path = String(args[0]);
    const unc = path.startsWith("\\\\") || path.startsWith("//");
    probes.calls.push({ operation, path, unc, stack: new Error().stack ?? "" });
    const key = path.replaceAll("\\", "/").toLowerCase();
    const errorCode = probes.errors.get(key);
    if (errorCode !== undefined) throw Object.assign(new Error("Synthetic path resolution failure"), { code: errorCode });
    if (probes.syntheticRoot && key === probes.syntheticRoot) {
      if (operation.startsWith("realpathSync")) return path;
      if (operation === "lstatSync") return { isSymbolicLink: () => false };
    }
    const target = probes.links.get(key);
    if (target !== undefined) {
      if (operation === "lstatSync") return { isSymbolicLink: () => true };
      if (operation === "readlinkSync") return target;
    }
    for (const [link, destination] of probes.links) {
      if (key !== link && !key.startsWith(link + "/")) continue;
      if (key === link && (operation === "lstatSync" || operation === "readlinkSync")) continue;
      // Model implicit traversal too: even lstat on link/child follows link.
      const effective = paths.isAbsolute(destination) || destination.startsWith("\\\\")
        ? destination : paths.resolve(paths.dirname(path.slice(0, link.length)), destination);
      const followed = effective + path.slice(link.length);
      return wrap(operation, original)(...[followed, ...args.slice(1)] as Parameters<T>);
    }
    // Observe attempted network opens without ever contacting the supplied host.
    if (unc) throw Object.assign(new Error("Network path intercepted by probe"), { code: "ENOENT" });
    return original(...args);
  });
  return { ...actual,
    realpathSync: Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) }),
    lstatSync: wrap("lstatSync", actual.lstatSync), statSync: wrap("statSync", actual.statSync),
    readlinkSync: wrap("readlinkSync", actual.readlinkSync),
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
    String.raw`Get-Content '\\host\share\notes.txt'`,
    String.raw`Write-Output '\\host\share\notes.txt'`,
  ])("allows a read or printed share path without network I/O: %s", command => {
    probes.calls.length = 0;
    const result = check("powershell", command);
    const uncCalls = probes.calls.filter(call => call.unc).length;
    console.info("UNC-P2-SPY read-share", JSON.stringify({ command, decision: result.decision, reasonCode: result.reasonCode,
      floor: result.pipelineRequest?.floor?.code, forced: result.forceModal, uncCalls }));
    if (process.platform === "win32") {
      expect(result).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
      expect(result.forceModal).toBeUndefined();
      expect(result.pipelineRequest?.floor).toBeUndefined();
      expect(uncCalls).toBe(0);
    } else {
      expect(isWindowsNetworkOrDevicePath(String.raw`\\host\share\notes.txt`)).toBe(false);
    }
  });

  it("reports a bash share read for diagnosis", () => {
    probes.calls.length = 0;
    const result = check("bash", String.raw`cat '\\host\share\notes.txt'`);
    const { decision, reasonCode } = result;
    const floor = result.pipelineRequest?.floor?.code;
    const uncCalls = probes.calls.filter(call => call.unc).length;
    console.info("UNC-P2-SPY bash-read-share", JSON.stringify({ decision, reasonCode, floor, uncCalls }));
  });

  it("retains delete intent through a network link", () => {
    const target = String.raw`\\host\share`;
    const link = join(directory, "project", "link").replaceAll("\\", "/").toLowerCase();
    probes.links.set(link, target);
    try {
      probes.calls.length = 0;
      const result = check("powershell", "rm link/notes.txt");
      const evidence = inspectPowerShellPermissionPaths("rm link/notes.txt", join(directory, "project"));
      console.info("UNC-P2-SPY delete-share", JSON.stringify({ decision: result.decision, reasonCode: result.reasonCode,
        floor: result.pipelineRequest?.floor?.code, deleteIntent: evidence.paths.some(path => path.projectEscape && path.deleteIntent),
        uncCalls: probes.calls.filter(call => call.unc).length }));
      if (process.platform === "win32") {
        expect(result).toMatchObject({ decision: "ask", reasonCode: "project-escape", forceModal: true,
          pipelineRequest: { floor: { code: "project-escape" } } });
        expect(evidence.paths).toContainEqual(expect.objectContaining({ projectEscape: true, deleteIntent: true }));
        expect(probes.calls.filter(call => call.unc)).toEqual([]);
      } else {
        expect(isWindowsNetworkOrDevicePath(target)).toBe(false);
      }
    } finally { probes.links.clear(); }
  });

  it.each([String.raw`\\e\s`, "//e/s", String.raw`\\?\UNC\e\s`])("rejects indirect network target %s before traversal", target => {
    const link = join(directory, "project", "link").replaceAll("\\", "/").toLowerCase();
    probes.links.set(link, target);
    try {
      for (const { dialect, command } of [
        { dialect: "bash", command: "cp x link/y" }, { dialect: "bash", command: "echo > link/z" },
        { dialect: "powershell", command: "Copy-Item x link/y" }, { dialect: "powershell", command: "echo > link/z" },
        { dialect: "powershell", command: "Set-Content link/y x" },
      ] as const) {
        probes.calls.length = 0;
        const result = check(dialect, command);
        const headless = check(dialect, command, true);
        const unc = probes.calls.filter(call => call.unc);
        console.info("UNC-P2-SPY", JSON.stringify({ target, dialect, command, decision: result.decision, reasonCode: result.reasonCode,
          floor: result.pipelineRequest?.floor?.code, forced: result.forceModal, headless: headless.decision, headlessReason: headless.reasonCode, uncCalls: unc.length }));
        if (process.platform === "win32") {
          expect(result).toMatchObject({ decision: "ask", reasonCode: "project-escape", forceModal: true,
            pipelineRequest: { floor: { code: "project-escape" } } });
          expect(headless).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
          expect(unc).toEqual([]);
        } else {
          expect(isWindowsNetworkOrDevicePath(target)).toBe(false);
        }
      }
    } finally { probes.links.clear(); }
  });

  it("keeps a non-network PowerShell resolver failure on the protected floor", () => {
    const target = join(directory, "project", "unresolved").replaceAll("\\", "/").toLowerCase();
    probes.errors.set(target, "EUNRESOLVEDSHELLPATH");
    try {
      probes.calls.length = 0;
      const result = check("powershell", "Set-Content unresolved x");
      console.info("UNC-P2-SPY non-network pin", JSON.stringify({ decision: result.decision, floor: result.pipelineRequest?.floor?.code,
        forced: result.forceModal, resolverCalls: probes.calls.filter(call => call.path.replaceAll("\\", "/").toLowerCase() === target).length,
        uncCalls: probes.calls.filter(call => call.unc).length }));
      expect(probes.calls.some(call => call.path.replaceAll("\\", "/").toLowerCase() === target)).toBe(true);
      expect(result).toMatchObject({ decision: "ask", reasonCode: "protected-path", forceModal: true,
        pipelineRequest: { floor: { code: "protected-path" } } });
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } finally { probes.errors.clear(); }
  });

  it.each(["win32", "linux"] as const)("checks a nested local-to-network chain with explicit %s semantics", platform => {
    const root = "D:\\";
    const link = win32.join(root, "local-link");
    const next = win32.join(root, "network-link");
    probes.syntheticRoot = root.replaceAll("\\", "/").toLowerCase();
    probes.links.set(link.replaceAll("\\", "/").toLowerCase(), next);
    probes.links.set(next.replaceAll("\\", "/").toLowerCase(), String.raw`\\e\s`);
    try {
      probes.calls.length = 0;
      const run = () => verifyLocalFilesystemChain(win32.join(link, "child"), platform);
      if (platform === "win32") {
        expect(run).toThrow(expect.objectContaining({ code: "ENETWORKSHAREPATH" }));
        expect(probes.calls.filter(call => call.operation === "readlinkSync").map(call => call.path)).toEqual([link, next]);
      } else {
        expect(run).not.toThrow();
        expect(probes.calls).toEqual([]);
      }
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
      console.info("UNC-P2-SPY nested chain", JSON.stringify({ platform, readlinks: probes.calls.filter(call => call.operation === "readlinkSync").length,
        uncCalls: probes.calls.filter(call => call.unc).length }));
    } finally { probes.links.clear(); probes.syntheticRoot = ""; }
  });

  it.each([
    { dialect: "bash", command: "ln -s //e/s link" },
    { dialect: "powershell", command: String.raw`New-Item -ItemType SymbolicLink -Target \\e\s link` },
  ] as const)("guards direct link creation $dialect", ({ dialect, command }) => {
    // The link target is an operand handled by the pre-existing direct gate.
    probes.calls.length = 0;
    const result = check(dialect, command);
    if (process.platform === "win32") {
      expect(result).toMatchObject({ decision: "ask", reasonCode: "project-escape", forceModal: true,
        pipelineRequest: { floor: { code: "project-escape" } } });
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } else expect(isWindowsNetworkOrDevicePath("//e/s")).toBe(false);
  });

  it("resolves a local link target through the live mock", () => {
    mkdirSync(join(directory, "sub"), { recursive: true });
    probes.links.set(join(directory, "project", "link").replaceAll("\\", "/").toLowerCase(), "../sub");
    try {
      probes.calls.length = 0;
      expect(resolvePhysicalFilesystemPath(join(directory, "project", "link", "y"), directory, 64)).toBe(join(directory, "sub", "y"));
      const realpaths = probes.calls.filter(call => call.operation.startsWith("realpathSync"));
      console.info("UNC-P2-SPY local control", JSON.stringify({ realpaths: realpaths.length, uncCalls: probes.calls.filter(call => call.unc).length }));
      expect(realpaths.length).toBeGreaterThan(0);
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } finally { probes.links.clear(); }
  });

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
    if (process.platform === "win32") {
      expect(result).toMatchObject({ decision: "ask", reasonCode: "project-escape", forceModal: true,
        pipelineRequest: { floor: { code: "project-escape" } } });
      expect(headless).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
      expect(result.reviewer).toBeUndefined();
      expect(unc).toEqual([]);
    } else {
      // On this host, quoted backslashes name a local file; slash roots follow host rules.
      const needsApproval = dialect === "powershell" || command === "cp x //e/s";
      expect(result).toMatchObject({ decision: needsApproval ? "ask" : "allow" });
      if (dialect === "powershell") {
        expect(result).toMatchObject({ reasonCode: "project-escape", forceModal: true,
          pipelineRequest: { floor: { code: "project-escape" } } });
        expect(headless).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
        expect(result.reviewer).toBeUndefined();
        expect(unc).toEqual([]);
      }
      if (!needsApproval) expect(result.forceModal).not.toBe(true);
    }
  });

  it.each([String.raw`\\e\s`, "//e/s", String.raw`\\?\UNC\e\s`, String.raw`\\.\pipe\example`, String.raw`\\?\Volume{example}\x`])("canonicalizes %s lexically on the native network platform", path => {
    probes.calls.length = 0;
    canonicalizePathForMatch(path);
    createPathCanonicalizer()(path);
    if (process.platform === "win32") expect(probes.calls.filter(call => call.unc)).toEqual([]);
    else expect(probes.calls.length).toBeGreaterThan(0);
  });

  it("preserves canonical identity when a local leaf lstat fails with EACCES", async () => {
    const parent = join(directory, "eacces-parent");
    mkdirSync(parent);
    const leaf = join(parent, "missing-leaf");
    const expected = canonicalizePathForMatch(leaf);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lstat = vi.mocked(lstatSync);
    const original = lstat.getMockImplementation()!;
    lstat.mockImplementation(((path, options) => {
      if (String(path) === leaf) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
      return actual.lstatSync(path, options);
    }) as typeof lstatSync);
    try {
      lstat.mockClear();
      expect(() => canonicalizePathForMatch(leaf)).not.toThrow();
      expect(canonicalizePathForMatch(leaf)).toBe(expected);
      if (process.platform === "win32") {
        expect(lstat.mock.calls.some(call => String(call[0]) === leaf)).toBe(true);
      } else {
        probes.calls.length = 0;
        expect(isWindowsNetworkOrDevicePath(String.raw`\\host\share`)).toBe(false);
        expect(() => verifyLocalFilesystemChain(leaf)).not.toThrow();
        expect(lstat).not.toHaveBeenCalled();
        expect(probes.calls).toEqual([]);
      }
    } finally { lstat.mockImplementation(original); }
  });

  it("retains drive-root-relative canonicalization for a single leading separator", () => {
    probes.calls.length = 0;
    const canonical = canonicalizePathForMatch(String.raw`\es`);
    if (process.platform === "win32") {
      expect(canonical).toMatch(/^[a-z]:\/es$/u);
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } else {
      expect(canonical).toBe(resolve("es"));
    }
  });

  it.each([String.raw`\?\C:\proc\self\environ`, String.raw`\\?\C:\proc\self\environ`])("resolves the local device chain without a bare drive or network call: %s", path => {
    probes.calls.length = 0;
    expect(() => verifyLocalFilesystemChain(path)).not.toThrow();
    if (process.platform === "win32") {
      const realpaths = probes.calls.filter(call => call.operation.startsWith("realpathSync"));
      expect(realpaths[0]?.path).toBe("C:\\");
      expect(probes.calls.find(call => call.operation === "lstatSync")?.path).toBe("C:\\proc");
      expect(realpaths.some(call => /^[A-Za-z]:$/u.test(call.path))).toBe(false);
      expect(probes.calls.filter(call => call.unc)).toEqual([]);
    } else {
      expect(probes.calls).toEqual([]);
    }
    console.info("UNC-P2-SPY device root", JSON.stringify({ path, calls: probes.calls.map(call => ({ operation: call.operation, path: call.path })), uncCalls: probes.calls.filter(call => call.unc).length }));
  });

  it("reuses verified local ancestors while checking a new network link", () => {
    const parent = join(directory, "project");
    const canonicalize = createPathCanonicalizer();
    canonicalize(parent);
    const link = join(parent, "cached-link").replaceAll("\\", "/").toLowerCase();
    probes.links.set(link, String.raw`\\e\s`);
    try {
      probes.calls.length = 0;
      canonicalize(join(parent, "cached-link", "child"));
      if (process.platform === "win32") {
        expect(probes.calls.filter(call => call.operation === "lstatSync").map(call => call.path)).toEqual([join(parent, "cached-link")]);
        expect(probes.calls.filter(call => call.operation.startsWith("realpathSync"))).toEqual([]);
        expect(probes.calls.filter(call => call.unc)).toEqual([]);
      } else {
        expect(isWindowsNetworkOrDevicePath(String.raw`\\e\s`)).toBe(false);
      }
    } finally { probes.links.clear(); }
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
