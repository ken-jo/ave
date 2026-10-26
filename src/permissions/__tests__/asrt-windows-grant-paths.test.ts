import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { removeLinksUnder } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { aveHome, readWindowsDirectoryDacls } from "../../shared/ave-home.js";
import { readWindowsAdminPolicy } from "../../shared/windows-admin-policy.js";
import * as facts from "../../shared/windows-path-facts.js";
import { readWindowsReadDenyEvidence, windowsReadDenyKey } from "../../shared/windows-read-deny-evidence.js";
import * as integrity from "../srt-win-integrity.js";
import * as denyAcl from "../windows-deny-acl.js";
import { buildSandboxConfig, grantWindowsWorkerFilesystemAccess, initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../asrt-sandbox.js";

vi.mock("@anthropic-ai/sandbox-runtime", async importOriginal => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>()),
}));
vi.mock("node:os", async importOriginal => ({ ...(await importOriginal<typeof import("node:os")>()) }));

useVerifiedAveHomePrivacy();

describe.runIf(process.platform === "win32")("Windows worker grant target identity", () => {
  let fixture: string;
  let target: string;
  let config: SandboxRuntimeConfig | undefined;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    fixture = mkdtempSync(join(os.tmpdir(), "grant-target-"));
    target = join(fixture, "allowed");
    mkdirSync(target);
    const profile = join(fixture, "profile");
    mkdirSync(profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    const home = join(fixture, "ave-data");
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    vi.spyOn(os, "homedir").mockReturnValue(profile);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    vi.spyOn(integrity, "prepareSrtWinExecutable").mockImplementation(source => source);
    vi.spyOn(runtime, "getWindowsSandboxUserStatus").mockReturnValue({ provisioned: true, credPresent: true, sid: "S-1-5-21-1001" } as ReturnType<typeof runtime.getWindowsSandboxUserStatus>);
    vi.spyOn(runtime, "grantWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "revokeWindowsAcl").mockReturnValue([]);
    vi.spyOn(runtime, "stampWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "restoreWindowsAcl").mockReturnValue([]);
    vi.spyOn(runtime.SandboxManager, "initialize").mockImplementation(async next => { config = next; });
    vi.spyOn(runtime.SandboxManager, "getConfig").mockImplementation(() => config);
    vi.spyOn(runtime.SandboxManager, "updateConfig").mockImplementation(next => { config = next; });
    vi.spyOn(runtime.SandboxManager, "reset").mockImplementation(async () => { config = undefined; });
  });

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    removeLinksUnder(fixture);
    rmSync(fixture, { recursive: true, force: true });
  });

  it.for(["junction", "dir"] as const)("grants the resolved %s target and retains its native identity", async (type, context) => {
    const link = join(fixture, "link");
    try { symlinkSync(target, link, type); }
    catch (error) {
      if (type === "dir" && (error as NodeJS.ErrnoException).code === "EPERM") context.skip("Directory symlink privilege unavailable; junction and tag admission are covered");
      throw error;
    }
    const identity = facts.pinWindowsPaths([target])[0]!;
    const pins = vi.spyOn(facts, "pinWindowsPaths");
    await initializeAsrtSandbox({});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [link] });
    try {
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: [realpathSync.native(target)], write: [realpathSync.native(target)] }));
      expect(grant.allowWrite).toEqual([realpathSync.native(target)]);
      const targetPins = pins.mock.results.flatMap(result => result.type === "return" ? result.value : [])
        .filter(row => row.canonical === identity.canonical);
      expect(targetPins.length).toBeGreaterThanOrEqual(3);
      for (const row of targetPins) expect([row.volumeSerial, row.fileId]).toEqual([identity.volumeSerial, identity.fileId]);
    } finally { grant.release(); }
    expect(runtime.revokeWindowsAcl).toHaveBeenCalled();
  });

  it.each(["drive", "machine", "workspace-ancestor", "home-ancestor", "protected"])("refuses a junction to a %s target", async kind => {
    const destination = kind === "drive" ? parse(fixture).root : kind === "machine" ? process.env.ProgramData! : kind === "workspace-ancestor" ? dirname(process.cwd())
      : kind === "home-ancestor" ? dirname(aveHome()) : join(aveHome(), "secrets");
    if (kind === "protected") mkdirSync(destination, { recursive: true });
    const link = join(fixture, "link");
    symlinkSync(destination, link, "junction");
    await initializeAsrtSandbox({});
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [link], allowWrite: [link] })).rejects.toThrow(/root|ancestor|protected|sensitive/i);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each(["private-helper", "write-floor"])("refuses a resolved target inside the %s boundary", async kind => {
    const destination = kind === "write-floor" ? join(fixture, "profile", ".config") : target;
    mkdirSync(destination, { recursive: true });
    if (kind === "private-helper") vi.spyOn(integrity, "srtWinPrivateDirectories").mockReturnValue([join(target, "bin")]);
    const link = join(fixture, "link");
    symlinkSync(destination, link, "junction");
    await initializeAsrtSandbox({});
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [link] })).rejects.toThrow(/private helper|protected|sensitive/i);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("batches every resolved target in each effect-boundary pin", async () => {
    const other = join(fixture, "other");
    mkdirSync(other);
    const link = join(fixture, "link");
    symlinkSync(target, link, "junction");
    await initializeAsrtSandbox({});
    const pin = vi.spyOn(facts, "pinWindowsPaths");
    const granted = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [link, other] });
    try {
      const expected = [realpathSync.native(target), realpathSync.native(other)];
      expect(pin.mock.calls.slice(-2)).toEqual([[expected], [expected]]);
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: expected, write: expected }));
    } finally { granted.release(); }
  });

  it("resolves a junction ancestor before granting a descendant", async () => {
    const child = join(target, "child");
    mkdirSync(child);
    const link = join(fixture, "link");
    symlinkSync(target, link, "junction");
    await initializeAsrtSandbox({});
    const granted = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [join(link, "child")] });
    try {
      expect(granted.allowRead).toEqual([realpathSync.native(child)]);
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: [realpathSync.native(child)], write: [] }));
    } finally { granted.release(); }
  });

  it.each([false, true])("checks every link in a junction chain, protected=%s", async protectedTarget => {
    const destination = protectedTarget ? join(aveHome(), "secrets") : target;
    mkdirSync(destination, { recursive: true });
    const intermediate = join(fixture, "intermediate");
    const link = join(fixture, "link");
    symlinkSync(destination, intermediate, "junction");
    symlinkSync(intermediate, link, "junction");
    await initializeAsrtSandbox({});
    const pins = vi.spyOn(facts, "pinWindowsPaths");
    const granting = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [link] });
    if (protectedTarget) await expect(granting).rejects.toThrow(/protected|sensitive/);
    else {
      const grant = await granting;
      expect(grant.allowRead).toEqual([realpathSync.native(destination)]);
      grant.release();
    }
    expect(pins.mock.calls.some(([paths]) => paths.includes(intermediate))).toBe(true);
  });

  it("refuses a missing requested target instead of omitting the grant", async () => {
    await initializeAsrtSandbox({});
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [join(target, "missing")] })).rejects.toThrow(/identity.*unproven/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("checks overlapping deny patterns against the resolved target", async () => {
    const link = join(fixture, "link");
    symlinkSync(target, link, "junction");
    await initializeAsrtSandbox({ denyWrite: [join(target, "*.secret")] });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [link] })).rejects.toThrow(/glob/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each(["relative", "C:\\", "C:\\single", "\\\\host\\share\\folder", "\\\\?\\C:\\fixture\\folder", "\\\\.\\C:\\fixture\\folder"])("refuses unsupported grant grammar %s", async path => {
    await initializeAsrtSandbox({});
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [path] })).rejects.toThrow(/literal|absolute|root|component/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])("revokes when the target is replaced %s the native write", async when => {
    await initializeAsrtSandbox({});
    const swap = () => { renameSync(target, join(fixture, "original")); mkdirSync(target); };
    if (when === "during") vi.mocked(runtime.grantWindowsAcl).mockImplementation(swap);
    else {
      const pin = facts.pinWindowsPaths;
      let captured = false;
      vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => {
        const rows = pin(paths);
        if (!captured && paths.includes(target)) { captured = true; swap(); }
        return rows;
      });
    }
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] })).rejects.toThrow(target);
    expect(runtime.revokeWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ holderPid: process.pid + 1 }));
  });

  it("keeps junction deny evidence unproven and refuses an overlapping grant", async () => {
    const link = join(target, "denied");
    symlinkSync(join(fixture, "profile"), link, "junction");
    expect(() => denyAcl.readWindowsDenyAcls([link], "S-1-5-21-1001")).toThrow(/verification/);
    await initializeAsrtSandbox({ denyRead: [link], denyWrite: [link] });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] })).rejects.toThrow(/verification/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("keeps a profile junction read-deny row and exposes unproven evidence", async () => {
    const link = join(fixture, "profile", "denied");
    symlinkSync(target, link, "junction");
    const evidence = await readWindowsReadDenyEvidence([link]);
    expect(evidence.get(windowsReadDenyKey(link))?.status).toBe("reparse");
    const built = buildSandboxConfig({ denyRead: [link] }, evidence);
    expect(built.filesystem.denyRead.map(row => typeof row === "string" ? row : row.path)).toContain(link);
  });

  it("returns a visible home privacy error for a junction", () => {
    const link = join(fixture, "home-link");
    symlinkSync(target, link, "junction");
    expect(readWindowsDirectoryDacls([link])).toEqual([expect.objectContaining({ path: link, category: "reparse-point", error: expect.any(String) })]);
  });

  it("refuses an administrative policy below a junction with a visible trust error", async () => {
    writeFileSync(join(target, "policy.json"), '{"version":1}');
    const link = join(fixture, "policy-link");
    symlinkSync(target, link, "junction");
    await expect(readWindowsAdminPolicy(join(link, "policy.json"))).rejects.toThrow(/untrusted policy/);
  });
});
