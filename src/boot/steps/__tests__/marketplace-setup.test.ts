import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";

const state = vi.hoisted(() => {
  return {
    disabledFetchers: 0,
    refreshActiveLlmWildcard: vi.fn(),
    disposeRefreshActiveLlmWildcard: vi.fn(),
    refreshDeps: null as {
      getActiveVendor: () => string | undefined;
      cancelPendingRestarts: () => void;
    } | null,
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => "0.0"),
    getPath: vi.fn(() => "/tmp/ave-marketplace-setup-test"),
  },
}));

vi.mock("../../../plugins/marketplace.js", () => ({
  DisabledMarketplaceFetcher: class {
    constructor() {
      state.disabledFetchers += 1;
    }
  },
  PluginMarketplaceService: class {},
}));

vi.mock("../refresh-active-llm-wildcard.js", () => ({
  activeHostApiVendor: (llm: { provider?: string; activeChatRuntime?: { kind?: string } }) =>
    llm.activeChatRuntime?.kind === "subscription" ? undefined : llm.provider,
  createRefreshActiveLlmWildcard: vi.fn((deps: unknown) => {
    state.refreshDeps = deps as {
      getActiveVendor: () => string | undefined;
      cancelPendingRestarts: () => void;
    };
    return {
      refresh: state.refreshActiveLlmWildcard,
      dispose: state.disposeRefreshActiveLlmWildcard,
    };
  }),
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { setupMarketplace } from "../marketplace-setup.js";

function makeContext(
  activeChatRuntime: { kind: "api" } | { kind: "subscription"; provider: "codex" } = { kind: "api" },
): BootContext {
  return {
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", activeChatRuntime };
        if (key === "marketplace") return {};
        return {};
      }),
      getSecret: vi.fn(() => undefined),
      getAll: vi.fn(() => ({})),
    },
    pluginPaths: {},
    deploymentGuard: {},
    bootAuditLogger: {},
    pluginRuntime: { cancelAllPendingRestarts: vi.fn() },
  } as unknown as BootContext;
}

describe("setupMarketplace wiring", () => {
  beforeEach(() => {
    state.disabledFetchers = 0;
    state.refreshActiveLlmWildcard.mockClear();
    state.disposeRefreshActiveLlmWildcard.mockClear();
    state.refreshDeps = null;
  });

  it("builds the plugin store over the disabled fetcher: packages arrive through the git marketplace", async () => {
    const ctx = makeContext();

    await setupMarketplace(ctx);

    expect(state.disabledFetchers).toBe(1);
    expect(state.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    expect(ctx.disposeRefreshActiveLlmWildcard).toBe(state.disposeRefreshActiveLlmWildcard);
  });
  it("omits stale API-provider metadata when a subscription runtime owns generation", async () => {
    const ctx = makeContext({ kind: "subscription", provider: "codex" });

    await setupMarketplace(ctx);

    expect(state.refreshDeps?.getActiveVendor()).toBeUndefined();
  });

  it("wires wildcard disposal to the runtime's in-flight restart cancellation", async () => {
    const ctx = makeContext();

    await setupMarketplace(ctx);

    state.refreshDeps!.cancelPendingRestarts();
    expect(ctx.pluginRuntime.cancelAllPendingRestarts).toHaveBeenCalledOnce();
  });
});
