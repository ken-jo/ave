import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

function rejectingController({ rejectReads = false } = {}) {
  const reject = vi.fn(async () => {
    throw new Error("secret-provider-detail-must-not-cross-ipc");
  });
  return {
    listTargets: vi.fn(() => {
      if (rejectReads) throw new Error("secret-target-detail-must-not-cross-ipc");
      return [];
    }),
    status: vi.fn(() => {
      if (rejectReads) throw new Error("secret-status-detail-must-not-cross-ipc");
      return { state: "idle", updatedAt: "2026-07-16T00:00:00.000Z" };
    }),
    send: reject,
    get: reject,
    resume: reject,
    cancel: reject,
    replay: reject,
  };
}

async function setup(options: { rejectReads?: boolean } = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const controller = rejectingController(options);
  const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
  registerRemoteA2AHandlers({
    auditLogger: { log: vi.fn() },
    remoteA2AActionController: controller,
  } as never);
  return controller;
}

async function setupDisabled() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
  registerRemoteA2AHandlers({ auditLogger: { log: vi.fn() } } as never);
}

beforeEach(() => {
  handlers.clear();
});

describe("remote A2A IPC rejection boundary", () => {
  it.each([
    [CHANNELS.remoteA2a.send, { targetAgentId: 7, userIntent: "send this task" }],
    [CHANNELS.remoteA2a.task, { taskHandle: "short" }],
    [CHANNELS.remoteA2a.action, { action: "cancel", taskHandle: "task_handle_123456" }],
  ])("returns the disabled code before requiring keyboard intent on %s", async (channel, payload) => {
    await setupDisabled();

    await expect(invokeFileIpcHandler(handlers, channel, payload)).resolves.toEqual({
      ok: false,
      error: "a2a-remote-disabled",
    });
  });

  describe("restart pending: the saved switches against the ones this run booted with", () => {
    function settingsWith(features: Record<string, boolean>) {
      return { get: vi.fn((key: string) => (key === "features" ? features : undefined)) };
    }
    async function statusWith(deps: Record<string, unknown>) {
      handlers.clear();
      vi.clearAllMocks();
      const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
      registerRemoteA2AHandlers({ auditLogger: { log: vi.fn() }, ...deps } as never);
      return await invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.status);
    }

    it("says a switch turned on since launch is configured but not running", async () => {
      await expect(statusWith({
        settingsService: settingsWith({ a2aRemoteRouting: true }),
        remoteA2ABootGates: { outboundRouting: false, receiverProfile: false },
      })).resolves.toEqual({ ok: false, error: "a2a-remote-disabled", restartPending: true, receiverPort: null });
    });

    it("says nothing is pending when the saved switches are the running ones", async () => {
      const controller = rejectingController();
      await expect(statusWith({
        remoteA2AActionController: controller,
        settingsService: settingsWith({ a2aRemoteRouting: true }),
        remoteA2ABootGates: { outboundRouting: true, receiverProfile: false },
      })).resolves.toEqual({
        ok: true,
        status: { state: "idle", updatedAt: "2026-07-16T00:00:00.000Z" },
        restartPending: false,
        receiverPort: null,
      });
    });

    it("reports a switch turned off since launch, next to a start failure", async () => {
      await expect(statusWith({
        settingsService: settingsWith({}),
        remoteA2ABootGates: { outboundRouting: true, receiverProfile: false },
        remoteA2AStartFailureReason: "a2a-remote-outbound-config-incomplete",
      })).resolves.toEqual({
        ok: false,
        error: "a2a-remote-start-failed",
        reason: "a2a-remote-outbound-config-incomplete",
        restartPending: true,
        receiverPort: null,
      });
    });

    it("claims nothing when the saved switches cannot be read", async () => {
      const result = await statusWith({
        settingsService: { get: vi.fn(() => { throw new Error("settings-unreadable"); }) },
        remoteA2ABootGates: { outboundRouting: false, receiverProfile: false },
      });
      expect(result).toEqual({ ok: false, error: "a2a-remote-disabled", receiverPort: null });
    });

    it("names the receiver's port this launch when it is listening", async () => {
      const receiver = await import("../../../main/a2a-remote-receiver-server.js");
      const spy = vi.spyOn(receiver, "activeRemoteA2AReceiverPort").mockReturnValue(48_123);
      try {
        await expect(statusWith({
          settingsService: settingsWith({ a2aRemoteReceiver: true }),
          remoteA2ABootGates: { outboundRouting: false, receiverProfile: true },
        })).resolves.toEqual({ ok: false, error: "a2a-remote-disabled", restartPending: false, receiverPort: 48_123 });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("lists each recent Task's own status, and refuses it like the other reads", async () => {
    handlers.clear();
    vi.clearAllMocks();
    const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
    const tasks = [{ state: "sent", taskHandle: "task_handle_222222", updatedAt: "2026-07-16T00:00:02.000Z" }];
    registerRemoteA2AHandlers({ auditLogger: { log: vi.fn() }, remoteA2AActionController: { ...rejectingController(), tasks: vi.fn(() => tasks) } } as never);
    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.tasks)).resolves.toEqual({ ok: true, tasks });

    await setupDisabled();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.tasks)).resolves.toEqual({ ok: false, error: "a2a-remote-disabled" });
  });

  it.each([
    [CHANNELS.remoteA2a.targets, undefined],
    [CHANNELS.remoteA2a.status, undefined],
    [CHANNELS.remoteA2a.send, { targetAgentId: 7, userIntent: "send this task", intentToken: USER_INTENT }],
    [CHANNELS.remoteA2a.task, { taskHandle: "task_handle_123456" }],
    [CHANNELS.remoteA2a.action, { action: "cancel", taskHandle: "task_handle_123456", intentToken: USER_INTENT }],
  ])("answers %s with the start failure, not 'off', when a switched-on gate did not start", async (channel, payload) => {
    handlers.clear();
    vi.clearAllMocks();
    const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
    registerRemoteA2AHandlers({
      auditLogger: { log: vi.fn() },
      remoteA2AStartFailureReason: "a2a-remote-outbound-config-incomplete",
    } as never);

    // Still a refusal: nothing behind the surface started.
    await expect(invokeFileIpcHandler(handlers, channel, payload)).resolves.toEqual({
      ok: false,
      error: "a2a-remote-start-failed",
      reason: "a2a-remote-outbound-config-incomplete",
      // Only the status channel reports where the runtime stands.
      ...(channel === CHANNELS.remoteA2a.status ? { receiverPort: null } : {}),
    });
  });

  it.each([CHANNELS.remoteA2a.targets, CHANNELS.remoteA2a.status])(
    "returns the stable code when read channel %s throws",
    async (channel) => {
      await setup({ rejectReads: true });

      await expect(invokeFileIpcHandler(handlers, channel)).resolves.toEqual({
        ok: false,
        error: "a2a-remote-operation-rejected",
        ...(channel === CHANNELS.remoteA2a.status ? { receiverPort: null } : {}),
      });
    },
  );

  it("returns a stable code when send throws without leaking the internal error", async () => {
    await setup();

    const result = await invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.send, {
      intentToken: USER_INTENT,
      targetAgentId: 7,
      userIntent: "send this task",
    });

    expect(result).toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
  });

  it.each(["", " ", " leading", "trailing ", "x".repeat(8_193)])(
    "rejects an invalid send intent at the IPC boundary: %j",
    async (userIntent) => {
      const controller = await setup();

      await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.send, {
        intentToken: USER_INTENT,
        targetAgentId: 7,
        userIntent,
      })).resolves.toEqual({ ok: false, error: "a2a-remote-input-invalid" });
      expect(controller.send).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, Number.MIN_SAFE_INTEGER])(
    "rejects invalid target agent ID %s at the IPC boundary",
    async (targetAgentId) => {
      const controller = await setup();

      await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.send, {
        intentToken: USER_INTENT,
        targetAgentId,
        userIntent: "send this task",
      })).resolves.toEqual({ ok: false, error: "a2a-remote-input-invalid" });
      expect(controller.send).not.toHaveBeenCalled();
    },
  );

  it("uses ok only as the discriminant when a controller returns a failed delivery status", async () => {
    handlers.clear();
    const failedStatus = {
      state: "failed" as const,
      outcome: "remote-task-failed",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const controller = {
      listTargets: vi.fn(() => []),
      status: vi.fn(() => failedStatus),
      send: vi.fn(async () => failedStatus),
      get: vi.fn(async () => failedStatus),
      resume: vi.fn(async () => failedStatus),
      cancel: vi.fn(async () => failedStatus),
      replay: vi.fn(async () => failedStatus),
    };
    const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
    registerRemoteA2AHandlers({
      auditLogger: { log: vi.fn() },
      remoteA2AActionController: controller,
    } as never);

    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.send, {
      intentToken: USER_INTENT,
      targetAgentId: 7,
      userIntent: "send this task",
    })).resolves.toEqual({ ok: true, status: failedStatus });
  });

  it("returns the same stable code when task lookup throws", async () => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.task, {
      taskHandle: "task_handle_123456",
    })).resolves.toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
  });

  it.each(["", "short", "a".repeat(257), "invalid!task_handle"])(
    "rejects malformed task handle %j before task lookup",
    async (taskHandle) => {
      const controller = await setup();

      await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.task, {
        taskHandle,
      })).resolves.toEqual({ ok: false, error: "a2a-remote-input-invalid" });
      expect(controller.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["resume", { userIntent: "continue" }],
    ["cancel", {}],
    ["replay", {}],
  ] as const)("returns the same stable code when %s throws", async (action, extra) => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.action, {
      intentToken: USER_INTENT,
      action,
      taskHandle: "task_handle_123456",
      ...extra,
    })).resolves.toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
  });

  it.each(["", " ", " leading", "trailing ", "x".repeat(8_193)])(
    "rejects an invalid Resume intent at the IPC boundary: %j",
    async (userIntent) => {
      const controller = await setup();

      await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.action, {
        intentToken: USER_INTENT,
        action: "resume",
        taskHandle: "task_handle_123456",
        userIntent,
      })).resolves.toEqual({ ok: false, error: "a2a-remote-input-invalid" });
      expect(controller.resume).not.toHaveBeenCalled();
    },
  );

  it.each(["", "short", "a".repeat(257), "invalid!task_handle"])(
    "rejects malformed task handle %j before an action",
    async (taskHandle) => {
      const controller = await setup();

      await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.action, {
        intentToken: USER_INTENT,
        action: "cancel",
        taskHandle,
      })).resolves.toEqual({ ok: false, error: "a2a-remote-input-invalid" });
      expect(controller.cancel).not.toHaveBeenCalled();
    },
  );
});
