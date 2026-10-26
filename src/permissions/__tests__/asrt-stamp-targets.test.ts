import { mkdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FilesystemConfig, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { expandWindowsFsPaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as homeGuard from "../../shared/ave-home-test-guard.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { useScratchLinks, useTempDirs } from "../../__tests__/test-helpers.js";
import * as policyHome from "../../shared/policy-home.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";

vi.mock("@anthropic-ai/sandbox-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    getWindowsSandboxUserStatus: vi.fn(actual.getWindowsSandboxUserStatus),
    grantWindowsAcl: vi.fn(actual.grantWindowsAcl),
    revokeWindowsAcl: vi.fn(actual.revokeWindowsAcl),
  };
});

const expansion = vi.hoisted(() => ({ after: undefined as (() => void) | undefined }));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js", async importOriginal => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js")>();
  return {
    ...actual,
    expandWindowsFsPaths: (...args: Parameters<typeof actual.expandWindowsFsPaths>) => {
      const expanded = actual.expandWindowsFsPaths(...args);
      if (expanded.length > 0) expansion.after?.();
      return expanded;
    },
  };
});

useVerifiedAveHomePrivacy();
const scratch = useTempDirs("stamp-targets-");
const link = useScratchLinks();
const refusal = /constrain the test's deny\/allow targets to fixtures/;

afterEach(async () => {
  const { resetAsrtSandbox } = await import("../asrt-sandbox.js");
  await resetAsrtSandbox();
  vi.restoreAllMocks();
});

async function initializeFixtureSandbox() {
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
  const sandbox = await import("../asrt-sandbox.js");
  await sandbox.initializeAsrtSandbox({ windows: { externalConfinement: true } });
  return { SandboxManager, sandbox };
}

function runtimeDenyWrite(filesystem: Partial<FilesystemConfig> | undefined): string[] {
  return expandWindowsFsPaths(filesystem?.denyWrite ?? [], { mode: "deny" }).map(path => resolve(path));
}

describe.runIf(process.platform === "win32")("sandbox stamp target isolation", () => {
  // A fixture profile keeps real-home rows profile-disjoint, so they reach the guard instead of the missing-row filter.
  beforeEach(() => {
    const profile = scratch("stamp-profile-");
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOME", profile);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("refuses account targets in another case and names the first target", () => {
    const target = join(inject("realAccountHome").toUpperCase(), ".curlrc");
    expect(() => homeGuard.checkSandboxStampTargets([target, join(scratch(), "allowed")])).toThrow(target);
    expect(() => homeGuard.checkSandboxStampTargets([target])).toThrow(refusal);
  });

  it("refuses account targets reached through a fixture junction", () => {
    const alias = link(inject("realAccountHome"), join(scratch(), "account-link"));
    expect(() => homeGuard.checkSandboxStampTargets([join(alias, "not-created", ".curlrc")])).toThrow(refusal);
  });

  it("refuses machine targets without a test-tmp exception", () => {
    const target = join(inject("realProgramData")!, "test-tmp", "Ave", "policy.json");
    expect(() => homeGuard.checkSandboxStampTargets([target])).toThrow(refusal);
    expect(() => homeGuard.checkSandboxStampTargets(["C:\\ProgramData\\Ave\\policy.json"])).toThrow(refusal);
  });

  it("refuses machine targets reached through a fixture junction", () => {
    const alias = link(inject("realProgramData")!, join(scratch(), "machine-link"));
    expect(() => homeGuard.checkSandboxStampTargets([join(alias, "Ave", "not-created")])).toThrow(refusal);
  });

  it("allows fixture targets and the sanctioned account test-tmp subtree", () => {
    expect(() => homeGuard.checkSandboxStampTargets([join(scratch(), "target")])).not.toThrow();
    expect(() => homeGuard.checkSandboxStampTargets([join(inject("realAccountHome"), ".ave", "test-tmp", "fixture")])).not.toThrow();
    expect(() => homeGuard.checkSandboxStampTargets([join(inject("realAccountHome"), "test-tmp", "fixture")])).toThrow(refusal);
  });

  it("allows the Windows run temp root but not its profile siblings", () => {
    expect(() => homeGuard.checkSandboxStampTargets([join(inject("realAccountHome"), ".ave-test-tmp", "t-run", "fixture")])).not.toThrow();
    expect(() => homeGuard.checkSandboxStampTargets([join(inject("realAccountHome"), ".ave-test-tmp-sibling", "fixture")])).toThrow(refusal);
  });

  it("refuses the default floor before native initialization", async () => {
    expect(homeGuard.checkSandboxStampTargets).toBeTypeOf("function");
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({})).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses a direct machine deny-write target before native initialization", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    const target = join("C:\\ProgramData", "Ave", "stamp-fixture");
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      denyWrite: [target],
    })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses a direct account deny-read target before native initialization", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      denyRead: [join(inject("realAccountHome"), ".curlrc")],
    })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses extended-prefix account targets before native initialization", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      denyRead: ["\\\\?\\" + join(inject("realAccountHome"), ".curlrc")],
    })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("expands home and environment literals and checks each glob match while skipping UNC targets", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Fixture initialization reached"));
    const guard = vi.spyOn(homeGuard, "checkSandboxStampTargets");
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    const match = join(process.env.USERPROFILE!, "match.stamp-fixture");
    writeFileSync(match, "");
    const glob = join(process.env.USERPROFILE!, "*.stamp-fixture");
    const unc = "\\\\server\\share\\stamp-fixture";
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      allowWrite: ["~/.stamp-fixture", "%USERPROFILE%/.stamp-env-fixture"],
      denyRead: ["~/.stamp-fixture", "%USERPROFILE%/.stamp-env-fixture", glob, unc],
    })).rejects.toThrow("Fixture initialization reached");
    expect(initialize).toHaveBeenCalledOnce();
    const paths = guard.mock.calls[0]![0].map((path) => resolve(path));
    expect(paths).toContain(join(process.env.HOME!, ".stamp-fixture"));
    expect(paths).toContain(join(process.env.USERPROFILE!, ".stamp-env-fixture"));
    expect(paths).toContain(match);
    expect(paths).not.toContain(glob);
    expect(paths).not.toContain(unc);
  });

  it("refuses a glob whose matches are under the real account home", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      denyRead: [join(inject("realAccountHome"), "AppData*")],
    })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses a glob under a run-temp junction that reaches the real account home", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    const alias = link(inject("realAccountHome"), join(scratch(), "account-link"));
    await expect(initializeAsrtSandbox({
      windows: { externalConfinement: true },
      denyWrite: [join(alias, "*")],
    })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses per-command tool denies before the native wrapper is called", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv");
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [join(inject("realAccountHome"), ".curlrc")] },
    })).rejects.toThrow(refusal);
    expect(wrap).not.toHaveBeenCalled();
  });

  it("refuses per-command worker denies before the native wrapper is called", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv");
    await expect(sandbox.wrapWorkerCommand("echo fixture", {
      commandId: TEST_COMMAND_ID,
      filesystem: { denyWrite: [join(inject("realAccountHome"), ".curlrc")] },
    })).rejects.toThrow(refusal);
    expect(wrap).not.toHaveBeenCalled();
  });

  it("refuses worker grants before consulting the native sandbox account", async () => {
    const { sandbox } = await initializeFixtureSandbox();
    await expect(sandbox.grantWindowsWorkerFilesystemAccess({
      holderPid: process.pid,
      allowRead: [join(inject("realAccountHome"), ".curlrc")],
    })).rejects.toThrow(refusal);
  });

  it("pins session glob matches before the runtime's asynchronous lookups", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const existing = join(process.env.USERPROFILE!, "existing.stamp-fixture");
    const late = join(process.env.USERPROFILE!, "late.stamp-fixture");
    const glob = join(process.env.USERPROFILE!, "*.stamp-fixture");
    writeFileSync(existing, "");
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      writeFileSync(late, "");
      const paths = runtimeDenyWrite(config.filesystem);
      expect(paths).toContain(existing);
      expect(paths).not.toContain(late);
      expect(config.filesystem.denyWrite).not.toContain(glob);
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await initializeAsrtSandbox({ windows: { externalConfinement: true }, denyWrite: [glob] });
  });

  it("pins tool glob matches before the runtime's asynchronous lookups", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const existing = join(process.env.USERPROFILE!, "existing.stamp-fixture");
    const late = join(process.env.USERPROFILE!, "late.stamp-fixture");
    const glob = join(process.env.USERPROFILE!, "*.stamp-fixture");
    writeFileSync(existing, "");
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      writeFileSync(late, "");
      const paths = runtimeDenyWrite(config?.filesystem);
      expect(paths).toContain(existing);
      expect(paths).not.toContain(late);
      expect(config?.filesystem?.denyWrite).not.toContain(glob);
      return { argv: ["fixture"], env: {} };
    });
    await sandbox.wrapToolCommand("echo fixture", { commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [glob] } });
  });

  it("pins a session junction glob to its canonical fixture before re-pointing", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const target = scratch();
    const existing = join(target, "existing.stamp-fixture");
    writeFileSync(existing, "");
    const alias = link(target, join(scratch(), "alias"));
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      rmdirSync(alias);
      link(inject("realAccountHome"), alias);
      runtimeDenyWrite(config.filesystem);
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({ windows: { externalConfinement: true }, denyWrite: [join(alias, "*.stamp-fixture")] }))
      .rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("pins a tool junction literal and its missing tail before re-pointing", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const target = scratch();
    const alias = link(target, join(scratch(), "alias"));
    const canonical = join(realpathSync.native(target), "missing", "leaf");
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      expect(runtimeDenyWrite(config?.filesystem)).toContain(canonical);
      rmdirSync(alias);
      link(inject("realAccountHome"), alias);
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [join(alias, "missing", "leaf")] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("keeps both the fixture junction spelling and canonical target in deny lists", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const target = scratch();
    const alias = link(target, join(scratch(), "alias"));
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      for (const entries of [config.filesystem.denyRead, config.filesystem.denyWrite]) {
        expect(entries.every(entry => typeof entry !== "string" && entry.literal === true)).toBe(true);
        expect(expandWindowsFsPaths(entries, { mode: "deny" }).map(path => resolve(path)))
          .toEqual(expect.arrayContaining([alias, realpathSync.native(target)]));
      }
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await initializeAsrtSandbox({ windows: { externalConfinement: true }, denyRead: [alias], denyWrite: [alias] });
  });

  it("refuses both deny spellings when a fixture junction is re-pointed before consumption", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const target = scratch();
    const alias = link(target, join(scratch(), "alias"));
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      const entries = (config?.filesystem?.denyWrite ?? []).filter(entry => {
        const path = typeof entry === "string" ? entry : entry.path;
        return path === alias || path === realpathSync.native(target);
      });
      expect(entries.map(entry => typeof entry === "string" ? entry : entry.path))
        .toEqual([alias, realpathSync.native(target)]);
      rmdirSync(alias);
      link(scratch(), alias);
      for (const entry of entries) {
        expect(() => typeof entry === "string" ? entry : entry.path).toThrow(/Sandbox stamp target identity changed/);
      }
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [alias] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("keeps only the canonical fixture junction target in grant lists", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const target = scratch();
    const alias = link(target, join(scratch(), "alias"));
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      rmdirSync(alias);
      link(scratch(), alias);
      for (const entries of [config.filesystem.allowRead ?? [], config.filesystem.allowWrite]) {
        expect(entries.every(entry => typeof entry !== "string" && entry.literal === true)).toBe(true);
        expect(expandWindowsFsPaths(entries, { mode: "grant" }).map(path => resolve(path)))
          .toEqual([realpathSync.native(target)]);
      }
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await initializeAsrtSandbox({ windows: { externalConfinement: true }, allowRead: [alias], allowWrite: [alias] });
  });

  it("refuses a deny with a missing tail when an intermediate junction target is re-pointed", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const intermediate = link(scratch(), join(scratch(), "intermediate"));
    const alias = link(intermediate, join(scratch(), "alias"));
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      rmdirSync(intermediate);
      link(inject("realAccountHome"), intermediate);
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [join(alias, "missing", "leaf")] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("refuses a replaced literal when the runtime consumes the pinned session list", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const target = join(scratch(), "target");
    writeFileSync(target, "original");
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      renameSync(target, target + "-original");
      writeFileSync(target, "replacement");
      runtimeDenyWrite(config.filesystem);
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await expect(initializeAsrtSandbox({ windows: { externalConfinement: true }, denyWrite: [target] }))
      .rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("refuses a replaced ancestor when the runtime consumes a pinned tool list", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const target = join(scratch(), "target");
    mkdirSync(target);
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      renameSync(target, target + "-original");
      link(inject("realAccountHome"), target);
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [join(target, "missing")] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it.each(["allowWrite", "allowRead", "denyWrite"] as const)("refuses a %s target the runtime would reread through an environment reference", async (list) => {
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const template = join(scratch(), "%HOMEPATH%");
    mkdirSync(join(template, "leaf"), { recursive: true });
    const alias = link(template, join(scratch(), "alias"));
    expect(() => pinWindowsFilesystemConfig({ [list]: [join(alias, "leaf")] }))
      .toThrow(/reinterpreted by the runtime/);
  });

  it.each(["allowWrite", "allowRead"] as const)("refuses a %s target removed after expansion that the runtime would reread through an environment reference", async (list) => {
    const template = join(scratch(), "%HOMEPATH%");
    const leaf = join(template, "leaf");
    mkdirSync(leaf, { recursive: true });
    const alias = link(template, join(scratch(), "alias"));
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    // The leaf vanishes between expansion and canonicalization, so no existence check sees it.
    expansion.after = () => { expansion.after = undefined; rmdirSync(leaf); };
    expect(() => pinWindowsFilesystemConfig({ [list]: [join(alias, "leaf")] }))
      .toThrow(/reinterpreted by the runtime/);
  });

  it("accepts a missing tail created as a plain directory before consumption", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const parent = scratch();
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      runtimeDenyWrite(config?.filesystem);
      mkdirSync(join(parent, "missing"));
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [join(parent, "missing") + "\\"] },
    })).resolves.toBeDefined();
  });

  it("refuses a missing tail created as a junction before consumption", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const parent = scratch();
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      link(scratch(), join(parent, "missing"));
      runtimeDenyWrite(config?.filesystem);
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [join(parent, "missing", "leaf")] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("pins rebuilt session configs on worker registration and release", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const updates: SandboxRuntimeConfig[] = [];
    vi.spyOn(SandboxManager, "updateConfig").mockImplementation(config => { updates.push(config); });
    const holder = {};
    const socketDir = scratch();
    await sandbox.registerWorkerUnixSocketDir(socketDir, holder);
    await sandbox.unregisterWorkerUnixSocketDir(socketDir, holder);
    expect(updates).toHaveLength(2);
    for (const config of updates) {
      for (const entries of [config.filesystem.denyRead, config.filesystem.denyWrite, config.filesystem.allowRead, config.filesystem.allowWrite]) {
        expect(entries?.every(entry => typeof entry !== "string" && entry.literal === true)).toBe(true);
      }
    }
  });

  it("preserves grant and deny expansion modes and missing directory markers", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const root = scratch();
    const readable = join(root, "readable");
    const writable = join(root, "writable");
    const missingGrant = join(root, "missing-grant");
    const missingDeny = join(root, "missing-deny");
    writeFileSync(readable, "");
    writeFileSync(writable, "");
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async config => {
      const filesystem = config.filesystem;
      expect(expandWindowsFsPaths(filesystem.allowRead ?? [], { mode: "grant" }).map(path => resolve(path))).toEqual([readable]);
      expect(expandWindowsFsPaths(filesystem.allowWrite, { mode: "grant" }).map(path => resolve(path))).toEqual([writable]);
      expect(expandWindowsFsPaths(filesystem.denyRead, { mode: "deny" }).map(path => resolve(path))).toContain(missingDeny);
      const entries = filesystem.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path);
      expect(entries).toContain(missingDeny + "\\");
      for (const list of [filesystem.allowRead, filesystem.allowWrite, filesystem.denyRead, filesystem.denyWrite]) {
        expect(list?.every(entry => typeof entry !== "string" && entry.literal === true)).toBe(true);
      }
    });
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    await initializeAsrtSandbox({
      windows: { externalConfinement: true },
      allowRead: [readable, missingGrant], allowWrite: [writable, missingGrant],
      denyRead: [missingDeny], denyWrite: [missingDeny + "\\"],
    });
  });

  it("pins worker and terminal wrap lists before the runtime reads them", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const target = join(scratch(), "target");
    writeFileSync(target, "");
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      const entries = config?.filesystem?.denyWrite ?? [];
      expect(entries.every(entry => typeof entry !== "string" && entry.literal === true)).toBe(true);
      expect(runtimeDenyWrite(config?.filesystem)).toContain(realpathSync.native(target));
      return { argv: ["fixture"], env: {} };
    });
    await sandbox.wrapWorkerCommand("echo fixture", { commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [target] } });
    await sandbox.wrapTerminalCommand("echo fixture", { commandId: TEST_COMMAND_ID, ownTty: "/dev/ttys000", filesystem: { denyWrite: [target] } });
    expect(SandboxManager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
  });

  it("refuses a literal replaced after runtime expansion before wrap return", async () => {
    const { SandboxManager, sandbox } = await initializeFixtureSandbox();
    const target = join(scratch(), "target");
    writeFileSync(target, "original");
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation(async (_command, _shell, config) => {
      expect(runtimeDenyWrite(config?.filesystem)).toContain(target);
      renameSync(target, target + "-original");
      writeFileSync(target, "replacement");
      return { argv: ["fixture"], env: {} };
    });
    await expect(sandbox.wrapToolCommand("echo fixture", {
      commandId: TEST_COMMAND_ID, filesystem: { denyWrite: [target] },
    })).rejects.toThrow(/Sandbox stamp target identity changed/);
  });

  it("grants exactly the canonical matches checked before account lookup", async () => {
    const { sandbox } = await initializeFixtureSandbox();
    const runtime = await import("@anthropic-ai/sandbox-runtime");
    const integrity = await import("../srt-win-integrity.js");
    const target = scratch();
    const existing = join(target, "existing.stamp-fixture");
    const late = join(target, "late.stamp-fixture");
    writeFileSync(existing, "");
    const alias = link(target, join(scratch(), "alias"));
    const executable = join(scratch(), "fixture.exe");
    writeFileSync(executable, "fixture");
    vi.spyOn(integrity, "prepareSrtWinExecutable").mockReturnValue(executable);
    vi.spyOn(runtime, "getWindowsSandboxUserStatus").mockImplementation(() => {
      writeFileSync(late, "");
      rmdirSync(alias);
      link(inject("realAccountHome"), alias);
      return {
        provisioned: true, credPresent: true, sid: "S-1-5-21-100-200-300-1001",
        groupExists: true, inBuiltinUsers: false, inSandboxGroup: true, hiddenFromLogon: true,
        realUserSid: "S-1-5-21-100-200-300-1002",
      };
    });
    const grant = vi.spyOn(runtime, "grantWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "revokeWindowsAcl").mockImplementation(() => {});
    const checked = vi.spyOn(homeGuard, "checkSandboxStampTargets");
    const held = await sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [join(alias, "*.stamp-fixture")] });
    expect(held.allowWrite).toEqual([realpathSync.native(existing)]);
    expect(held.allowRead).toEqual(held.allowWrite);
    expect(new Set(checked.mock.calls[1]![0])).toEqual(new Set(held.allowRead));
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ read: held.allowRead, write: held.allowWrite }));
    held.release();
  });
});
