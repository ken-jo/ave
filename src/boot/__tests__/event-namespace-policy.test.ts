import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestPluginRuntime as PluginRuntime } from "../../plugins/__tests__/test-helpers.js";
import {
  canEmitEvent,
  classifySubscription,
  requiredCapabilityForEmit,
  PLUGIN_PRIVATE_NAMESPACES,
  PUBLIC_EVENT_NAMESPACES,
  KNOWN_CAPABILITIES,
  HOST_ONLY_EMIT_NAMESPACES,
} from "../../plugins/capabilities.js";
import { getDeclaredEmittedEvents } from "../../plugins/runtime/manifest-validation.js";
import { registerManifestEventSubscriptions } from "../plugins.js";
import { mkdtempSync } from "node:fs";
import { servedAgentPluginsDocument } from "../../plugins/__tests__/test-helpers.js";

async function writeEventPluginFixture(
  testDir: string,
  installedDir: string,
  registryPath: string,
  id: string,
  declarations: { eventSubscriptions?: string[]; emittedEvents?: string[] },
  extra: Record<string, unknown>,
): Promise<void> {
  const pluginDir = join(installedDir, id);
  await mkdir(pluginDir, { recursive: true });
  const toolName = `${id.replace(/-/g, "_")}_ping`;
  await writeFile(
    join(pluginDir, "entry.mjs"),
    `export default async function createPlugin(ctx) {
  return { handlers: { ${toolName}: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
    "utf-8",
  );
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    description: "Test fixture.",
    entry: "entry.mjs",
    tools: [
      {
        name: toolName,
        description: `${toolName} test tool`,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
    ],
    ...declarations,
    ...extra,
  };
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(servedAgentPluginsDocument(manifest)), "utf-8");
  await mkdir(join(testDir, "plugins"), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
    }),
    "utf-8",
  );
}

describe("capabilities module namespace policy", () => {
  it("classifies private namespaces as 'private'", () => {
    expect(classifySubscription("memory.private.user_doc")).toBe("private");
    expect(classifySubscription("settings.apiKey.openai")).toBe("private");
    expect(classifySubscription("audit.call")).toBe("private");
    expect(classifySubscription("dlp.redact")).toBe("private");
  });

  it("classifies known public namespaces as 'public'", () => {
    expect(classifySubscription("meeting.started")).toBe("public");
    expect(classifySubscription("meeting.transcript.updated")).toBe("public");
    expect(classifySubscription("email.new")).toBe("public");
    expect(classifySubscription("calendar.event")).toBe("public");
    expect(classifySubscription("index.scan_done")).toBe("public");
    expect(classifySubscription("host.theme.changed")).toBe("public");
  });

  it("classifies everything else as 'neutral'", () => {
    expect(classifySubscription("random.event")).toBe("neutral");
    expect(classifySubscription("foobar")).toBe("neutral");
    expect(classifySubscription("host.secret.changed")).toBe("neutral");
    expect(classifySubscription("task.created")).toBe("neutral");
    // Plugin-owned namespaces remain neutral to the host.
    expect(classifySubscription("samplehub.work_item.due_soon")).toBe("neutral");
  });

  it("maps event namespace → required capability for emit", () => {
    expect(requiredCapabilityForEmit("email.new")).toBe("mail-source");
    expect(requiredCapabilityForEmit("meeting.started")).toBe("meeting-recorder");
    expect(requiredCapabilityForEmit("meeting.transcript.updated")).toBe("meeting-recorder");
    expect(requiredCapabilityForEmit("calendar.event")).toBe("calendar-source");
    expect(requiredCapabilityForEmit("index.scan_done")).toBe("knowledge-index");
    expect(requiredCapabilityForEmit("random.event")).toBeUndefined();
  });

  it("KNOWN_CAPABILITIES is the reduced host-ENFORCED set (Ph1/Ph2)", () => {
    // Raw credential export requires a separate capability from credential leases.
    expect([...KNOWN_CAPABILITIES].sort()).toEqual(
      ["external-auth-consumer", "host:overlay", "secrets:raw-api-key"].sort(),
    );
    for (const removed of [
      "samplemail-consumer",
      "background-watcher",
      "document-indexer",
      "lifecycle-observer",
      "routine-provider",
      "worker-client",
      "mail-source",
      "calendar-source",
      "meeting-recorder",
      "knowledge-index",
    ]) {
      expect(KNOWN_CAPABILITIES.has(removed)).toBe(false);
    }
  });

  it("sanity: private + public sets are disjoint", () => {
    for (const priv of PLUGIN_PRIVATE_NAMESPACES) {
      const prefix = priv.split(".")[0];
      expect(PUBLIC_EVENT_NAMESPACES.has(prefix)).toBe(false);
    }
  });

  it("HOST-only namespaces reject plugin emit regardless of declared emittedEvents", () => {
    // Host-only lifecycle events cannot be unlocked by a plugin manifest.
    expect(canEmitEvent("plugin.installed", [])).toBe(false);
    expect(canEmitEvent("plugin.uninstalled", [])).toBe(false);
    expect(canEmitEvent("plugin.installed", ["plugin.installed"])).toBe(false);
    expect(canEmitEvent("plugin.installed", ["email.new", "calendar.event"])).toBe(false);
    expect(canEmitEvent("host.theme.changed", ["host.theme.changed"])).toBe(false);
  });

  it("refuses a forged work_board emit even when the plugin declares it", () => {
    // Work Board events derive from host-owned rows; plugins must not spoof them.
    expect(canEmitEvent("work_board.work_item.due_soon", [])).toBe(false);
    expect(
      canEmitEvent("work_board.work_item.due_soon", ["work_board.work_item.due_soon"]),
    ).toBe(false);
    expect(canEmitEvent("work_board.report.generated", ["work_board.report.generated"])).toBe(false);
    expect(HOST_ONLY_EMIT_NAMESPACES.has("work_board")).toBe(true);
  });

  it("refuses a forged alert emit even when the plugin declares it", () => {
    // Alert events report host-accepted state and must not be spoofed.
    expect(canEmitEvent("alert.raised", [])).toBe(false);
    expect(canEmitEvent("alert.raised", ["alert.raised"])).toBe(false);
    expect(canEmitEvent("alert.withdrawn", ["alert.withdrawn"])).toBe(false);
    expect(HOST_ONLY_EMIT_NAMESPACES.has("alert")).toBe(true);
  });

  it("private namespaces reject plugin emit even when explicitly declared", () => {
    for (const eventType of [
      "memory.private.document",
      "settings.apiKey.openai",
      "audit.log",
      "dlp.redacted",
    ]) {
      expect(canEmitEvent(eventType, [eventType])).toBe(false);
    }
  });
});

describe("registerManifestEventSubscriptions namespace gate", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-event-ns-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    eventSubscriptions: string[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await writeEventPluginFixture(testDir, installedDir, registryPath, id, { eventSubscriptions }, extra);
  }

  function stubEventCollector(): {
    engine: { collectEvent(type: string, data: unknown): void };
    collected: Array<{ type: string; data: unknown }>;
  } {
    const collected: Array<{ type: string; data: unknown }> = [];
    const engine = {
      collectEvent(type: string, data: unknown) {
        collected.push({ type, data });
      },
    };
    return { engine, collected };
  }

  it("rejects subscription to a private namespace with warn", async () => {
    await writePlugin("p-priv", ["memory.private.leaked"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(
      warns.some((w) => /memory\.private\.leaked/.test(w) && /private namespace/.test(w)),
    ).toBe(true);
  });

  it("accepts a known public subscription silently", async () => {
    await writePlugin("p-pub", ["email.new"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => /email\.new/.test(w))).toBe(false);
  });

  it("accepts explicit host public events silently while keeping host namespace closed", async () => {
    await writePlugin("p-host-theme", ["host.theme.changed"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => /host\.theme\.changed/.test(w))).toBe(false);
  });

  it("allows unknown neutral subscription with a drift warning", async () => {
    await writePlugin("p-neutral", ["custom.thing"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(
      warns.some((w) => /custom\.thing/.test(w) && /outside public allowlist/.test(w)),
    ).toBe(true);
  });
});

describe("capability emit gate", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-event-emit-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    emittedEvents: string[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await writeEventPluginFixture(testDir, installedDir, registryPath, id, { emittedEvents }, extra);
  }

  /** Exercise the production emit predicate: only declared gated namespaces pass. */
  function makeEmitGate(runtime: PluginRuntime, pluginId: string) {
    const emitted: Array<{ type: string; data: unknown }> = [];
    const warns: string[] = [];
    const guardedEmit = (type: string, data?: unknown) => {
      const manifest = runtime.getPluginManifest(pluginId);
      const declaredEmittedEvents = manifest ? getDeclaredEmittedEvents(manifest) : [];
      if (!canEmitEvent(type, declaredEmittedEvents)) {
        const required = requiredCapabilityForEmit(type);
        warns.push(
          `plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${required}'`,
        );
        return;
      }
      emitted.push({ type, data });
    };
    return { guardedEmit, emitted, warns };
  }

  it("drops email.* emission from a plugin that did not declare the email namespace", async () => {
    await writePlugin("p-no-mail", ["custom.ping"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-no-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(warns.some((w) => /missing capability 'mail-source'/.test(w))).toBe(true);
  });

  it("passes email.* emission from a plugin declaring email.* in emittedEvents", async () => {
    await writePlugin("p-mail", ["email.new"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toEqual([{ type: "email.new", data: { subject: "hi" } }]);
    expect(warns).toEqual([]);
  });

  it("does not gate emit when the namespace has no EVENT_NAMESPACE_CAPABILITY entry", async () => {
    // Runtime-bound pluginId establishes identity independently of namespace declarations.
    await writePlugin("p-custom", []);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-custom");
    guardedEmit("custom.event", { foo: 1 });

    expect(emitted).toEqual([{ type: "custom.event", data: { foo: 1 } }]);
    expect(warns).toEqual([]);
  });

  it("loads a plugin declaring legacy/unknown capability strings under the relaxed schema", async () => {
    // Capability strings are free-form manifest data, including legacy and unknown values.
    await writePlugin("p-legacy", [], {
      capabilities: ["worker-client", "mail-source", "totally-legacy-cap"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const manifest = runtime.getPluginManifest("p-legacy");
    expect(manifest).toBeDefined();
    expect(manifest?.capabilities).toEqual([
      "worker-client",
      "mail-source",
      "totally-legacy-cap",
    ]);
  });

  it("suppresses email.* emit from a plugin declaring the legacy mail-source CAPABILITY but no emittedEvents (no capability fallback)", async () => {
    // A legacy capability must not unlock an undeclared event namespace.
    await writePlugin("p-legacy", [], {
      capabilities: ["worker-client", "mail-source", "totally-legacy-cap"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-legacy");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(warns.some((w) => /missing capability 'mail-source'/.test(w))).toBe(true);
  });
});
