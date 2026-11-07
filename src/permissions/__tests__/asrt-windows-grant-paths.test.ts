import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeAveHomeFixture, useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { removeLinksUnder } from "../../__tests__/support/tmp-dir-teardown.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { configureHostResources } from "../../main/host-resources.js";
import { aveHome, readWindowsDirectoryDacls } from "../../shared/ave-home.js";
import { readWindowsAdminPolicy } from "../../shared/windows-admin-policy.js";
import * as facts from "../../shared/windows-path-facts.js";
import { readWindowsReadDenyEvidence, windowsReadDenyKey } from "../../shared/windows-read-deny-evidence.js";
import * as integrity from "../srt-win-integrity.js";
import * as denyAcl from "../windows-deny-acl.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import * as defaultWorkspace from "../../main/default-workspace-root.js";
import { ConversationLoop } from "../../engine/conversation-loop.js";
import { makeBasicConversationLoopDeps } from "../../engine/__tests__/support/conversation-loop-fixtures.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { buildSandboxConfig, grantWindowsWorkerFilesystemAccess, initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";

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
    const profile = join(fixture, "alice");
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
    vi.spyOn(runtime, "revokeWindowsAcl").mockImplementation(({ holderPid }) =>
      [...new Set(vi.mocked(runtime.grantWindowsAcl).mock.calls
        .filter(([call]) => call.holderPid === holderPid).flatMap(([call]) => call.read ?? []))]
        .map(path => ({ path, status: "revoked" as const })));
    vi.spyOn(runtime, "stampWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "restoreWindowsAcl").mockReturnValue([]);
    vi.spyOn(runtime.SandboxManager, "initialize").mockImplementation(async next => { config = next; });
    vi.spyOn(runtime.SandboxManager, "getConfig").mockImplementation(() => config);
    vi.spyOn(runtime.SandboxManager, "updateConfig").mockImplementation(next => { config = next; });
    vi.spyOn(runtime.SandboxManager, "reset").mockImplementation(async () => { config = undefined; return { windowsAclUnreleased: [] }; });
  });

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    removeLinksUnder(fixture);
    rmSync(fixture, { recursive: true, force: true });
  });

  it.each([0, 5000, 5001])("logs numeric grant and release timings without identities at %s ms", async duration => {
    await initializeAsrtSandbox({ denyRead: [join(target, "denied")] });
    vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
    })));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { now += duration; });
    const revoke = vi.mocked(runtime.revokeWindowsAcl).getMockImplementation()!;
    vi.mocked(runtime.revokeWindowsAcl).mockImplementation(options => { now += duration; return revoke(options); });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] });
    grant.release();
    grant.release();
    const turnLines = info.mock.calls.filter(([message]) => message === "[asrt-sandbox] windows grant turn timing");
    const releaseLines = info.mock.calls.filter(([message]) => message === "[asrt-sandbox] windows grant release timing");
    expect(turnLines).toHaveLength(1);
    expect(releaseLines).toHaveLength(1);
    expect(turnLines[0]![1]).toEqual({
      userStatusMs: 0, pinsMs: 0, denyReadMs: 0, stampMs: 0, assertMs: 0, grantMs: duration, totalMs: duration, rows: expect.any(Number),
    });
    expect(turnLines[0]![1].rows).toBeGreaterThan(0);
    expect(releaseLines[0]![1]).toEqual({ revokeMs: duration, totalMs: duration });
    for (const [, fields] of [...turnLines, ...releaseLines]) {
      for (const value of Object.values(fields)) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(fields)).not.toContain(target);
      expect(JSON.stringify(fields)).not.toMatch(/[\\/]/);
    }
    const warnings = warn.mock.calls.filter(([message]) => /windows grant (turn|release) timing/.test(String(message)));
    expect(warnings).toHaveLength(duration > 5000 ? 2 : 0);
    if (duration > 5000) expect(warnings).toEqual([...turnLines, ...releaseLines]);
  });

  it("logs elapsed grant time when the native grant throws", async () => {
    await initializeAsrtSandbox({});
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { now += 6000; throw new Error("grant interrupted"); });
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue([{ path: target, status: "revoked" }]);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] })).rejects.toThrow("grant interrupted");
    expect(info).toHaveBeenCalledWith("[asrt-sandbox] windows grant turn timing", expect.objectContaining({ grantMs: 6000, totalMs: 6000 }));
    expect(warn).toHaveBeenCalledWith("[asrt-sandbox] windows grant turn timing", expect.objectContaining({ grantMs: 6000, totalMs: 6000 }));
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
    const destination = kind === "write-floor" ? join(fixture, "alice", ".config") : target;
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
      expect(pin.mock.calls.filter(([paths]) => paths.some(path => expected.includes(path))).slice(-2)).toEqual([[expected], [expected]]);
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: expected, write: expected }));
    } finally { granted.release(); }
  });

  it("refuses a queued turn that is no longer valid when it starts, before its holder or any ACL change, and runs the next turn", async () => {
    await initializeAsrtSandbox({});
    const started: number[] = [];
    const holder = (pid: number) => () => { started.push(pid); return pid; };
    let valid = true;
    const ahead = grantWindowsWorkerFilesystemAccess({ holderPid: holder(process.pid + 1), allowRead: [target] });
    const abandoned = grantWindowsWorkerFilesystemAccess({ holderPid: holder(process.pid + 2), allowRead: [target],
      assertStillValid: () => { if (!valid) throw new Error("plugin-factory-deadline-passed"); } });
    const next = grantWindowsWorkerFilesystemAccess({ holderPid: holder(process.pid + 3), allowRead: [target] });
    // Valid when queued; abandoned before its turn starts.
    valid = false;
    const settled = await Promise.allSettled([ahead, abandoned, next]);
    try {
      expect(settled.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect((settled[1] as PromiseRejectedResult).reason).toMatchObject({ message: "plugin-factory-deadline-passed" });
      expect(started).toEqual([process.pid + 1, process.pid + 3]);
      expect(vi.mocked(runtime.grantWindowsAcl).mock.calls.map(([call]) => call.holderPid)).toEqual([process.pid + 1, process.pid + 3]);
    } finally {
      for (const result of settled) if (result.status === "fulfilled") result.value.release();
    }
  });

  it("starts no holder for a turn refused by a later check", async () => {
    await initializeAsrtSandbox({});
    const started: number[] = [];
    vi.mocked(runtime.getWindowsSandboxUserStatus).mockReturnValueOnce({ provisioned: false, credPresent: false } as ReturnType<typeof runtime.getWindowsSandboxUserStatus>);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: () => { started.push(process.pid + 1); return process.pid + 1; }, allowRead: [target] }))
      .rejects.toThrow("Windows sandbox user is not provisioned");
    expect(started).toEqual([]);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each([false, true])("grants and rechecks distinct case-only objects with correct compensation, replaced=%s", async replaced => {
    await initializeAsrtSandbox({});
    const nativePin = facts.pinWindowsPaths;
    const template = nativePin([target])[0]!;
    const paths = [join(fixture, "Foo"), join(fixture, "foo")];
    const ids = ["0x00000000000000000000000000000001", "0x00000000000000000000000000000002"];
    let swapped = false;
    const pin = vi.spyOn(facts, "pinWindowsPaths").mockImplementation(requests => requests.map(path => {
      const index = paths.indexOf(path);
      return index < 0 ? nativePin([path])[0]! : { ...template, canonical: path,
        fileId: swapped && index === 1 ? "0x00000000000000000000000000000003" : ids[index]! };
    }));
    const holderPid = process.pid + 1;
    const held = new Map<string, string>();
    const revokedIds: string[] = [];
    vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(({ read }) => {
      for (const path of read ?? []) held.set(ids[paths.indexOf(path)]!, path);
      swapped = replaced;
    });
    vi.mocked(runtime.revokeWindowsAcl).mockImplementationOnce(({ holderPid: revokedHolder }) => {
      expect(revokedHolder).toBe(holderPid);
      const outcome = [...held].map(([id, path]) => {
        revokedIds.push(id);
        return { path, status: "revoked" as const };
      });
      held.clear();
      return outcome;
    });
    const granting = grantWindowsWorkerFilesystemAccess({ holderPid, allowWrite: paths });
    if (replaced) await expect(granting).rejects.toThrow(/identity changed/);
    else {
      const grant = await granting;
      expect(grant.allowWrite).toEqual(paths);
      grant.release();
    }
    expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ holderPid, read: paths, write: paths }));
    const targetRequests = pin.mock.calls.filter(([requests]) => requests.some(path => paths.includes(path)));
    expect(targetRequests.filter(([requests]) => requests.length === paths.length).length).toBeGreaterThanOrEqual(3);
    expect(targetRequests.slice(-2)).toEqual([[paths], [paths]]);
    expect(runtime.revokeWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ holderPid }));
    expect(revokedIds).toEqual(ids);
    expect(held.size).toBe(0);
    // Successful compensation leaves confinement usable for a different holder.
    const next = await grantWindowsWorkerFilesystemAccess({ holderPid: holderPid + 1, allowRead: [target] });
    next.release();
  });

  it.each([false, true])("preserves ordered requests for one object through direct and junction spellings, compensate=%s", async compensate => {
    const link = join(fixture, "alias");
    symlinkSync(target, link, "junction");
    await initializeAsrtSandbox({});
    const pin = vi.spyOn(facts, "pinWindowsPaths");
    const canonical = realpathSync.native(target);
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue([{ path: canonical, status: "revoked" }]);
    if (compensate) vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(() => { throw new Error("grant interrupted"); });
    const granting = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1,
      allowRead: [link, target, link], allowWrite: [target] });
    const ordered = [canonical, canonical, canonical, canonical];
    if (compensate) {
      await expect(granting).rejects.toThrow("grant interrupted");
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: ordered, write: [canonical] }));
      const next = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] });
      next.release();
    } else {
      const grant = await granting;
      try {
        expect(grant.allowRead).toEqual(ordered);
        expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ read: ordered, write: [canonical] }));
        expect(pin.mock.calls.filter(([paths]) => paths.includes(canonical)).slice(-2)).toEqual([[ordered], [ordered]]);
      } finally { grant.release(); }
    }
  });

  it.each(["missing", "duplicate", "ambiguous"])("requires distinct cleanup evidence for case-only objects when a ledger row is %s", async kind => {
    await initializeAsrtSandbox({});
    const nativePin = facts.pinWindowsPaths;
    const template = nativePin([target])[0]!;
    const paths = [join(fixture, "Foo"), join(fixture, "foo")];
    vi.spyOn(facts, "pinWindowsPaths").mockImplementation(requests => requests.map(path => {
      const index = paths.indexOf(path);
      return index < 0 ? nativePin([path])[0]! : { ...template, canonical: path,
        fileId: index === 0 ? "0x00000000000000000000000000000001" : "0x00000000000000000000000000000002" };
    }));
    vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(() => { throw new Error("partial grant"); });
    const row = { path: paths[0]!, status: "revoked" as const };
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue(kind === "missing" ? [row]
      : [row, { ...row, path: kind === "duplicate" ? row.path : paths[1]!.toUpperCase() }]);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: paths })).rejects.toThrow(/cleanup failed/);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
    expect(runtime.grantWindowsAcl).toHaveBeenCalledTimes(1);
  });

  it("retains both case-only deny obligations while preparing an overlapping write grant", async () => {
    const paths = [join(target, "Foo"), join(target, "foo")];
    await initializeAsrtSandbox({ denyRead: paths });
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => requests.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
    })));
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenLastCalledWith(expect.objectContaining({ denyRead: expect.arrayContaining(paths) }));
      for (const [requests] of read.mock.calls) expect(requests).toEqual(expect.arrayContaining(paths));
    } finally { grant.release(); }
  });

  it.each(["project", "additional"])("refuses direct and junction ancestors and equality of an authorized %s root", async kind => {
    const ancestor = join(fixture, kind, "team");
    const root = join(ancestor, "repo");
    mkdirSync(root, { recursive: true });
    if (kind === "project") vi.spyOn(defaultWorkspace, "getDefaultWorkspaceRoot").mockReturnValue(root);
    else {
      setFixtureOwner(fixture);
      rmdirSync(aveHome());
      await initializeAveHomeFixture(aveHome());
      writeFileSync(permissionSettingsPath(), JSON.stringify({ permissions: { additionalDirectories: [root] } }));
    }
    const link = join(fixture, "ancestor-link");
    symlinkSync(ancestor, link, "junction");
    await initializeAsrtSandbox({});
    for (const path of [ancestor, link, root]) {
      await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [path] })).rejects.toThrow(/ancestor/);
    }
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each(["undefined", "incomplete", "missing-row", "malformed", "throws"])("contains the session and exposes failed compensation when revoke %s", async outcome => {
    await initializeAsrtSandbox({});
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => {
      renameSync(target, join(fixture, "original"));
      mkdirSync(target);
    });
    const revoke = vi.mocked(runtime.revokeWindowsAcl);
    if (outcome === "throws") revoke.mockImplementation(() => { throw new Error("revoke unavailable"); });
    else if (outcome === "malformed") revoke.mockReturnValue(null as unknown as ReturnType<typeof runtime.revokeWindowsAcl>);
    else revoke.mockReturnValue(outcome === "undefined" ? undefined
      : outcome === "missing-row" ? [{ path: join(fixture, "other"), status: "revoked" }] : [{ path: target, status: "leftChanged" }]);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] })).rejects.toThrow(/cleanup failed/);
    expect(isAsrtSandboxActive()).toBe(true);
    const calls = vi.mocked(runtime.grantWindowsAcl).mock.calls.length;
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
    expect(runtime.grantWindowsAcl).toHaveBeenCalledTimes(calls);
    await expect(wrapToolCommand("echo confined", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/cleanup failed/);
    revoke.mockReturnValue([]);
  });

  it.each(["failed", "throws"])("seals confinement after release revoke %s until sandbox reset", async outcome => {
    await initializeAsrtSandbox({});
    const holderPid = process.pid + 1;
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid, allowRead: [target] });
    const revoke = vi.mocked(runtime.revokeWindowsAcl);
    const cause = new Error("revoke unavailable");
    if (outcome === "throws") revoke.mockImplementationOnce(() => { throw cause; });
    else revoke.mockReturnValueOnce([{ path: target, status: "leftChanged" }]);
    expect(() => grant.release()).not.toThrow();
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] }))
      .rejects.toThrow(`Windows filesystem grant cleanup failed for ${target}; reset the sandbox session`);
    await expect(wrapToolCommand("echo confined", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/cleanup failed/);
    if (outcome === "throws") {
      await expect(grantWindowsWorkerFilesystemAccess({ holderPid, allowRead: [target] })).rejects.toMatchObject({ cause });
    }
    revoke.mockReturnValue([{ path: target, status: "revoked" }]);
    await resetAsrtSandbox();
    await initializeAsrtSandbox({});
    const next = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] });
    next.release();
  });

  it.each(["revoked", "stillHeld", "downgraded", "relocated", "noRow", "restored", "alreadyOriginal", "missing", "mismatch"] as const)("keeps confinement usable after release reports %s", async status => {
    await initializeAsrtSandbox({});
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue([{ path: target, status }]);
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] });
    expect(() => grant.release()).not.toThrow();
    const next = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] });
    next.release();
  });

  it("seals confinement without throwing when release config cleanup fails", async () => {
    await initializeAsrtSandbox({});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] });
    const cause = new Error("config update unavailable");
    vi.mocked(runtime.SandboxManager.updateConfig).mockImplementationOnce(() => { throw cause; });
    expect(() => grant.release()).not.toThrow();
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] }))
      .rejects.toMatchObject({ cause, message: expect.stringContaining("reset the sandbox session") });
  });

  it("resets a sealed release through the runtime and permits new confinement", async () => {
    await initializeAsrtSandbox({});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] });
    const revoke = vi.mocked(runtime.revokeWindowsAcl);
    revoke.mockReturnValueOnce([{ path: target, status: "leftChanged" }]);
    grant.release();
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
    revoke.mockClear();
    revoke.mockReturnValue([]);
    try {
      await expect(resetAsrtSandbox()).resolves.toBeUndefined();
      expect(runtime.SandboxManager.reset).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      expect(isAsrtSandboxActive()).toBe(false);
      await initializeAsrtSandbox({});
      const next = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] });
      next.release();
    } finally {
      revoke.mockReturnValue([{ path: target, status: "revoked" }]);
    }
  });

  it.each([true, false])("judges an empty revoke by its exit on release and compensation, clean=%s", async clean => {
    await initializeAsrtSandbox({});
    const revoke = vi.mocked(runtime.revokeWindowsAcl);
    revoke.mockImplementation(({ onExit }) => { onExit?.(clean); return []; });
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] });
    expect(() => grant.release()).not.toThrow();
    try {
      if (!clean) {
        await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
        return;
      }
      vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(() => { throw new Error("grant unavailable"); });
      await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow("grant unavailable");
      const next = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 3, allowRead: [target] });
      next.release();
    } finally {
      revoke.mockReturnValue([{ path: target, status: "revoked" }]);
    }
  });

  it.each(["revoked", "missing", "leftChanged"] as const)("seals release on a non-zero exit even with %s JSON", async status => {
    await initializeAsrtSandbox({});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] });
    vi.mocked(runtime.revokeWindowsAcl).mockImplementationOnce(({ onExit }) => {
      onExit?.(false);
      return [{ path: target, status }];
    });
    expect(() => grant.release()).not.toThrow();
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
  });

  it("seals release when a clean nonempty result omits a requested path", async () => {
    const other = join(fixture, "other");
    mkdirSync(other);
    await initializeAsrtSandbox({});
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target, other] });
    vi.mocked(runtime.revokeWindowsAcl).mockImplementationOnce(({ onExit }) => {
      onExit?.(true);
      return [{ path: target, status: "revoked" }];
    });
    expect(() => grant.release()).not.toThrow();
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
  });

  it("seals compensation on a non-zero exit even with completed JSON", async () => {
    await initializeAsrtSandbox({});
    vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(() => { throw new Error("grant unavailable"); });
    vi.mocked(runtime.revokeWindowsAcl).mockImplementationOnce(({ onExit }) => {
      onExit?.(false);
      return [{ path: target, status: "revoked" }];
    });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] })).rejects.toThrow(/cleanup failed/);
  });

  it.each(["session", "turn", "project"] as const)("refuses live %s root ancestors and equality directly and through junctions", async scope => {
    const ancestor = join(fixture, scope, "team");
    const root = join(ancestor, "repo");
    mkdirSync(root, { recursive: true });
    const loop = new ConversationLoop(makeBasicConversationLoopDeps());
    await initializeAsrtSandbox({});
    if (scope === "session") loop.addSessionAdditionalDirectory(root);
    else if (scope === "turn") loop.addTurnAdditionalDirectory(root);
    else loop.sessionProjectRoot = root;
    const link = join(fixture, "ancestor-link");
    symlinkSync(ancestor, link, "junction");
    const equalLink = join(fixture, "root-link");
    symlinkSync(root, equalLink, "junction");
    for (const path of [ancestor, link, root, equalLink]) {
      await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [path] })).rejects.toThrow(/ancestor/);
    }
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    // The guard must observe revocation from the same live source too.
    loop.sessionAdditionalDirectories = [];
    loop.turnAdditionalDirectories = [];
    loop.sessionProjectRoot = null;
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [ancestor] });
    grant.release();
  });

  it.each(["revoked", "stillHeld", "downgraded", "relocated", "noRow", "restored", "alreadyOriginal", "missing", "mismatch"] as const)("accepts native extended-path %s compensation without sealing a usable session", async status => {
    await initializeAsrtSandbox({});
    vi.mocked(runtime.grantWindowsAcl).mockImplementationOnce(() => {
      renameSync(target, join(fixture, "original"));
      mkdirSync(target);
    });
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue([{ path: `\\\\?\\${target.toUpperCase()}\\`, status }]);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] })).rejects.toThrow(/identity changed/);
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [target] });
    grant.release();
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
    const pin = vi.spyOn(facts, "pinWindowsPaths");
    const dacl = vi.spyOn(facts, "readWindowsDacls");
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowRead: [path] })).rejects.toThrow(/literal|absolute|root|component/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(dacl).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])("refuses replacement %s the native write and compensates attempted grants", async when => {
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
    if (when === "before") {
      expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
      expect(runtime.revokeWindowsAcl).not.toHaveBeenCalled();
    } else expect(runtime.revokeWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ holderPid: process.pid + 1 }));
  });

  it("keeps junction deny evidence unproven and refuses an overlapping grant", async () => {
    const link = join(target, "denied");
    symlinkSync(join(fixture, "alice"), link, "junction");
    expect(() => denyAcl.readWindowsDenyAcls([link], "S-1-5-21-1001")).toThrow(/verification/);
    await initializeAsrtSandbox({ denyRead: [link], denyWrite: [link] });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [target] })).rejects.toThrow(/verification/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("keeps a profile junction read-deny row and exposes unproven evidence", async () => {
    const link = join(fixture, "alice", "denied");
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
