import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { useScratchLinks, useTempDirs } from "../../__tests__/test-helpers.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { observeWindowsGrantIdentity } from "../../__tests__/support/windows-grant-identity.js";
import * as policyHome from "../../shared/policy-home.js";
import * as integrity from "../srt-win-integrity.js";
import * as writePolicy from "../sandbox-write-policy.js";
import { TEST_COMMAND_ID, TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";

const phase = vi.hoisted(() => ({ before: undefined as (() => void) | undefined, after: undefined as (() => void) | undefined, guarded: false }));
vi.mock("../../shared/ave-home-test-guard.js", async original => ({
  ...await original<typeof import("../../shared/ave-home-test-guard.js")>(),
  get AVE_HOME_ISOLATION_GUARD_ACTIVE() { return phase.guarded; },
}));
vi.mock("../windows-stamp-targets.js", async original => {
  const actual = await original<typeof import("../windows-stamp-targets.js")>();
  return { ...actual, pinWindowsFilesystemConfig: (...args: Parameters<typeof actual.pinWindowsFilesystemConfig>) => {
    phase.before?.();
    const pinned = actual.pinWindowsFilesystemConfig(...args);
    phase.after?.();
    return pinned;
  } };
});
vi.mock("@anthropic-ai/sandbox-runtime", async original => ({
  ...await original<typeof import("@anthropic-ai/sandbox-runtime")>(),
  grantWindowsAcl: vi.fn(), revokeWindowsAcl: vi.fn(),
  getWindowsSandboxUserStatus: vi.fn(() => ({ provisioned: true, credPresent: true, sid: "S-1-5-21-100-200-300-1001" })),
}));

useVerifiedAveHomePrivacy();
const scratch = useTempDirs("filesystem-boundary-");
const link = useScratchLinks();
beforeEach(() => { phase.before = undefined; phase.after = undefined; phase.guarded = false; });
afterEach(async () => {
  phase.before = undefined; phase.after = undefined;
  await (await import("../asrt-sandbox.js")).resetAsrtSandbox();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  syncBuiltinESMExports();
});

async function setup(settings: { allowWrite: string[]; windows: { externalConfinement: true } } = { allowWrite: [], windows: { externalConfinement: true } }) {
  const profile = scratch();
  vi.stubEnv("USERPROFILE", profile); vi.stubEnv("HOME", profile);
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([profile]);
  const executable = join(scratch(), "fixture.exe");
  writeFileSync(executable, "fixture");
  vi.spyOn(integrity, "prepareSrtWinExecutable").mockReturnValue(executable);
  const runtime = await import("@anthropic-ai/sandbox-runtime");
  vi.spyOn(runtime.SandboxManager, "initialize").mockResolvedValue(undefined);
  const update = vi.spyOn(runtime.SandboxManager, "updateConfig").mockImplementation(() => {});
  const sandbox = await import("../asrt-sandbox.js");
  await sandbox.initializeAsrtSandbox(settings);
  vi.mocked(runtime.grantWindowsAcl).mockClear(); update.mockClear();
  return { sandbox, runtime, update };
}

describe.runIf(process.platform === "win32")("pinned filesystem admission boundary", () => {
  for (const guarded of [false, true]) {
    for (const timing of ["before", "after"] as const) {
      it(`refuses swap-${timing}-pinning with identity guard ${guarded}`, async () => {
        phase.guarded = guarded;
        const { sandbox, runtime, update } = await setup();
        const machine = process.env.ProgramData!;
        const target = join(scratch(), "target"); mkdirSync(target);
        phase[timing] = () => {
          phase[timing] = undefined;
          renameSync(target, target + "-original"); link(machine, target);
        };
        await expect(sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [target] }))
          .rejects.toThrow(/reparse|identity changed/);
        expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      });
    }
    it(`refuses a swap after checks before the ACL call with identity guard ${guarded}`, async () => {
      phase.guarded = guarded;
      const { sandbox, runtime, update } = await setup();
      const target = join(scratch(), "target"); mkdirSync(target);
      vi.mocked(runtime.getWindowsSandboxUserStatus).mockImplementationOnce(() => {
        renameSync(target, target + "-original"); link(process.env.ProgramData!, target);
        return { provisioned: true, credPresent: true, sid: "S-1-5-21-100-200-300-1001" } as ReturnType<typeof runtime.getWindowsSandboxUserStatus>;
      });
      await expect(sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [target] }))
        .rejects.toThrow(/reparse|identity changed/);
      expect(runtime.grantWindowsAcl).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    });
  }
  it.each(["allowWrite", "allowRead"] as const)("pins the resolved identity through a reparse ancestor in %s", async list => {
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const target = scratch(); mkdirSync(join(target, "leaf"));
    const alias = link(target, join(scratch(), "alias"));
    const identity = observeWindowsGrantIdentity(join(target, "leaf"));
    const pinned = pinWindowsFilesystemConfig({ [list]: [join(alias, "leaf")] });
    expect(pinned[list]).toEqual([{ path: identity.canonical, literal: true }]);
    const { sandbox, runtime } = await setup();
    vi.mocked(runtime.revokeWindowsAcl).mockReturnValue([{ path: identity.canonical, status: "revoked" }]);
    const grant = await sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, [list]: [join(alias, "leaf")] });
    try {
      expect(runtime.grantWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({
        read: [identity.canonical], write: list === "allowWrite" ? [identity.canonical] : [],
      }));
    } finally { grant.release(); }
    identity.assertPinned();
  });

  it.each(["allowWrite", "allowRead"] as const)("refuses a guarded resolved target through a reparse ancestor in %s", async list => {
    phase.guarded = true;
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const alias = link(inject("realAccountHome"), join(scratch(), "alias"));
    expect(() => pinWindowsFilesystemConfig({ [list]: [join(alias, "missing", "leaf")] }))
      .toThrow(/constrain the test's deny\/allow targets to fixtures/);
  });

  it.each(["denyRead", "denyWrite"] as const)("keeps uncertain %s rows outside grant admission", async list => {
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const alias = link(scratch(), join(scratch(), "alias"));
    const rows = [join(alias, "missing"), join(scratch(), "OTHER~1", "locked"), join(scratch(), "*")];
    const pinned = pinWindowsFilesystemConfig<Partial<import("@anthropic-ai/sandbox-runtime").FilesystemConfig>>({ [list]: rows });
    expect(pinned[list]).toBe(rows);
    expect(pinned.allowRead).toEqual([]);
    expect(pinned.allowWrite).toEqual([]);
  });

  it("derives control-file denies from the pinned canonical grant", async () => {
    const { sandbox } = await setup();
    const target = scratch();
    const canonical = (await import("node:fs")).realpathSync.native(target);
    const controls = vi.spyOn(writePolicy, "buildMandatorySandboxWritePolicy");
    const config = sandbox.buildSandboxConfig({ allowWrite: [target.toLowerCase()], windows: { externalConfinement: true } });
    expect(controls.mock.calls[0]![0].map(entry => typeof entry === "string" ? entry : entry.path)).toEqual([canonical]);
    expect(config.filesystem.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path))
      .toContain(join(canonical, ".bashrc"));
  });

  it("checks private-helper overlap on the pinned canonical grant", async () => {
    const { sandbox, runtime } = await setup();
    const target = scratch();
    vi.spyOn(integrity, "srtWinPrivateDirectories").mockReturnValue([target]);
    await expect(sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [target.toLowerCase()] }))
      .rejects.toThrow(/private helper/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each(["session-init", "config-register", "config-unregister", "per-command", "worker-api", "worker-spawn", "holder", "plugin", "bundled"] as const)
    ("refuses machine-root writes from %s without a native boundary call", async producer => {
      const settings = { allowWrite: [] as string[], windows: { externalConfinement: true as const } };
      const { sandbox, runtime, update } = await setup(settings);
      const allowWrite = [process.env.ProgramData!];
      const holder = Object.assign(new EventEmitter(), { pid: 5101, exitCode: 0, signalCode: null, stdin: { end: vi.fn() } }) as unknown as ChildProcess;
      vi.spyOn(childProcess, "spawn").mockReturnValue(holder);
      syncBuiltinESMExports();
      vi.spyOn(sandbox, "isPluginWorkerConfinementActive").mockReturnValue(true);
      const wrap = vi.spyOn(runtime.SandboxManager, "wrapWithSandboxArgv");
      const initialize = vi.mocked(runtime.SandboxManager.initialize); initialize.mockClear();
      try {
        if (producer === "session-init") {
          await sandbox.resetAsrtSandbox();
          await expect(sandbox.initializeAsrtSandbox({ allowWrite, windows: { externalConfinement: true } })).rejects.toThrow(/contains machine root/);
        } else if (producer.startsWith("config-")) {
          const socket = scratch(), owner = {};
          if (producer === "config-unregister") await sandbox.registerWorkerUnixSocketDir(socket, owner);
          update.mockClear(); settings.allowWrite.push(...allowWrite);
          await expect(producer === "config-register" ? sandbox.registerWorkerUnixSocketDir(socket, owner)
            : sandbox.unregisterWorkerUnixSocketDir(socket, owner)).rejects.toThrow(/contains machine root/);
        } else if (producer === "per-command") {
          await expect(sandbox.wrapToolCommand("echo fixture", { commandId: TEST_COMMAND_ID, filesystem: { allowWrite } }))
            .rejects.toThrow(/per-exec|contains machine root/);
        } else if (producer === "worker-api") {
          await expect(sandbox.grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite })).rejects.toThrow(/contains machine root/);
        } else if (producer === "worker-spawn") {
          const { spawnWorker } = await import("../worker-spawn.js");
          await expect(spawnWorker({ pluginId: "fixture", workerId: "fixture", command: "fixture.exe", allowWritePaths: allowWrite }))
            .rejects.toThrow(/contains machine root/);
        } else if (producer === "holder") {
          const { holdWindowsFilesystemGrant } = await import("../windows-acl-grant-holder.js");
          await expect(holdWindowsFilesystemGrant({ label: "fixture", allowRead: [], allowWrite })).rejects.toThrow(/contains machine root/);
        } else if (producer === "plugin") {
          const { spawnConfinedPluginChild } = await import("../../plugins/isolation/out-of-process-plugin.js");
          await expect(spawnConfinedPluginChild({ pluginId: "fixture", envelope: { read: [], write: allowWrite },
            socketDir: join(scratch(), "sockets"), workerRunRoot: scratch(), launch: { kind: "entry", childEntryPath: join(scratch(), "entry.js") } }))
            .rejects.toThrow(/contains machine root/);
        } else {
          const { spawnWindowsBundledProcess } = await import("../../sandbox/wrap-bundled-command.js");
          await expect(spawnWindowsBundledProcess({ label: "fixture", command: "fixture.exe", args: [], baseEnv: {}, allowRead: [], allowWrite, egressOwner: TEST_WORKER_EGRESS_OWNER }))
            .rejects.toThrow(/contains machine root/);
        }
        expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); expect(wrap).not.toHaveBeenCalled();
      } finally { holder.emit("exit", 0, null); }
    });
});
