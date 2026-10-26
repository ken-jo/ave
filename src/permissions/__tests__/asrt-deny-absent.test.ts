import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join, sep } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import * as sandboxUtils from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import * as evidence from "../../shared/windows-read-deny-evidence.js";
import * as srtWinIntegrity from "../srt-win-integrity.js";
import * as denyAcl from "../windows-deny-acl.js";
import {
  buildPerCommandSandboxCustomConfig, buildSandboxConfig, grantWindowsWorkerFilesystemAccess,
  initializeAsrtSandbox, isAsrtSandboxActive, registerWorkerUnixSocketDir,
  resetAsrtSandbox, unregisterWorkerUnixSocketDir, wrapTerminalCommand, wrapToolCommand, wrapWorkerCommand,
} from "../asrt-sandbox.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

vi.mock("@anthropic-ai/sandbox-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>()),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js")>()),
}));

useVerifiedAveHomePrivacy();

describe.runIf(process.platform === "win32")("Windows deny target handoff", () => {
  let root: string;
  let profile: string;
  let config: SandboxRuntimeConfig | undefined;
  const manager = runtime.SandboxManager;

  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), "deny-absent-"));
    profile = join(root, "profile");
    mkdirSync(profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.spyOn(os, "homedir").mockReturnValue(profile);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    vi.spyOn(srtWinIntegrity, "prepareSrtWinExecutable").mockImplementation(source => source);
    const expand = sandboxUtils.expandWindowsEnvRefs;
    const runtimeHome = expand("%USERPROFILE%");
    vi.spyOn(sandboxUtils, "expandWindowsEnvRefs").mockImplementation(path => expand(path).replace(runtimeHome, profile));
    vi.spyOn(evidence, "readWindowsReadDenyEvidence").mockImplementation(async paths =>
      new Map(paths.map(path => [evidence.windowsReadDenyKey(path), { status: "error" as const, reason: "probe failed" }])));
    config = undefined;
    vi.spyOn(runtime, "getWindowsSandboxUserStatus").mockReturnValue({
      provisioned: true, credPresent: true, sid: "S-1-5-21-1001",
    } as ReturnType<typeof runtime.getWindowsSandboxUserStatus>);
    vi.spyOn(runtime, "grantWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "revokeWindowsAcl").mockReturnValue([]);
    vi.spyOn(runtime, "stampWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "restoreWindowsAcl").mockReturnValue([]);
    vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK,
      parentMask: 0x40, directory: false,
    })));
  });

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function captureRuntime() {
    vi.spyOn(manager, "initialize").mockImplementation(async next => { config = next; });
    vi.spyOn(manager, "getConfig").mockImplementation(() => config);
    vi.spyOn(manager, "updateConfig").mockImplementation(next => { config = next; });
    vi.spyOn(manager, "reset").mockImplementation(async () => { config = undefined; });
    return vi.spyOn(manager, "wrapWithSandboxArgv").mockResolvedValue({ argv: ["echo"], env: {} });
  }

  function paths(entries: readonly runtime.FilesystemPathEntry[] | undefined): string[] {
    return (entries ?? []).map(entry => (typeof entry === "string" ? entry : entry.path).replace(/[\\/]+$/, ""));
  }

  it("preserves machine read protection when a parent receives a write grant", async () => {
    captureRuntime();
    const machine = join(root, "machine");
    const grant = join(machine, "Ave");
    mkdirSync(grant, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({
        denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
    } finally { held.release(); }
  });

  it("refuses a write envelope containing an initially unmatched deny glob", async () => {
    captureRuntime();
    const grant = join(root, "workspace");
    mkdirSync(grant);
    const pattern = join(grant, "*.secret");
    await initializeAsrtSandbox({ denyRead: [pattern], denyWrite: [pattern] });
    writeFileSync(join(grant, "new.secret"), "secret");
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/glob/i);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("includes wrap-only machine read rows in native protection before granting writes", async () => {
    captureRuntime();
    const machine = join(root, "machine");
    const grant = join(machine, "Ave");
    mkdirSync(grant, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({});
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [target] } });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ denyRead: expect.arrayContaining([target]) }));
    } finally { held.release(); }
  });

  it("refuses a successful stamp that leaves an absent target unprotected", async () => {
    captureRuntime();
    const grant = join(root, "unverifiable");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/verif|DACL/i);
    expect(runtime.stampWindowsAcl).toHaveBeenCalled();
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(wrapToolCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
    await expect(wrapWorkerCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
  });

  it("unions native read protection with a write-only policy row", async () => {
    captureRuntime();
    const grant = join(root, "native-union");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyWrite: [target] });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ denyRead: expect.arrayContaining([target]) }));
      expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
      expect(vi.mocked(denyAcl.readWindowsDenyAcls).mock.invocationCallOrder[1])
        .toBeLessThan(vi.mocked(runtime.grantWindowsAcl).mock.invocationCallOrder[0]!);
    } finally { held.release(); }
  });

  it("runs concurrent grants one read-stamp-verify turn at a time", async () => {
    captureRuntime();
    const grant = join(root, "concurrent");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    const order: string[] = [];
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => {
      order.push("read");
      return paths.map(() => ({
        denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
      }));
    });
    vi.mocked(runtime.stampWindowsAcl).mockImplementation(() => { order.push("stamp"); });
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { order.push("grant"); });
    const held = await Promise.all([1, 2].map(offset =>
      grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + offset, allowWrite: [grant] })));
    try {
      expect(order).toEqual(["read", "stamp", "read", "grant", "read", "stamp", "read", "grant"]);
    } finally { for (const entry of held) entry.release(); }
  });

  it.each(["literal", "glob"])("refuses a %s obligation registered during readback", async kind => {
    captureRuntime();
    const workspace = join(root, "late-obligation");
    mkdirSync(workspace);
    const initial = join(workspace, "initial");
    const late = join(workspace, kind === "glob" ? "*.secret" : "late-secret");
    await initializeAsrtSandbox({ denyRead: [initial] });
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let wrapping: Promise<unknown> | undefined;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(paths => {
      wrapping = wrapToolCommand("echo late", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [late] } });
      return read(paths, "S-1-5-21-1001");
    });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] }))
      .rejects.toThrow(/obligation|glob|changed/i);
    await wrapping;
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("does not yield between obligation readback and the native grant", async () => {
    captureRuntime();
    const workspace = join(root, "atomic-turn");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [join(workspace, "secret")] });
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let yielded = false;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(paths => {
      queueMicrotask(() => { yielded = true; });
      return read(paths, "S-1-5-21-1001");
    });
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { expect(yielded).toBe(false); });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] });
    held.release();
    expect(yielded).toBe(true);
  });

  it("refuses a reset during final readback without publishing old grants", async () => {
    captureRuntime();
    const workspace = join(root, "reset-readback");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [join(workspace, "secret")] });
    vi.mocked(manager.updateConfig).mockClear();
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let resetting: Promise<void> | undefined;
    vi.mocked(denyAcl.readWindowsDenyAcls)
      .mockImplementationOnce(read)
      .mockImplementationOnce(paths => {
        resetting = resetAsrtSandbox();
        return read(paths, "S-1-5-21-1001");
      });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] }))
      .rejects.toThrow(/reset|session/i);
    await resetting;
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it.each([wrapToolCommand, wrapWorkerCommand])("refuses a waiting wrap when deny verification seals its session %#", async wrap => {
    const wrapped = captureRuntime();
    const workspace = join(root, "seal-evidence");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target] });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(evidence.readWindowsReadDenyEvidence).mockImplementationOnce(async () => {
      entered();
      await wait;
      return new Map();
    });
    const pending = wrap("echo waiting", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [join(profile, "late-evidence")] } });
    await reading;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] }))
      .rejects.toThrow(/verification/);
    wrapped.mockClear();
    release();
    await expect(pending).rejects.toThrow(/reset the sandbox session/);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it("verifies a partial stamp failure before refusing access without releasing the session", async () => {
    captureRuntime();
    const grant = join(root, "partial-union");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(runtime.stampWindowsAcl).mockImplementation(() => { throw new Error("Fixture partial stamp"); });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow("Fixture partial stamp");
    expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("refuses the session when a partial stamp loses native read protection", async () => {
    captureRuntime();
    const grant = join(root, "lost-read");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(runtime.stampWindowsAcl).mockImplementation(() => { throw new Error("Fixture partial stamp"); });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    }))).mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/reset the sandbox session/);
    await expect(wrapToolCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("keeps write-only protection readable when native state has no stronger deny", async () => {
    captureRuntime();
    const grant = join(root, "write-only");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    })));
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(vi.mocked(runtime.stampWindowsAcl).mock.calls.at(-1)?.[0].denyRead).not.toContain(target);
      expect(vi.mocked(runtime.stampWindowsAcl).mock.calls.at(-1)?.[0].denyWrite).toContain(target);
    } finally { held.release(); }
  });

  it.each([
    { denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false },
    { denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0, directory: false },
    { denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: true },
  ])("refuses insufficient native deny evidence %#", async native => {
    captureRuntime();
    const grant = join(root, "insufficient");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => native));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/verification/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("stamps newly reachable denies for the session before granting a worker write", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "later-write");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({
        holderPid: process.pid, denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
      expect(vi.mocked(runtime.stampWindowsAcl).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(runtime.grantWindowsAcl).mock.invocationCallOrder[0]!);
      expect(manager.updateConfig).toHaveBeenCalledTimes(1);
      expect(paths(config?.filesystem.denyRead)).toContain(target);
      expect(paths(config?.filesystem.denyWrite)).toContain(target);
      await wrapToolCommand("echo after", { commandId: TEST_COMMAND_ID });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
    } finally {
      held.release();
    }
    expect(manager.updateConfig).toHaveBeenCalledTimes(2);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("refuses a write grant when deny stamping fails without releasing session protection", async () => {
    captureRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const grant = join(profile, "failed-write");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(runtime.stampWindowsAcl).mockImplementation(() => { throw new Error("Fixture stamp failure"); });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow("Fixture stamp failure");
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
    expect(manager.updateConfig).not.toHaveBeenCalled();
    expect(warning.mock.calls.filter(call => call.some(value => String(value).includes("Fixture stamp failure")))).toHaveLength(1);
  });

  it("protects an absent deny supplied only by an earlier wrap before a later write grant", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "wrap-only");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({});
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [target], denyWrite: [target] } });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({
        holderPid: process.pid, denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
    } finally {
      held.release();
    }
  });

  it("protects a previously omitted target that appears before a later write grant", async () => {
    const wrap = captureRuntime();
    const grant = join(root, "later-created");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    writeFileSync(target, "created outside the sandbox");
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(runtime.stampWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({
        holderPid: process.pid, denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
    } finally {
      held.release();
    }
  });

  it("retains absent machine policy rows with absolute home and environment spellings", () => {
    const machine = join(root, "machine");
    mkdirSync(join(machine, "Ave"), { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const absolute = join(machine, "Ave", "missing-policy.json");
    for (const target of [absolute, "~/../machine/Ave/missing-policy.json", "%USERPROFILE%/../machine/Ave/missing-policy.json"]) {
      const read = buildSandboxConfig({ denyRead: [target] });
      const write = buildSandboxConfig({ allowRead: [join(machine, "Ave")], denyWrite: [target] });
      expect(read.filesystem.denyRead).toContain(target);
      expect(write.filesystem.denyWrite).toContain(target);
    }
  });

  it("drops absent read and write rows despite failed evidence and keeps existing rows at initialization", async () => {
    captureRuntime();
    const present = join(profile, "nested", "present");
    const absent = join(profile, "nested", "absent");
    mkdirSync(join(profile, "nested"));
    writeFileSync(present, "secret");
    await initializeAsrtSandbox({ denyRead: [present, absent], denyWrite: [present, absent], allowRead: [profile] });
    expect(paths(config?.filesystem.denyRead)).toContain(present);
    expect(paths(config?.filesystem.denyWrite)).toContain(present);
    expect(paths(config?.filesystem.denyRead)).not.toContain(absent);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(absent);
  });

  it("drops a row deleted after the snapshot at a tool wrap with no filesystem override", async () => {
    const wrap = captureRuntime();
    const target = join(profile, "nested", "secret");
    mkdirSync(join(profile, "nested"));
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target], allowRead: [profile] });
    rmSync(target);
    await wrapToolCommand("echo absent", { commandId: TEST_COMMAND_ID });
    const filesystem = wrap.mock.calls.at(-1)?.[2]?.filesystem;
    expect(filesystem?.denyRead).toBeDefined();
    expect(filesystem?.denyWrite).toBeDefined();
    expect(paths(filesystem?.denyRead)).not.toContain(target);
    expect(paths(filesystem?.denyWrite)).not.toContain(target);
    writeFileSync(target, "recreated");
    await wrapToolCommand("echo present", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
  });

  it("reports absent at stamp time only once per path in a session", async () => {
    captureRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = join(root, "absent");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    await wrapToolCommand("echo first", { commandId: TEST_COMMAND_ID });
    await wrapToolCommand("echo second", { commandId: TEST_COMMAND_ID });
    const rows = () => warning.mock.calls.filter(call => call.some(value =>
      typeof value === "string" && value.includes(target) && value.includes("absent at stamp time")));
    expect(rows()).toHaveLength(1);
    await resetAsrtSandbox();
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    expect(rows()).toHaveLength(2);
  });

  it("drops absent rows at worker and terminal restatements", async () => {
    const wrap = captureRuntime();
    const target = join(root, "absent");
    await initializeAsrtSandbox({});
    const filesystem = { denyRead: [target], denyWrite: [target] };
    await wrapWorkerCommand("echo absent", { commandId: TEST_COMMAND_ID, filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    await wrapTerminalCommand("echo absent", { commandId: TEST_COMMAND_ID, ownTty: "fixture-tty", filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
  });

  it("rechecks session updates when worker socket holders change", async () => {
    captureRuntime();
    const target = join(root, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    rmSync(target);
    const holder = {};
    const socket = join(root, "socket");
    await registerWorkerUnixSocketDir(socket, holder);
    expect(paths(config?.filesystem.denyRead)).not.toContain(target);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    writeFileSync(target, "recreated");
    await unregisterWorkerUnixSocketDir(socket, holder);
    expect(paths(config?.filesystem.denyRead)).toContain(target);
    expect(paths(config?.filesystem.denyWrite)).toContain(target);
  });

  it("filters an alternate home anchor without dropping existing targets", () => {
    const home = join(root, "alternate");
    mkdirSync(join(home, ".config"), { recursive: true });
    vi.stubEnv("HOME", home);
    const present = join(home, ".config", "curlrc");
    const absent = join(home, ".curlrc");
    writeFileSync(present, "secret");
    const next = buildSandboxConfig({});
    expect(paths(next.filesystem.denyRead)).toContain(present);
    expect(paths(next.filesystem.denyWrite)).toContain(present);
    expect(paths(next.filesystem.denyRead)).not.toContain(absent);
    expect(paths(next.filesystem.denyWrite)).not.toContain(absent);
  });

  it("keeps writable literal targets and dangling directory links without following them", () => {
    const workspace = join(root, "workspace[1]");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const present = join(workspace, ".bashrc");
    writeFileSync(present, "secret");
    const link = join(root, "dangling");
    symlinkSync(join(root, "missing-directory"), link, "junction");
    const absent = join(workspace, ".git", "modules");
    const next = buildSandboxConfig({ allowWrite: [workspace], denyRead: [link + sep], denyWrite: [link + sep] });
    expect(paths(next.filesystem.denyRead)).toContain(link);
    expect(next.filesystem.denyWrite).toContainEqual({ path: present, literal: true });
    expect(paths(next.filesystem.denyWrite)).toContain(link);
    expect(next.filesystem.denyWrite).toContainEqual({ path: absent, literal: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("keeps glob and UNC expansion at the runtime boundary", () => {
    const glob = join(root, "missing-*");
    const unc = "\\\\fixture-server\\fixture-share\\missing";
    const next = buildSandboxConfig({ denyRead: [glob, unc], denyWrite: [glob, unc] });
    expect(next.filesystem.denyRead).toContain(glob);
    expect(next.filesystem.denyRead).toContain(unc);
    expect(next.filesystem.denyWrite).toContain(glob);
    expect(next.filesystem.denyWrite).toContain(unc);
  });

  it("does not let a concurrent bracket grant retain unrelated rows while protecting its reachable rows", async () => {
    const wrap = captureRuntime();
    const unrelated = join(profile, ".curlrc");
    const grant = join(profile, "work[1]");
    const shared = join(profile, "shared");
    const protectedTarget = join(shared, "secret");
    const absent = join(shared, "absent");
    mkdirSync(grant);
    mkdirSync(shared);
    writeFileSync(unrelated, "private");
    writeFileSync(protectedTarget, "secret");
    await initializeAsrtSandbox({});
    const filesystem = { denyRead: [unrelated, protectedTarget, absent], denyWrite: [unrelated, protectedTarget, absent] };
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID, filesystem });
    const before = wrap.mock.calls.at(-1)?.[2]?.filesystem;
    expect(paths(before?.denyWrite)).not.toContain(protectedTarget);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant], allowWrite: [shared] });
    try {
      await Promise.all([
        wrapToolCommand("echo one", { commandId: TEST_COMMAND_ID, filesystem }),
        wrapWorkerCommand("echo two", { commandId: TEST_COMMAND_ID, filesystem }),
      ]);
      const concurrent = wrap.mock.calls.slice(-2).map(call => call[2]?.filesystem);
      for (const next of concurrent) {
        expect(paths(next?.denyRead)).not.toContain(unrelated);
        expect(paths(next?.denyWrite)).not.toContain(unrelated);
        expect(paths(next?.denyRead)).toContain(protectedTarget);
        expect(paths(next?.denyWrite)).toContain(protectedTarget);
        expect(paths(next?.denyRead)).toContain(absent);
        expect(paths(next?.denyWrite)).toContain(absent);
      }
      expect(paths(before?.denyRead)).not.toContain(unrelated);
    } finally {
      held.release();
    }
    await wrapToolCommand("echo released", { commandId: TEST_COMMAND_ID, filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(absent);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(absent);
  });

  it("keeps absent read and write denies reached by session and caller write grants", async () => {
    const wrap = captureRuntime();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    await initializeAsrtSandbox({ allowWrite: [workspace], denyRead: [target], denyWrite: [target] });
    expect(paths(config?.filesystem.denyRead)).toContain(target);
    expect(paths(config?.filesystem.denyWrite)).toContain(target);
    await wrapToolCommand("echo protected", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
    const caller = join(root, "caller");
    mkdirSync(caller);
    const absent = join(caller, "credential");
    const custom = buildPerCommandSandboxCustomConfig({ allowWrite: [caller], denyRead: [target, absent], denyWrite: [target, absent] });
    expect(paths(custom?.filesystem?.denyRead)).toEqual(expect.arrayContaining([target, absent]));
    expect(paths(custom?.filesystem?.denyWrite)).toEqual(expect.arrayContaining([target, absent]));
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("does not let a bracketed session write grant retain unrelated absent denies", async () => {
    captureRuntime();
    const target = join(profile, "unrelated-absent-secret");
    for (const name of ["plain", "work[1]"]) {
      const grant = join(profile, name);
      mkdirSync(grant);
      await initializeAsrtSandbox({ allowWrite: [grant], denyRead: [target], denyWrite: [target] });
      expect(paths(config?.filesystem.denyRead)).not.toContain(target);
      expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
      await resetAsrtSandbox();
    }
  });

  it("drops absent denies beneath a live read-only grant", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "readonly");
    mkdirSync(grant);
    const target = join(grant, "absent-secret");
    await initializeAsrtSandbox({});
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant] });
    try {
      await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID,
        filesystem: { denyRead: [target], denyWrite: [target] } });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    } finally {
      held.release();
    }
  });

  it("keeps absent denies beneath a live write grant until its last writer releases", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "writable");
    mkdirSync(grant);
    const target = join(grant, "absent-secret");
    const filesystem = { denyRead: [target], denyWrite: [target] };
    await initializeAsrtSandbox({});
    const reader = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant] });
    const writer = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    const otherWriter = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    try {
      writer.release();
      await wrapToolCommand("echo writable", { commandId: TEST_COMMAND_ID, filesystem });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
      otherWriter.release();
      await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID, filesystem });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    } finally {
      writer.release();
      otherWriter.release();
      reader.release();
    }
  });

  it("does not carry a live write grant across sandbox reset", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "previous-session");
    mkdirSync(grant);
    const target = join(grant, "absent-secret");
    await initializeAsrtSandbox({});
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    try {
      await resetAsrtSandbox();
      await initializeAsrtSandbox({});
      await wrapToolCommand("echo fresh", { commandId: TEST_COMMAND_ID,
        filesystem: { denyRead: [target], denyWrite: [target] } });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
      const current = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
      try {
        held.release();
        await wrapToolCommand("echo current", { commandId: TEST_COMMAND_ID,
          filesystem: { denyRead: [target], denyWrite: [target] } });
        expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toContain(target);
        expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
      } finally {
        current.release();
      }
    } finally {
      held.release();
    }
  });

  it("drops absent denies reached only by a read grant", async () => {
    const wrap = captureRuntime();
    const target = join(profile, "credential");
    await initializeAsrtSandbox({ allowRead: [profile], denyRead: [target], denyWrite: [target] });
    expect(paths(config?.filesystem.denyRead)).not.toContain(target);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
  });

  it("keeps absent denies reached by uncertain write grant spellings within their static directory", () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    const unrelated = join(root, "unrelated");
    for (const grant of [join(workspace, "part*"), join(workspace, "PART~1")]) {
      const next = buildSandboxConfig({ allowWrite: [grant], denyRead: [target, unrelated], denyWrite: [target, unrelated] });
      expect(paths(next.filesystem.denyRead)).toContain(target);
      expect(paths(next.filesystem.denyWrite)).toContain(target);
      expect(paths(next.filesystem.denyRead)).not.toContain(unrelated);
      expect(paths(next.filesystem.denyWrite)).not.toContain(unrelated);
    }
  });

  it("keeps absent denies reached by home and environment write grant spellings", () => {
    const workspace = join(profile, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    for (const grant of ["~/workspace", "%USERPROFILE%/workspace"]) {
      const next = buildSandboxConfig({ allowWrite: [grant], denyRead: [target], denyWrite: [target] });
      expect(paths(next.filesystem.denyRead)).toContain(target);
      expect(paths(next.filesystem.denyWrite)).toContain(target);
    }
  });

  it("keeps denies and wraps successfully when target stat fails with EACCES or EPERM", async () => {
    const wrap = captureRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = join(root, "access-denied");
    const forbidden = join(root, "operation-forbidden");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (String(path) === denied) throw Object.assign(new Error("Fixture stat failure"), { code: "EACCES" });
      if (String(path) === forbidden) throw Object.assign(new Error("Fixture stat failure"), { code: "EPERM" });
      return actual.lstatSync(path, options);
    }) as typeof lstatSync);
    await initializeAsrtSandbox({ denyRead: [denied, forbidden], denyWrite: [denied, forbidden] });
    expect(paths(config?.filesystem.denyRead)).toEqual(expect.arrayContaining([denied, forbidden]));
    expect(paths(config?.filesystem.denyWrite)).toEqual(expect.arrayContaining([denied, forbidden]));
    await wrapToolCommand("echo first", { commandId: TEST_COMMAND_ID });
    await wrapToolCommand("echo second", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toEqual(expect.arrayContaining([denied, forbidden]));
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toEqual(expect.arrayContaining([denied, forbidden]));
    expect(warning.mock.calls.filter(call => call.some(value => typeof value === "string" && value.includes(denied) && value.includes("EACCES")))).toHaveLength(1);
    expect(warning.mock.calls.filter(call => call.some(value => typeof value === "string" && value.includes(forbidden) && value.includes("EPERM")))).toHaveLength(1);
  });

  it("hands off the absent protective git leaf beneath a writable workspace", async () => {
    const wrap = captureRuntime();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, ".git");
    await initializeAsrtSandbox({ allowWrite: [workspace] });
    expect(paths(config?.filesystem.denyWrite)).toContain(target);
    await wrapToolCommand("echo protected", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  });

});
