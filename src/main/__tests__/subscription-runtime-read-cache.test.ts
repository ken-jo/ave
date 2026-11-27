import { subscriptionAccountFixture } from "../../__tests__/support/subscription-account-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import type { AcpSubscriptionStatus } from "../../shared/acp-subscription.js";
import type { CodexSubscriptionStatus } from "../../shared/codex-subscription.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import { claudeCodeSubscriptionStatus, type ClaudeCodeSubscriptionStatus } from "../../shared/claude-code-subscription.js";
import type { ClaudeCodeSubscriptionClient } from "../claude-code-subscription-client.js";
import { onSubscriptionRuntimeStatusChanged, SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
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
    cancelLogin: vi.fn(async () => status),
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
    codexClient: subscriptionAccountFixture(options.codex ?? codexClient()) as unknown as CodexAppServerClient,
    acpRegistry: { stopAll: vi.fn(async () => undefined), ...options.acpRegistry } as unknown as AcpSubscriptionRuntimeRegistry,
    claudeCodeClient: subscriptionAccountFixture(options.claude ?? claudeClient().client) as unknown as ClaudeCodeSubscriptionClient,
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

  it("keeps no status read while a logout is still running", async () => {
    const { client, setStatus } = claudeClient();
    const gate = deferred<void>();
    client.logout.mockImplementationOnce(async () => {
      await gate.promise;
      const signedOut = claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0");
      setStatus(signedOut);
      return signedOut;
    });
    const runtime = await service({ claude: client });
    try {
      const logout = runtime.logout("claude-code");
      // The raw CLI still reads as connected, so the outstanding mutation must prevent that reply from reaching the caller.
      await expect(runtime.getStatus("claude-code", { allowCached: true })).resolves.toMatchObject({ connection: "unknown", capabilities: { chat: false } });
      gate.resolve();
      await logout;
      expect((await runtime.getStatus("claude-code", { allowCached: true })).connection).toBe("signed-out");
    } finally {
      await runtime.stop();
    }
  });

  it("returns signed out for a held ready read that completes after logout", async () => {
    const { client, setStatus } = claudeClient();
    const logoutGate = deferred<void>();
    const readGate = deferred<void>();
    client.logout.mockImplementationOnce(async () => {
      await logoutGate.promise;
      const signedOut = claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0");
      setStatus(signedOut);
      return signedOut;
    });
    const runtime = await service({ claude: client });
    try {
      client.getStatus.mockImplementationOnce(async () => {
        const connected = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0");
        await readGate.promise;
        return connected;
      });
      const read = runtime.getStatus("claude-code", { allowCached: true });
      const logout = runtime.logout("claude-code");
      logoutGate.resolve();
      await logout;
      readGate.resolve();
      await expect(read).resolves.toMatchObject({ connection: "signed-out", capabilities: { chat: false } });
      expect((await runtime.getStatus("claude-code", { allowCached: true })).connection).toBe("signed-out");
    } finally {
      await runtime.stop();
    }
  });

  it.each([false, true])("orders overlapping account reads with newest completion first=%s", async (newestFirst) => {
    const { client, setStatus } = claudeClient();
    const runtime = await service({ claude: client });
    const changed = vi.fn();
    const unsubscribe = onSubscriptionRuntimeStatusChanged(changed);
    try {
      await runtime.verify("claude-code");
      changed.mockClear();
      const disconnected = deferred<ClaudeCodeSubscriptionStatus>();
      const reconnected = deferred<ClaudeCodeSubscriptionStatus>();
      client.getStatus.mockImplementationOnce(() => disconnected.promise).mockImplementationOnce(() => reconnected.promise);
      const earlier = runtime.getStatus("claude-code");
      const later = runtime.getStatus("claude-code");
      const signedOut = claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0");
      const signedIn = claudeCodeSubscriptionStatus("ready", "connected", "2.2.0");
      if (newestFirst) {
        reconnected.resolve(signedIn);
        await expect(later).resolves.toMatchObject({ connection: "connected" });
        disconnected.resolve(signedOut);
        await expect(earlier).resolves.toMatchObject({ connection: "signed-out", capabilities: { chat: false } });
        expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false]]);
        setStatus(signedIn);
        await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ connection: "connected", capabilities: { chat: false } });
      } else {
        disconnected.resolve(signedOut);
        await expect(earlier).resolves.toMatchObject({ connection: "signed-out", capabilities: { chat: false } });
        reconnected.resolve(signedIn);
        await expect(later).resolves.toMatchObject({ connection: "signed-out", capabilities: { chat: false } });
        expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false]]);
        setStatus(signedIn);
        await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ connection: "connected", capabilities: { chat: false } });
        expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false], ["claude-code", true]]);
      }
      const sampleCount = client.getStatus.mock.calls.length;
      expect(await runtime.getStatus("claude-code", { allowCached: true })).toMatchObject({ connection: "connected", version: "2.2.0" });
      expect(client.getStatus).toHaveBeenCalledTimes(sampleCount);
    } finally {
      unsubscribe();
      await runtime.stop();
    }
  });

  it("keeps the disconnect latched through login cleanup", async () => {
    const { client, setStatus } = claudeClient();
    const runtime = await service({ claude: client });
    const changed = vi.fn();
    const unsubscribe = onSubscriptionRuntimeStatusChanged(changed);
    try {
      await runtime.getStatus("claude-code");
      changed.mockClear();
      await runtime.logout("claude-code");
      setStatus(claudeCodeSubscriptionStatus("ready", "connected", "2.1.0"));
      await expect(runtime.cancelLogin("claude-code")).resolves.toMatchObject({ connection: "signed-out" });
      await expect(runtime.getCachedStatus("claude-code")).resolves.toMatchObject({ connection: "signed-out" });
      expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false], ["claude-code", false]]);
      await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ connection: "connected" });
      expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false], ["claude-code", false], ["claude-code", true]]);
    } finally {
      unsubscribe();
      await runtime.stop();
    }
  });

  it.each(["failed probe", "login cleanup"] as const)("latches a held disconnect after a subsequent %s", async (operation) => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    const changed = vi.fn();
    const unsubscribe = onSubscriptionRuntimeStatusChanged(changed);
    const disconnected = deferred<ClaudeCodeSubscriptionStatus>();
    const connected = deferred<ClaudeCodeSubscriptionStatus>();
    try {
      const ready = await client.getStatus();
      await runtime.getStatus("claude-code");
      client.getStatus.mockImplementationOnce(() => disconnected.promise);
      const earlier = runtime.getStatus("claude-code");
      if (operation === "failed probe") {
        client.getStatus.mockRejectedValueOnce(new Error("Probe failed"));
        await expect(runtime.getStatus("claude-code")).rejects.toMatchObject({ code: "subscription-operation-failed" });
      } else {
        await runtime.cancelLogin("claude-code");
      }
      changed.mockClear();
      client.getStatus.mockImplementationOnce(() => connected.promise);
      const later = runtime.getStatus("claude-code");
      disconnected.resolve(claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0"));
      const disconnect = await earlier;
      connected.resolve(ready);
      const stale = await later;
      expect(disconnect.connection).toBe("signed-out");
      expect(stale.connection).toBe("signed-out");
      expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false]]);
      await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ connection: "connected" });
    } finally {
      unsubscribe();
      await runtime.stop();
    }
  });

  it("returns the winning disconnect for an earlier ready sample", async () => {
    const { client, setStatus } = claudeClient();
    const runtime = await service({ claude: client });
    try {
      await runtime.verify("claude-code");
      const held = deferred<ClaudeCodeSubscriptionStatus>();
      client.getStatus.mockImplementationOnce(() => held.promise);
      const earlier = runtime.getStatus("claude-code");
      setStatus(claudeCodeSubscriptionStatus("unverified", "signed-out", "2.1.0"));
      await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ connection: "signed-out" });
      held.resolve(claudeCodeSubscriptionStatus("ready", "connected", "2.1.0"));
      await expect(earlier).resolves.toMatchObject({ connection: "signed-out", capabilities: { chat: false } });
    } finally {
      await runtime.stop();
    }
  });

  it("revokes proof and cached availability on a failed live probe", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    const changed = vi.fn();
    const unsubscribe = onSubscriptionRuntimeStatusChanged(changed);
    try {
      await runtime.verify("claude-code");
      changed.mockClear();
      client.getStatus.mockRejectedValueOnce(new Error("Probe failed"));
      await expect(runtime.getStatus("claude-code")).rejects.toMatchObject({ code: "subscription-operation-failed" });
      expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false]]);
      await expect(runtime.getCachedStatus("claude-code")).resolves.toMatchObject({
        runtime: "unavailable", connection: "unknown", capabilities: { chat: false },
      });
      await expect(runtime.getStatus("claude-code", { allowCached: true })).resolves.toMatchObject({
        connection: "connected", capabilities: { chat: false },
      });
      expect(changed.mock.calls.map(([provider, connected]) => [provider, connected])).toEqual([["claude-code", false], ["claude-code", true]]);
    } finally {
      unsubscribe();
      await runtime.stop();
    }
  });

  it("ignores a failed older probe after a newer live sample was accepted", async () => {
    const { client } = claudeClient();
    const runtime = await service({ claude: client });
    const changed = vi.fn();
    const unsubscribe = onSubscriptionRuntimeStatusChanged(changed);
    try {
      await runtime.verify("claude-code");
      changed.mockClear();
      const held = deferred<void>();
      client.getStatus.mockImplementationOnce(async () => {
        await held.promise;
        throw new Error("Earlier probe failed");
      });
      const earlier = runtime.getStatus("claude-code");
      await expect(runtime.getStatus("claude-code")).resolves.toMatchObject({ capabilities: { chat: true } });
      held.resolve();
      await expect(earlier).resolves.toMatchObject({ connection: "connected", capabilities: { chat: true } });
      expect(changed).not.toHaveBeenCalled();
      await expect(runtime.getStatus("claude-code", { allowCached: true })).resolves.toMatchObject({
        capabilities: { chat: true },
      });
    } finally {
      unsubscribe();
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
      await expect(stale).resolves.toMatchObject({ version: "2.1.0", capabilities: { chat: true } });
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
