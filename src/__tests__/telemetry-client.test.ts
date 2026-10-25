import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginTelemetryClient, loadOrCreateDeviceUuid, relocateDeviceUuid } from "../telemetry/client.js";
import { scrubPii } from "../telemetry/client.js";
import type { TelemetrySettings } from "../data/settings-store.js";
import { cleanupTmpDir } from "../__tests__/support/tmp-dir-teardown.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

let telemetryTmpDir: string;

function makeDeps(overrides: {
  enabled?: boolean;
  promptAnswered?: boolean;
  endpoint?: string | null | undefined;
  fetchImpl: typeof fetch;
  flushIntervalMs?: number;
}) {
  const settings: TelemetrySettings = {
    enabled: overrides.enabled ?? true,
    telemetryPromptAnswered: overrides.promptAnswered ?? true
  };
  return {
    settings: () => settings,
    endpoint: () => ("endpoint" in overrides ? overrides.endpoint : "https://ave.agent-connector.ai/telemetry/events"),
    deviceUuidPath: join(telemetryTmpDir, "device-uuid"),
    fetchImpl: overrides.fetchImpl,
    flushIntervalMs: overrides.flushIntervalMs ?? 99_999
  };
}

function okFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
}

describe("PluginTelemetryClient", () => {
  beforeEach(() => {
    telemetryTmpDir = mkdtempSync(join(tmpdir(), "ave-telemetry-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTmpDir(telemetryTmpDir);
  });

  it("track() is a no-op when enabled=false", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ enabled: false, fetchImpl: fetch }));
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    expect(client.queueLength).toBe(0);
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("track() is a no-op before consent prompt is answered", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(
      makeDeps({ promptAnswered: false, fetchImpl: fetch }),
    );
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    expect(client.queueLength).toBe(0);
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batches multiple events into a single POST", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: fetch }));
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    client.track("plugin_uninstall", { slug: "com.example.bar", version: "2.0.0" });
    client.track("plugin_error", {
      slug: "com.example.baz",
      version: "3.0.0",
      errorClass: "MarketplaceInstallerError"
    });
    expect(client.queueLength).toBe(3);
    await client.flush();
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(3);
    expect(client.queueLength).toBe(0);
  });

  it("calls flush at the configured interval", async () => {
    vi.useFakeTimers();
    const fetch = okFetch();
    const INTERVAL = 1000;
    const client = new PluginTelemetryClient(
      makeDeps({ fetchImpl: fetch, flushIntervalMs: INTERVAL }),
    );
    client.track("plugin_update", { slug: "com.example.foo", version: "1.0.0" });
    client.start();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.queueLength).toBe(0);
    client.stop();
    client.track("plugin_update", { slug: "com.example.foo", version: "1.0.1" });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("scrubPii strips absolute paths and email addresses", () => {
    expect(scrubPii("/home/user/documents/secret.txt")).toContain("[path]");
    expect(scrubPii("C:\\Users\\example\\AppData\\Local\\ave")).toContain("[path]");
    expect(scrubPii("contact user@example.com for support")).toContain("[email]");
    expect(scrubPii("com.example.meeting-recorder")).toBe("com.example.meeting-recorder");
    expect(scrubPii("1.2.3")).toBe("1.2.3");
  });

  it("flush posts to the service endpoint with no credential", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: fetch }));
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    await client.flush();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ave.agent-connector.ai/telemetry/events");
    const body = JSON.parse(init.body as string) as { events: Array<Record<string, unknown>> };
    const ev = body.events[0];
    expect(ev.v).toBe(1);
    expect(ev.name).toBe("plugin_install");
    expect(typeof ev.device_uuid).toBe("string");
    expect(ev.device_uuid).toHaveLength(36); // UUID format
    expect(ev.install_token).toBeUndefined();
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("is inactive while the service document names no telemetry endpoint", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: fetch, endpoint: null }));
    expect(client.isActive()).toBe(false);
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(client.queueLength).toBe(0);
  });

  it("holds events while no service document is in force, sends them once one names an endpoint, and drops them if it names none", async () => {
    const fetch = okFetch();
    let endpoint: string | null | undefined;
    const client = new PluginTelemetryClient({ ...makeDeps({ fetchImpl: fetch }), endpoint: () => endpoint });
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(client.queueLength).toBe(1);

    endpoint = "https://ave.agent-connector.ai/telemetry/events";
    await client.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.queueLength).toBe(0);

    endpoint = undefined;
    client.track("plugin_update", { slug: "com.example.foo", version: "1.0.1" });
    endpoint = null;
    await client.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.queueLength).toBe(0);
  });

  it("holds at most 500 events, dropping the oldest", () => {
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: okFetch(), endpoint: undefined }));
    for (let i = 0; i < 520; i += 1) client.track("plugin_install", { slug: `com.example.p${i}`, version: "1.0.0" });
    expect(client.queueLength).toBe(500);
  });

  it("never asks for the endpoint without consent", () => {
    const endpoint = vi.fn(() => "https://ave.agent-connector.ai/telemetry/events");
    const client = new PluginTelemetryClient({ ...makeDeps({ fetchImpl: okFetch(), enabled: false }), endpoint });
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    expect(client.isActive()).toBe(false);
    expect(endpoint).not.toHaveBeenCalled();
  });

  it("concurrent flush() calls share the in-flight request", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    const client = new PluginTelemetryClient(
      makeDeps({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
    );
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    const a = client.flush();
    const b = client.flush();
    const c = client.flush();
    resolveFetch({ ok: true, status: 200 } as Response);
    await Promise.all([a, b, c]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("flush skips POST when queue is empty", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: fetch }));
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-queues events when server returns non-ok status", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const client = new PluginTelemetryClient(
      makeDeps({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
    );
    client.track("plugin_install", { slug: "com.example.foo", version: "1.0.0" });
    await client.flush();
    expect(client.queueLength).toBe(1);
  });

  it("plugin_error event includes errorClass but no error message", async () => {
    const fetch = okFetch();
    const client = new PluginTelemetryClient(makeDeps({ fetchImpl: fetch }));
    client.track("plugin_error", {
      slug: "com.example.foo",
      version: "1.0.0",
      errorClass: "NetworkError"
    });
    await client.flush();
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { events: Array<Record<string, unknown>> };
    expect(body.events[0].errorClass).toBe("NetworkError");
    expect(body.events[0].message).toBeUndefined();
  });
});

describe("relocateDeviceUuid — the device keeps its id when its home moves", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";

  function afterRelocation(run: (paths: { oldPath: string; newPath: string }) => void): void {
    const root = mkdtempSync(join(tmpdir(), "ave-device-uuid-"));
    try {
      const oldPath = join(root, "userData", ".ave", "device-uuid");
      const newPath = join(root, "home", ".ave", "telemetry", "device-uuid");
      mkdirSync(dirname(oldPath), { recursive: true });
      writeFileSync(oldPath, UUID);
      expect(relocateDeviceUuid(oldPath, newPath)).toBe(true);
      run({ oldPath, newPath });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("carries the uuid over and removes the emptied old root", () => {
    afterRelocation(({ oldPath, newPath }) => {
      expect(loadOrCreateDeviceUuid(newPath)).toBe(UUID);
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(dirname(oldPath))).toBe(false);
    });
  });

  it("is a no-op on a second run", () => {
    afterRelocation(({ oldPath, newPath }) => {
      expect(relocateDeviceUuid(oldPath, newPath)).toBe(false);
      expect(loadOrCreateDeviceUuid(newPath)).toBe(UUID);
    });
  });

  /* Exclusive creation proves migration removed the old file without a check-then-use race. */
  it("never lets a stale old file clobber the newer id", () => {
    afterRelocation(({ oldPath, newPath }) => {
      mkdirSync(dirname(oldPath), { recursive: true });
      writeFileSync(oldPath, "stale", { flag: "wx" });
      expect(relocateDeviceUuid(oldPath, newPath)).toBe(false);
      expect(loadOrCreateDeviceUuid(newPath)).toBe(UUID);
    });
  });
});
