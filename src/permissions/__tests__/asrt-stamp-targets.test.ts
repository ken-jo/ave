import { join, resolve } from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import * as homeGuard from "../../shared/ave-home-test-guard.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { useScratchLinks, useTempDirs } from "../../__tests__/test-helpers.js";
import * as policyHome from "../../shared/policy-home.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";

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

describe.runIf(process.platform === "win32")("sandbox stamp target isolation", () => {
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

  it("expands home and environment literals while skipping globs and UNC targets", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Fixture initialization reached"));
    const guard = vi.spyOn(homeGuard, "checkSandboxStampTargets");
    const { initializeAsrtSandbox } = await import("../asrt-sandbox.js");
    const glob = join(inject("realAccountHome"), "*.stamp-fixture");
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
    expect(paths).not.toContain(glob);
    expect(paths).not.toContain(unc);
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
});
