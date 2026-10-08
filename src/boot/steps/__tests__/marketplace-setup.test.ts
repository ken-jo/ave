import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";

const state = vi.hoisted(() => {
  return {
    storeArgs: null as unknown[] | null,
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
  PluginMarketplaceService: class {
    constructor(...args: unknown[]) {
      state.storeArgs = args;
    }
  },
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

import { removeRetiredMarketplaceCaches, retiredMarketplaceCachePaths, setupMarketplace } from "../marketplace-setup.js";

let root: string;

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
    host: { userDataPath: join(root, "userData") },
    pluginPaths: { cacheRoot: join(root, "home", "plugins", ".cache") },
    deploymentGuard: {},
    pluginRuntime: { cancelAllPendingRestarts: vi.fn() },
  } as unknown as BootContext;
}

describe("setupMarketplace wiring", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-marketplace-setup-"));
    vi.stubEnv("AVE_HOME", join(root, "home"));
    state.storeArgs = null;
    state.refreshActiveLlmWildcard.mockClear();
    state.disposeRefreshActiveLlmWildcard.mockClear();
    state.refreshDeps = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("builds the plugin store over the plugin paths and deployment guard alone", async () => {
    const ctx = makeContext();

    await setupMarketplace(ctx);

    expect(state.storeArgs).toEqual([ctx.pluginPaths, ctx.deploymentGuard]);
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

describe("retired marketplace caches", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-marketplace-setup-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes what the server marketplace left and keeps every live install and version cache", async () => {
    const home = join(root, "home");
    const input = { userDataPath: join(root, "userData"), home, pluginCacheRoot: join(home, "plugins", ".cache") };
    const retired = retiredMarketplaceCachePaths(input);
    const kept = [
      join(home, "plugins", ".cache", "meeting", "2.1.0"),
      join(home, "plugins", "meeting"),
      join(home, "mcp", "context7"),
      join(home, "mcp", ".cache", "context7"),
      join(home, "skills", "pdf"),
      join(input.userDataPath, "Local Storage"),
    ];
    for (const dir of [...retired, ...kept]) mkdirSync(dir, { recursive: true });

    await removeRetiredMarketplaceCaches(retired);

    expect(retired.filter((dir) => existsSync(dir))).toEqual([]);
    expect(kept.filter((dir) => !existsSync(dir))).toEqual([]);
    expect(retired).toContain(join(input.userDataPath, "marketplace-whitelist"));
    expect(retired).toContain(join(home, "plugins", ".cache", ".tarballs"));
    await expect(removeRetiredMarketplaceCaches(retired)).resolves.toBeUndefined();
  });
});
