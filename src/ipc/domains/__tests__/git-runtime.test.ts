import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import type { GitRuntimeStatus } from "../../../shared/git-runtime.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

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
    await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.gitRuntime.status, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("keeps the channel internal", async () => {
    const { isPublicChannel } = await import("../../../contract/app-contract.js");
    expect(isPublicChannel(CHANNELS.gitRuntime.status)).toBe(false);
  });
});
