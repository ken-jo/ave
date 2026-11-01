import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import type { AcpSubscriptionStatus } from "../../shared/acp-subscription.js";
import type { CodexSubscriptionStatus } from "../../shared/codex-subscription.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import { claudeCodeSubscriptionStatus, type ClaudeCodeSubscriptionStatus } from "../../shared/claude-code-subscription.js";
import type { ClaudeCodeSubscriptionClient } from "../claude-code-subscription-client.js";
import { SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace as namespace } from "../../__tests__/support/subscription-runtime-namespace.js";

const CODEX_CONNECTED: CodexSubscriptionStatus = {
  runtime: "ready",
  connection: "connected",
  planType: "plus",
  pendingLogin: null,
  pendingDeviceCode: null,
  version: "0.153.4",
};

const KIMI_PENDING: AcpSubscriptionStatus = {
  provider: "kimi-code",
  runtime: "ready",
  connection: "pending",
  pendingLogin: "device-code",
  pendingDeviceCode: null,
  canOpenVerificationUrl: false,
  version: "test",
  promptCapabilities: { image: false, embeddedContext: false },
};

const CACHE_TTL_MS = 5 * 60_000;

function claudeClient(initial = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")) {
  let status: ClaudeCodeSubscriptionStatus = initial;
  const client = {
    getStatus: vi.fn(async () => status),
    getCachedStatus: vi.fn(() => status),
    verify: vi.fn(async () => status),
    logout: vi.fn(async () => {
      status = claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0");
      return status;
    }),
    stop: vi.fn(async () => undefined),
  };
  return {
    client,
    setStatus: (next: ClaudeCodeSubscriptionStatus) => { status = next; },
  };
}

function codexClient() {
  return {
    getStatus: vi.fn(async () => CODEX_CONNECTED),
    getCachedStatus: vi.fn(() => CODEX_CONNECTED),
    listModels: vi.fn(async () => ({
      status: CODEX_CONNECTED,
      models: [{ id: "gpt-5", displayName: "GPT-5", isDefault: true }],
    })),
    stop: vi.fn(),
  };
}

async function service(options: {
  claude?: ReturnType<typeof claudeClient>["client"];
  codex?: ReturnType<typeof codexClient>;
  acpRegistry?: Partial<AcpSubscriptionRuntimeRegistry>;
} = {}) {
  return SubscriptionRuntimeService.create(async () => undefined, {
    namespace: namespace(),
    claimRuntimeDirectories: claimFakeRuntimeDirectories,
    codexClient: (options.codex ?? codexClient()) as unknown as CodexAppServerClient,
    acpRegistry: { stopAll: vi.fn(async () => undefined), ...options.acpRegistry } as unknown as AcpSubscriptionRuntimeRegistry,
    claudeCodeClient: (options.claude ?? claudeClient().client) as unknown as ClaudeCodeSubscriptionClient,
  });
}

describe("SubscriptionRuntimeService settings read cache", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists Claude Code models from the status the settings card just read", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.getStatus("claude-code", { allowCached: true });
      const catalog = await runtime.listModels("claude-code", { allowCached: true });
      expect(catalog.status.connection).toBe("connected");
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(client.getStatus).toHaveBeenCalledOnce();
    } finally {
      await runtime.stop();
    }
  });

  it("reuses a cached status until it expires, while uncached reads stay live", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.getStatus("claude-code", { allowCached: true });
      await runtime.getStatus("claude-code", { allowCached: true });
      expect(client.getStatus).toHaveBeenCalledTimes(1);
      await runtime.getStatus("claude-code");
      expect(client.getStatus).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
      await runtime.getStatus("claude-code", { allowCached: true });
      expect(client.getStatus).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.stop();
    }
  });

  it("refreshes the cache from a live read", async () => {
    const { client, setStatus } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.getStatus("claude-code", { allowCached: true });
      setStatus(claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0"));
      expect((await runtime.getStatus("claude-code")).connection).toBe("signed-out");
      expect((await runtime.getStatus("claude-code", { allowCached: true })).connection).toBe("signed-out");
      expect(client.getStatus).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it("never caches a pending login", async () => {
    const getStatus = vi.fn(async () => KIMI_PENDING);
    const runtime = await service({ acpRegistry: { getStatus } as Partial<AcpSubscriptionRuntimeRegistry> });
    try {
      await runtime.getStatus("kimi-code", { allowCached: true });
      await runtime.getStatus("kimi-code", { allowCached: true });
      expect(getStatus).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it("serves verify's proven status and drops it on logout", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.getStatus("claude-code", { allowCached: true });
      expect((await runtime.verify("claude-code")).capabilities.chat).toBe(true);
      expect((await runtime.getStatus("claude-code", { allowCached: true })).capabilities.chat).toBe(true);
      expect(client.getStatus).toHaveBeenCalledTimes(1);
      await runtime.logout("claude-code");
      const after = await runtime.getStatus("claude-code", { allowCached: true });
      expect(after.connection).toBe("signed-out");
      expect(after.capabilities.chat).toBe(false);
      expect(client.getStatus).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it("does not store a read that a verification overtook", async () => {
    const { client } = claudeClient();
    const pending = deferred<ClaudeCodeSubscriptionStatus>();
    client.getStatus.mockImplementationOnce(() => pending.promise);
    const runtime = await service({ claude: client });
    try {
      const stale = runtime.getStatus("claude-code", { allowCached: true });
      await runtime.verify("claude-code");
      pending.resolve(claudeCodeSubscriptionStatus("ready", "connected", "2.0.0"));
      await stale;
      expect((await runtime.getStatus("claude-code", { allowCached: true })).version).toBe("2.1.0");
    } finally {
      await runtime.stop();
    }
  });

  it("drops cached reads when told the provider's settings changed", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.getStatus("claude-code", { allowCached: true });
      runtime.invalidateCachedReads("claude-code");
      await runtime.getStatus("claude-code", { allowCached: true });
      expect(client.getStatus).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it("caches the Codex catalog per provider and keeps internal catalog reads live", async () => {
    const codex = codexClient();
    const runtime = await service({ codex });
    try {
      const first = await runtime.listModels("codex", { allowCached: true });
      const second = await runtime.listModels("codex", { allowCached: true });
      expect(second).toEqual(first);
      expect(codex.listModels).toHaveBeenCalledTimes(1);
      await runtime.listModels("codex");
      expect(codex.listModels).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });
});
