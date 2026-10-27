import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { subscribeAppPreferenceChange } from "../../../plugins/config-change-bus.js";
import { _resetAppPreferencePublisher } from "../../../boot/steps/plugin-runtime/app-preference.js";
import type { WebViewPreferredFlow } from "../../../data/settings-store.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {},
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../main/global-shortcuts.js", () => ({
  reconcileGlobalShortcuts: vi.fn(() => ({ status: "registered", accelerator: "Alt+Space" })),
}));
vi.mock("../../../main/startup-launch.js", () => ({
  reconcileStartupLaunch: vi.fn(() => ({
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAsHidden: false,
    applied: true,
  })),
  notifyStartupLaunchFailureIfNeeded: vi.fn(),
}));

const invoke = makeAppIpcInvoker(handlers);

// Apply patches to the fixture so before/after comparisons observe real state transitions.
function makeDeps(options: { initialFlow: WebViewPreferredFlow }) {
  let flow = options.initialFlow;
  const llm = { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: null } } };
  return {
    settingsService: {
      hasStoredSecret: vi.fn(() => false),
      getAll: vi.fn(() => ({ llm, webView: { preferredFlow: flow } })),
      get: vi.fn((key: string) => {
        if (key === "llm") return llm;
        if (key === "marketplace") return {};
        if (key === "shortcuts") return { toggleWindow: null, enabled: false };
        if (key === "system") return { launchAtStartup: false, launchMinimized: false };
        if (key === "webView") return { preferredFlow: flow };
        return {};
      }),
      patch: vi.fn(async (patched: unknown) => {
        const next = (patched as { webView?: { preferredFlow?: WebViewPreferredFlow } })
          .webView?.preferredFlow;
        if (next) flow = next;
        return patched;
      }),
      replaceLlm: vi.fn(async (next: unknown) => next),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    rewireReviewerAgent: vi.fn(),
    refreshActiveLlmWildcard: vi.fn(),
  };
}

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  handlers.clear();
  vi.clearAllMocks();
  // Reset the publisher's remembered baseline between tests.
  _resetAppPreferencePublisher();
});

describe("settings.update and the host public preference signal", () => {
  it("announces the save that MOVED webView.preferredFlow, and not the one before it", async () => {
    const announcements: number[] = [];
    const stop = subscribeAppPreferenceChange(() => announcements.push(1));
    const deps = makeDeps({ initialFlow: "in-app" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    try {
      // The first publish always announces; establish its baseline before testing an unchanged save.
      await invoke("ave:settings:update", { chat: { fontScale: 1.1 } });
      expect(announcements).toHaveLength(1);

      await invoke("ave:settings:update", { chat: { fontScale: 1.2 } });
      expect(announcements).toHaveLength(1);

      await invoke("ave:settings:update", { webView: { preferredFlow: "system-browser" } });
      expect(announcements).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("does NOT announce a save that moved no allow-listed preference", async () => {
    const announcements: number[] = [];
    const stop = subscribeAppPreferenceChange(() => announcements.push(1));
    const deps = makeDeps({ initialFlow: "in-app" });
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    try {
      await invoke("ave:settings:update", { webView: { preferredFlow: "system-browser" } });
      expect(announcements).toHaveLength(1);

      await invoke("ave:settings:update", { chat: { fontScale: 1.1 } });
      expect(announcements).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("settings.update and the git marketplace", () => {
  it("tells the marketplace a save wrote `marketplace`, and not a save that did not", async () => {
    const marketplaceSettingsChanged = vi.fn();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(makeDeps({ initialFlow: "in-app" }) as never, { marketplaceSettingsChanged });

    await invoke("ave:settings:update", { chat: { fontScale: 1.1 } });
    expect(marketplaceSettingsChanged).not.toHaveBeenCalled();

    await invoke("ave:settings:update", { marketplace: { updateCheckEnabled: false } });
    expect(marketplaceSettingsChanged).toHaveBeenCalledOnce();
  });
});
