/** Verify natural-name plugin tool registration and delegated calls through the production loopback host. */
import { afterEach, describe, it, expect, vi } from "vitest";
import { LoopbackTransport } from "../loopback-transport.js";
import { META_CLIENT_INFO } from "../protocol-constants.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createPluginUiResourceProvider } from "../plugin-ui-resource-provider.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  markPluginWorkerWrapped,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
} from "../../permissions/sandbox-capability.js";
import { publishTestHost, testLoopbackHost } from "./plugin-mcp-test-helpers.js";

const UNKNOWN_META_PREFIX = "xyz.example/";

const MANIFEST: PluginManifest = {
  id: "com.example.notes",
  name: "Notes",
  version: "1.4.2",
  entry: "dist/index.js",
  description: "note ops",
  tools: [
    {
      name: "notes_read",
      description: "Read a note",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: { ui: { visibility: ["model"] }, "ave/pathFields": ["path"] },
    },
    {
      name: "notes_save",
      description: "Save a note",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "ave/pathFields": ["path"] },
    },
  ],
};

describe("PluginMcpHost — first-party loopback registration + round-trip", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetWrappedPluginWorkersForTest();
  });

  it("registers plugin tools under natural names with plugin authority from _meta", async () => {
    const delegate: PluginToolDelegate = vi.fn(async (name, args) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      _meta: {
        ui: {
          resourceUri: "ui://notes/read.html",
          csp: { connectSrc: ["https://api.example.com"] },
        },
      },
    }));
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);

    const registered = await publishTestHost(host, MANIFEST.id, registry);

    expect(registered).toEqual(["notes_read", "notes_save"]);

    const read = registry.findByName("notes_read");
    expect(read?.source).toBe("plugin");
    expect(read?.pluginId).toBe("com.example.notes");
    // The wire cannot attest risk; register the strict baseline and derive effective risk in the host.
    expect(read?.category).toBe("write");
    expect(read?.pathFields).toEqual(["path"]);
    expect(read?.version).toBe("1.0.0");

    const save = registry.findByName("notes_save");
    expect(save?.category).toBe("write");
    // Never trust wire worker identity or sandbox claims to relax review.
    expect(save?.workerId).toBeUndefined();
    expect(save?.writesToOwnSandbox).toBeUndefined();

    const result = await read!.execute({ path: "/a.md" }, {} as never);
    expect(delegate).toHaveBeenCalledWith("notes_read", { path: "/a.md" });
    expect(result).toMatchObject({
      output: 'notes_read:{"path":"/a.md"}',
      isError: false,
      metadata: {
        uiPayload: { resourceUri: "ui://notes/read.html" },
      },
    });
    // CSP comes only from resource metadata, never the tool result.
    expect(
      (result.metadata as { uiPayload?: Record<string, unknown> }).uiPayload,
    ).not.toHaveProperty("csp");
  });

  it("fails preparation when the wire operation policy differs from the signed Tool", async () => {
    const manifest = structuredClone(MANIFEST);
    manifest.tools[0]._meta = {
      ...manifest.tools[0]._meta,
      "ave/operationPolicy": {
        discriminant: "operation",
        operations: { read: { kind: "read", minimumRisk: "read", appVisible: true } },
      },
    };
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      manifest,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );
    manifest.tools[0]._meta!["ave/operationPolicy"] = {
      discriminant: "operation",
      operations: { write: { kind: "write", minimumRisk: "write", appVisible: true } },
    };

    await expect(host.prepareTools()).rejects.toThrow(/differs from its signed manifest/);
    expect(registry.findByName("notes_read")).toBeUndefined();
  });

  it("accepts and registers an unchanged signed operation policy from the loopback wire", async () => {
    const manifest = structuredClone(MANIFEST);
    const policy = {
      discriminant: "operation" as const,
      operations: {
        read: {
          kind: "read" as const,
          minimumRisk: "read" as const,
          appVisible: true,
        },
      },
    };
    manifest.tools[0] = {
      ...manifest.tools[0],
      inputSchema: {
        type: "object",
        properties: { operation: { const: "read" } },
        required: ["operation"],
        additionalProperties: false,
      },
      _meta: {
        ...manifest.tools[0]._meta,
        ui: { visibility: ["model", "app"] },
        "ave/operationPolicy": policy,
      },
    };
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      manifest,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );

    await publishTestHost(host, manifest.id, registry);

    expect(registry.findByName("notes_read")?.operationPolicy).toEqual(policy);
  });

  it("IGNORES a rawResult under an unknown vendor _meta prefix — only ave/rawResult is read", async () => {
    // Read raw result data only from the owned metadata key.
    const delegate: PluginToolDelegate = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { [`${UNKNOWN_META_PREFIX}rawResult`]: { note: "structured" } },
    }));
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/a.md" }, {} as never);
    expect(result.metadata).toBeUndefined();
  });

  it("reads ave/rawResult (and ignores a stray unknown-vendor key)", async () => {
    const delegate: PluginToolDelegate = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: {
        "ave/rawResult": { from: "new" },
        [`${UNKNOWN_META_PREFIX}rawResult`]: { from: "unknown" },
      },
    }));
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/a.md" }, {} as never);
    expect((result.metadata as { rawResult?: unknown }).rawResult).toEqual({ from: "new" });
  });

  it("keeps manifest workerId inert on the loopback path even when a worker marker exists", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("com.example.notes", "notes-worker");

    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );
    await publishTestHost(host, MANIFEST.id, registry);

    const save = registry.findByName("notes_save");
    expect(save?.workerId).toBeUndefined();
    expect(
      resolveReviewerSandboxCapability(
        save!.source,
        save!.name,
        save!.mcpServerId,
        save!.workerId,
        save!.pluginId,
      ).kind,
    ).toBe("none");
  });

  it("surfaces a thrown delegate as an isError tool result (not a host throw)", async () => {
    const delegate: PluginToolDelegate = async () => {
      throw new Error("note locked");
    };
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("note locked");
  });

  it("retires through an inactive registry publication before transport disposal", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);
    expect(registry.findByName("notes_read")).toBeDefined();

    registry.reservePluginReplacement(MANIFEST.id, [], []).publish();
    await host.dispose();
    expect(registry.findByName("notes_read")).toBeUndefined();
    expect(registry.findByName("notes_save")).toBeUndefined();
  });

  it("drops a tool whose inputSchema fails the #1182 provider-strict lint (parity)", async () => {
    const badManifest: PluginManifest = {
      id: "com.example.bad",
      name: "Bad",
      version: "1.0.0",
      entry: "dist/index.js",
      description: "bad",
      tools: [
        {
          name: "good_tool",
          description: "fine",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
        {
          name: "bad_tool",
          description: "array without items — OpenAI/Azure 400",
          inputSchema: { type: "object", properties: { tags: { type: "array" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    };
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(badManifest, delegate, registry);

    const registered = await publishTestHost(host, badManifest.id, registry);
    expect(registered).toEqual(["good_tool"]);
    expect(registry.findByName("bad_tool")).toBeUndefined();
  });

  it("rejects preparation after publication", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);
    await expect(host.prepareTools()).rejects.toThrow(/already started/);
  });

  it("readUiResource round-trips resources/read through the loopback to the provider", async () => {
    const provider = createPluginUiResourceProvider({
      pluginId: "com.example.notes",
      declarations: [
        {
          uri: "ui://com.example.notes/read.html",
          csp: { connectDomains: ["https://api.example.com"] },
        },
      ],
      readHtml: async () => "<h1>note</h1>",
    });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
      provider,
    );
    await publishTestHost(host, MANIFEST.id, registry);

    const res = await host.readUiResource("ui://com.example.notes/read.html");
    expect(res).toEqual({
      html: "<h1>note</h1>",
      csp: { connectDomains: ["https://api.example.com"] },
    });
  });

  it("readUiResource rejects a cross-namespace uri (fail-closed, no served body)", async () => {
    const provider = createPluginUiResourceProvider({
      pluginId: "com.example.notes",
      declarations: [{ uri: "ui://com.example.notes/read.html" }],
      readHtml: async () => "<h1>note</h1>",
    });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
      provider,
    );
    await publishTestHost(host, MANIFEST.id, registry);
    await expect(host.readUiResource("ui://other-plugin/read.html")).rejects.toThrow(/own namespace/i);
  });
});

describe("PluginMcpHost — RC request meta", () => {
  it("advertises the running app version as clientInfo on every request", async () => {
    const send = vi.spyOn(LoopbackTransport.prototype, "send");
    try {
      const registry = new ToolRegistry();
      const host = testLoopbackHost(MANIFEST, vi.fn(async () => ({ content: [] })), registry);
      await publishTestHost(host, MANIFEST.id, registry);

      expect(send.mock.calls.length).toBeGreaterThan(0);
      for (const [message] of send.mock.calls) {
        const params = (message as { params?: { _meta?: Record<string, unknown> } }).params;
        expect(params?._meta?.[META_CLIENT_INFO]).toEqual({ name: "ave", version: getAveAppVersion() });
      }
    } finally {
      send.mockRestore();
    }
  });
});
