import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invokeFileIpcHandler } from "./test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeFileIpcHandler(handlers, channel, ...args);
}

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

function makeFakeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

let tempDir: string;
let prevAveHome: string | undefined;

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
  prevAveHome = process.env.AVE_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "ave-tour-ipc-"));
  process.env.AVE_HOME = tempDir;
});

afterEach(async () => {
  if (prevAveHome === undefined) {
    delete process.env.AVE_HOME;
  } else {
    process.env.AVE_HOME = prevAveHome;
  }
  await cleanupTmpDir(tempDir);
});

async function loadModule() {
  return import("../tour.js");
}

function makeDeps(windows: FakeWindow[]) {
  return {
    auditLogger: { log: vi.fn() },
    getMainWindow: () => windows[0] ?? null,
    getAppWindows: () => windows,
  };
}

describe("tour IPC handlers (Tutorial-C)", () => {
  it("get-state returns the default when no file exists", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("ave:tour:get-state");
    expect(result).toEqual({
      ok: true,
      state: {
        lastSeenScenario: null,
        completedScenarios: [],
        dismissedAt: null,
      },
    });
  });

  it("mark-complete persists and returns the new state", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = (await invoke("ave:tour:mark-complete", {
      scenarioId: "first-boot-essentials",
    })) as {
      ok: true;
      state: { lastSeenScenario: string; completedScenarios: string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.state.lastSeenScenario).toBe("first-boot-essentials");
    expect(result.state.completedScenarios).toEqual(["first-boot-essentials"]);

    const getResult = (await invoke("ave:tour:get-state")) as {
      ok: true;
      state: { completedScenarios: string[] };
    };
    expect(getResult.state.completedScenarios).toEqual(["first-boot-essentials"]);
  });

  it("dismiss persists dismissedAt without completing", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = (await invoke("ave:tour:dismiss", {
      scenarioId: "first-boot-essentials",
    })) as {
      ok: true;
      state: {
        completedScenarios: string[];
        dismissedAt: string | null;
        lastSeenScenario: string | null;
      };
    };
    expect(result.ok).toBe(true);
    expect(result.state.completedScenarios).toEqual([]);
    expect(result.state.lastSeenScenario).toBe("first-boot-essentials");
    expect(typeof result.state.dismissedAt).toBe("string");
  });

  it("start fans out ave:tour:start to every window", async () => {
    const win1 = makeFakeWindow();
    const win2 = makeFakeWindow();
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([win1, win2]) as never);

    const result = await invoke("ave:tour:start", {
      scenarioId: "first-boot-essentials",
    });
    expect(result).toEqual({
      ok: true,
      scenarioId: "first-boot-essentials",
    });
    const sendSpy1 = win1.webContents.send as ReturnType<typeof vi.fn>;
    const sendSpy2 = win2.webContents.send as ReturnType<typeof vi.fn>;
    expect(sendSpy1).toHaveBeenCalledWith("ave:tour:start", {
      scenarioId: "first-boot-essentials",
    });
    expect(sendSpy2).toHaveBeenCalledWith("ave:tour:start", {
      scenarioId: "first-boot-essentials",
    });
  });

  it("rejects mark-complete with empty scenarioId", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("ave:tour:mark-complete", { scenarioId: "" });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid-scenario-id",
    });
  });

  it("rejects start with a missing scenarioId", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("ave:tour:start", {});
    expect(result).toMatchObject({
      ok: false,
      error: "invalid-scenario-id",
    });
  });

  it("rejects unauthorized senders", async () => {
    const { registerTourHandlers } = await loadModule();
    registerTourHandlers(makeDeps([makeFakeWindow()]) as never);

    const handler = handlers.get("ave:tour:get-state");
    expect(handler).toBeDefined();
    const result = await Promise.resolve(
      handler!({
        frameId: 0,
        processId: 0,
        senderFrame: { url: "https://evil.example/" },
      } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      error: "unauthorized-frame",
    });
  });
});
