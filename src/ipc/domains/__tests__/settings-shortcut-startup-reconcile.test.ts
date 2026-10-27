import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {},
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const reconcileGlobalShortcuts = vi.fn(() => ({ status: "registered", accelerator: "Alt+Space" }));
const reconcileStartupLaunch = vi.fn(() => ({
  openAtLogin: true,
  openAsHidden: false,
  wasOpenedAsHidden: false,
  applied: true,
}));
const notifyStartupLaunchFailureIfNeeded = vi.fn();

vi.mock("../../../main/global-shortcuts.js", () => ({
  reconcileGlobalShortcuts: (...a: unknown[]) => reconcileGlobalShortcuts(...a),
}));
vi.mock("../../../main/startup-launch.js", () => ({
  reconcileStartupLaunch: (...a: unknown[]) => reconcileStartupLaunch(...a),
  notifyStartupLaunchFailureIfNeeded: (...a: unknown[]) => notifyStartupLaunchFailureIfNeeded(...a),
}));

// A frame-less internal event uses validateSender's trusted-call seam.
const invoke = makeAppIpcInvoker(handlers);

// Apply patches by key so shortcut/system comparisons see the actual before/after values.
function makeDeps(opts: {
  flip: "shortcuts" | "none";
  rewireThrows?: boolean;
  llmChanges?: boolean;
}) {
  let patched = false;
  const rewire = opts.rewireThrows
    ? vi.fn().mockImplementationOnce(() => {
        throw new Error("reviewer down");
      }).mockImplementation(() => undefined)
    : vi.fn();
  const prevLlm = { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: null } } };
  const nextLlm = opts.llmChanges
    ? { provider: "claude", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: null } } }
    : prevLlm;
  return {
    settingsService: {
      hasStoredSecret: vi.fn(() => false),
      getAll: vi.fn(() => ({ llm: nextLlm })),
      get: vi.fn((key: string) => {
        if (key === "llm") return patched ? nextLlm : prevLlm;
        if (key === "marketplace") return {};
        if (key === "shortcuts") {
          return opts.flip === "shortcuts" && patched
            ? { toggleWindow: "Alt+Space", enabled: true }
            : { toggleWindow: null, enabled: false };
        }
        if (key === "system") return { launchAtStartup: false, launchMinimized: false };
        return {};
      }),
      patch: vi.fn(async (p: unknown) => {
        patched = true;
        return p;
      }),
      replaceLlm: vi.fn(async (llm: unknown) => llm),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    rewireReviewerAgent: rewire,
    refreshActiveLlmWildcard: vi.fn(),
  };
}

beforeEach(async () => {
  handlers.clear();
  vi.clearAllMocks();
  vi.resetModules();
  const { configureHostResources } = await import("../../../main/host-resources.js");
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
});

describe("settings.update shortcut/startup reconcile", () => {
  it("reconciles OS state when the shortcut block changes (baseline)", async () => {
    const deps = makeDeps({ flip: "shortcuts" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { shortcuts: { toggleWindow: "Alt+Space", enabled: true } });

    expect(reconcileGlobalShortcuts).toHaveBeenCalledOnce();
    expect(reconcileStartupLaunch).toHaveBeenCalledOnce();
    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledOnce();
  });

  it("MINOR-3: surfaces a login-item apply failure via notifyStartupLaunchFailureIfNeeded", async () => {
    const failedState = {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "platform-unsupported" as const,
    };
    reconcileStartupLaunch.mockReturnValue(failedState);
    const deps = makeDeps({ flip: "shortcuts" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { shortcuts: { toggleWindow: "Alt+Space", enabled: true } });

    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledWith(
      { launchAtStartup: false, launchMinimized: false },
      failedState,
    );
  });

  it("MINOR-2: reconciles even when a combined patch fails the reviewer rewire", async () => {
    // Settings may persist before reviewer rewiring fails; shortcut/startup reconciliation must still run.
    const deps = makeDeps({ flip: "shortcuts", rewireThrows: true, llmChanges: true });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { provider: "claude" },
      shortcuts: { toggleWindow: "Alt+Space", enabled: true },
    });

    expect(result).toMatchObject({ ok: false, error: "reviewer-rewire-failed" });
    expect(reconcileGlobalShortcuts).toHaveBeenCalledOnce();
    expect(reconcileStartupLaunch).toHaveBeenCalledOnce();
    expect(notifyStartupLaunchFailureIfNeeded).toHaveBeenCalledOnce();
  });

  it("§6b: does NOT reconcile when shortcuts/system are unchanged", async () => {
    const deps = makeDeps({ flip: "none" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { chat: { fontScale: 1.1 } });

    expect(reconcileGlobalShortcuts).not.toHaveBeenCalled();
    expect(reconcileStartupLaunch).not.toHaveBeenCalled();
    expect(notifyStartupLaunchFailureIfNeeded).not.toHaveBeenCalled();
  });

  it("§6b: reconcile fires at most once per handler invocation on the failure path", async () => {
    const deps = makeDeps({ flip: "shortcuts", rewireThrows: true, llmChanges: true });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { provider: "claude" },
      shortcuts: { toggleWindow: "Alt+Space", enabled: true },
    });

    expect(reconcileGlobalShortcuts).toHaveBeenCalledTimes(1);
    expect(reconcileStartupLaunch).toHaveBeenCalledTimes(1);
  });

  it("rejects activeChatRuntime through ordinary settings.update", async () => {
    const deps = makeDeps({ flip: "none" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { activeChatRuntime: { kind: "subscription", provider: "codex" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "active-chat-runtime-requires-subscription-selection",
    });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "subscription-runtime",
      type: "warn",
    }));
  });
});
