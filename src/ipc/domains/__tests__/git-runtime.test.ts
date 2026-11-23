import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProbeChild } from "../../../__tests__/support/git-probe-child.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import type { GitRuntimeStatus } from "../../../shared/git-runtime.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const STATUS: GitRuntimeStatus = Object.freeze({
  state: "missing",
  active: null,
  systemTooOld: { version: "2.34.1" },
  installerProvides: true,
});

async function setup() {
  handlers.clear();
  const readStatus = vi.fn(async (): Promise<GitRuntimeStatus> => STATUS);
  const { registerGitRuntimeHandlers } = await import("../git-runtime.js");
  registerGitRuntimeHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => null } as never, readStatus);
  return readStatus;
}

beforeEach(() => {
  handlers.clear();
});

describe("git runtime IPC boundary", () => {
  it("registers only the read-only status channel", async () => {
    await setup();
    expect([...handlers.keys()]).toEqual([CHANNELS.gitRuntime.status]);
    expect(Object.keys(CHANNELS.gitRuntime)).toEqual(["status"]);
  });

  it("reports the status to the host renderer", async () => {
    await setup();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status)).resolves.toEqual({ ok: true, status: STATUS });
  });

  it("keeps IPC dispatch available during a shared status probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-git-status-"));
    const executable = join(directory, process.platform === "win32" ? "git.exe" : "git");
    const started = deferred<void>();
    let completeProbe: (() => void) | undefined;
    try {
      vi.resetModules();
      vi.stubEnv("PATH", directory);
      writeFileSync(executable, "Git fixture", { mode: 0o755 });
      vi.mocked(execFileSync).mockReturnValue("git version 2.56.0");
      vi.mocked(spawn).mockImplementation(() => gitProbeChild((complete) => {
        completeProbe = () => complete("git version 2.56.0");
        started.resolve();
      }));
      const { registerGitRuntimeHandlers } = await import("../git-runtime.js");
      registerGitRuntimeHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => null } as never);

      const first = invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status);
      const second = invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status);
      expect(await Promise.race([started.promise.then(() => "probe"), first.then(() => "status")])).toBe("probe");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.gitRuntime.status, "ave-mcp-app://s-66697874757265/proxy.html?t=fixture"))
        .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
      expect(execFileSync).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, ["--no-lazy-fetch", "--version"], expect.anything());

      completeProbe?.();
      const ready = { ok: true, status: { state: "ready", active: { kind: "system", version: "2.56.0" } } };
      await expect(first).resolves.toMatchObject(ready);
      await expect(second).resolves.toMatchObject(ready);
    } finally {
      completeProbe?.();
      vi.resetAllMocks();
      vi.unstubAllEnvs();
      await cleanupTmpDir(directory);
    }
  });

  it("scrubs the status as every marketplace string (§18.8)", async () => {
    // Assemble credential-shaped fixtures at runtime so no complete token appears in source.
    const token = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
    const readStatus = await setup();
    readStatus.mockResolvedValue({ ...STATUS, systemTooOld: { version: `2.34.1 https://user:${token}@proxy.example/` } });
    const answer = await invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status);
    expect(answer).toMatchObject({ ok: true, status: { state: "missing" } });
    expect(JSON.stringify(answer)).not.toContain(token);
  });

  it("refuses plugin frames", async () => {
    const readStatus = await setup();
    await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.gitRuntime.status, "ave-mcp-app://s-66697874757265/proxy.html?t=fixture"))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("keeps the channel internal", async () => {
    const { isPublicChannel } = await import("../../../contract/app-contract.js");
    expect(isPublicChannel(CHANNELS.gitRuntime.status)).toBe(false);
  });
});
