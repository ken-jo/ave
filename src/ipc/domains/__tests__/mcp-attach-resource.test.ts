import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { USER_PROMPT_RATE_LIMIT_MAX_CALLS } from "../../../boot/steps/plugin-runtime/trigger-gate.js";
import {
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
} from "../../../shared/mcp-resource-template-bounds.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

const CHANNEL = "ave:mcp:attach-resource";
const invoke = makeAppIpcInvoker(handlers);

async function setup(
  readDeclaredResource?: ReturnType<typeof vi.fn>,
  readDeclaredResourceTemplate?: ReturnType<typeof vi.fn>,
) {
  handlers.clear();
  vi.clearAllMocks();
  // Unique server ids isolate the module-wide rate limiter.
  const serverId = `hr-mcp-${Math.random().toString(36).slice(2, 10)}`;
  const readMock =
    readDeclaredResource ??
    vi.fn(async () => ({
      blocks: [{ uri: "file:///policy.md", mimeType: "text/markdown", text: "POLICY BODY" }],
      droppedBlocks: 0,
      truncated: false,
    }));
  const templateReadMock =
    readDeclaredResourceTemplate ??
    vi.fn(async () => ({
      blocks: [{ uri: "file:///project/a.md", mimeType: "text/markdown", text: "TEMPLATE BODY" }],
      droppedBlocks: 0,
      truncated: false,
      uri: "file:///project/a.md",
    }));

  const deps = {
    pluginRuntime: { getPerfStats: vi.fn(() => ({})) },
    pluginLoopbackManager: { has: vi.fn(() => true), readUiResource: vi.fn() },
    mcpManager: {
      readUiResource: vi.fn(),
      listServers: vi.fn(() => []),
      listDeclaredResources: vi.fn(() => []),
      namespacedToolName: vi.fn(),
      getPrompt: vi.fn(),
      readDeclaredResource: readMock,
      listDeclaredResourceTemplates: vi.fn(() => []),
      readDeclaredResourceTemplate: templateReadMock,
    },
    toolRegistry: { size: 0, findByName: vi.fn() },
    getPluginToolInvoker: () => vi.fn(),
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger: { log: vi.fn() },
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginEventBridge: vi.fn(),
    conversationLoop: { getSessionId: vi.fn(() => "session-live"), queueGuidance: vi.fn() },
    notificationService: { fire: vi.fn() },
    getMainWindow: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
    })),
    getAppWindows: vi.fn(() => []),
  };

  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, serverId, readMock, templateReadMock };
}

beforeEach(() => {
  handlers.clear();
});

describe("ave:mcp:attach-resource — sender gate", () => {
  it("rejects an unauthorized sender frame before reaching the server", async () => {
    const { serverId, readMock } = await setup();
    const handler = handlers.get(CHANNEL)!;
    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      "file:///policy.md",
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("ave:mcp:attach-resource — outcome", () => {
  it("returns a host-built fenced attachment, ready to send verbatim", async () => {
    const { serverId, readMock } = await setup();
    const result = (await invoke(CHANNEL, serverId, "file:///policy.md")) as {
      ok: boolean;
      attachment: { type: string; text: string };
    };
    expect(result.ok).toBe(true);
    expect(result.attachment.type).toBe("text");
    expect(result.attachment.text.startsWith('<mcp-resource trust="untrusted-server-data"')).toBe(true);
    expect(result.attachment.text).toContain(`server="${serverId}"`);
    expect(result.attachment.text).toContain("POLICY BODY");
    expect(result.attachment.text.endsWith("</mcp-resource>")).toBe(true);
    expect(readMock).toHaveBeenCalledWith(serverId, "file:///policy.md");
  });

  it("refuses a URI shape the host would never catalogue, before any request", async () => {
    const { serverId, readMock } = await setup();
    for (const uri of [
      "ui://widget/main.html", // the MCP-Apps serving path — different containment
      "javascript:alert(1)",
      "no-scheme",
      "",
      42,
    ]) {
      const result = await invoke(CHANNEL, serverId, uri);
      expect(result, String(uri).slice(0, 32)).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  // Validate serverId bounds before rate-key allocation or audit storage.
  it("refuses a serverId that cannot be a server id", async () => {
    const { readMock } = await setup();
    for (const bad of ["bad id with spaces", "s".repeat(500), "-leading-dash", ""]) {
      const result = await invoke(CHANNEL, bad, "file:///policy.md");
      expect(result, bad.slice(0, 24)).toEqual({ ok: false, error: "invalid-server-id" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  it("fails closed on an empty render and on a server error", async () => {
    const empty = await setup(vi.fn(async () => ({ blocks: [], droppedBlocks: 0, truncated: false })));
    expect(await invoke(CHANNEL, empty.serverId, "file:///x")).toEqual({
      ok: false,
      error: "empty-resource",
    });

    const boom = await setup(
      vi.fn(async () => {
        throw new Error("ENOENT: C:/Users/secret/path leaked");
      }),
    );
    const failed = (await invoke(CHANNEL, boom.serverId, "file:///x")) as { ok: boolean; error: string };
    expect(failed).toEqual({ ok: false, error: "resource-failed" });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("reports a clip rather than presenting a partial resource as whole", async () => {
    const { serverId } = await setup(
      vi.fn(async () => ({
        blocks: [{ text: "HEAD" }, { omittedKind: "binary" }],
        droppedBlocks: 3,
        truncated: true,
      })),
    );
    const result = (await invoke(CHANNEL, serverId, "file:///x")) as {
      truncated: boolean;
      omittedBlocks: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.omittedBlocks).toBe(1);
  });

  // Resource and prompt requests share one budget per server; other servers retain independent budgets.
  it("rate limits per server, and shares the budget with prompts/get", async () => {
    const { deps, serverId } = await setup();
    const other = `${serverId}-other`;

    let limited = false;
    for (let i = 0; i <= USER_PROMPT_RATE_LIMIT_MAX_CALLS; i += 1) {
      const result = (await invoke(CHANNEL, serverId, "file:///x")) as { error?: string };
      if (result.error === "rate-limited") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    expect(await invoke(CHANNEL, other, "file:///x")).toMatchObject({ ok: true });

    const promptResult = await invoke("ave:mcp:get-prompt", serverId, "summarize", {});
    expect(promptResult).toMatchObject({ ok: false, error: "rate-limited" });
    expect(deps.mcpManager.getPrompt).not.toHaveBeenCalled();
  });
});

describe("ave:mcp:list-resources — the picker's catalogue", () => {
  it("returns the host's ONE projection, not a re-derived list", async () => {
    const { deps } = await setup();
    const catalogue = [
      { serverId: "hr-mcp", resources: [{ uri: "file:///policy.md", name: "policy.md" }] },
    ];
    deps.mcpManager.listDeclaredResources.mockReturnValue(catalogue);

    const result = await invoke("ave:mcp:list-resources");

    expect(result).toEqual({ ok: true, servers: catalogue });
    expect(deps.mcpManager.listDeclaredResources).toHaveBeenCalled();
  });

  it("rejects an unauthorized sender frame", async () => {
    const { deps } = await setup();
    const handler = handlers.get("ave:mcp:list-resources")!;
    const result = await handler({ senderFrame: { url: "https://evil.example.com/x" } } as never);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(deps.mcpManager.listDeclaredResources).not.toHaveBeenCalled();
  });
});

describe("ave:mcp:list-resource-templates — the offers half of the catalogue", () => {
  it("returns the host's template projection verbatim", async () => {
    const { deps } = await setup();
    const catalogue = [
      {
        serverId: "hr-mcp",
        templates: [
          { uriTemplate: "file:///project/{path}", name: "Project file", variables: ["path"] },
        ],
      },
    ];
    deps.mcpManager.listDeclaredResourceTemplates.mockReturnValue(catalogue as never);

    expect(await invoke("ave:mcp:list-resource-templates")).toEqual({
      ok: true,
      servers: catalogue,
    });
  });

  it("rejects an unauthorized sender frame", async () => {
    const { deps } = await setup();
    const handler = handlers.get("ave:mcp:list-resource-templates")!;
    const result = await handler({ senderFrame: { url: "https://evil.example.com/x" } } as never);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(deps.mcpManager.listDeclaredResourceTemplates).not.toHaveBeenCalled();
  });
});

describe("ave:mcp:attach-resource-template — filling an offer", () => {
  const TEMPLATE_CHANNEL = "ave:mcp:attach-resource-template";

  it("rejects an unauthorized sender frame before reaching the server", async () => {
    const { serverId, templateReadMock } = await setup();
    const handler = handlers.get(TEMPLATE_CHANNEL)!;
    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      "file:///project/{path}",
      { path: "a.md" },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  it("passes the TEMPLATE and a Map of values, and fences what main read", async () => {
    const { serverId, templateReadMock } = await setup();
    const result = (await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: "a.md",
    })) as { ok: boolean; uri: string; attachment: { text: string } };

    expect(result.ok).toBe(true);
    // Use a Map for renderer-supplied variable names so __proto__ stays an ordinary key.
    const [, template, values] = templateReadMock.mock.calls[0] as [string, string, unknown];
    expect(template).toBe("file:///project/{path}");
    expect(values).toBeInstanceOf(Map);
    expect((values as Map<string, string>).get("path")).toBe("a.md");
    expect(result.uri).toBe("file:///project/a.md");
    expect(result.attachment.text).toContain('uri="file:///project/a.md"');
    expect(result.attachment.text).toContain("TEMPLATE BODY");
  });

  it("refuses a template shape the host would never catalogue, before any request", async () => {
    const { serverId, templateReadMock } = await setup();
    for (const uriTemplate of [
      "file:///project/{+path}", // reserved expansion — the traversal operator
      "file:///project/{path*}",
      "ui://widget/{id}",
      "file:///project/README.md", // a concrete URI is not a template
      "javascript:alert({x})",
      "",
      42,
    ]) {
      const result = await invoke(TEMPLATE_CHANNEL, serverId, uriTemplate, { path: "a.md" });
      expect(result, String(uriTemplate).slice(0, 32)).toEqual({
        ok: false,
        error: "invalid-request",
      });
    }
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  it("refuses a serverId that cannot be a server id", async () => {
    const { templateReadMock } = await setup();
    for (const bad of ["bad id with spaces", "s".repeat(500), "-leading-dash", ""]) {
      const result = await invoke(TEMPLATE_CHANNEL, bad, "file:///project/{path}", {});
      expect(result, bad.slice(0, 24)).toEqual({ ok: false, error: "invalid-server-id" });
    }
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  it("carries a prototype-shaped variable name as an ordinary key", async () => {
    const { serverId, templateReadMock } = await setup();
    // Build __proto__ as an own JSON property; object-literal syntax would only set the prototype.
    const values = JSON.parse('{"__proto__":"PAYLOAD","toString":"SECOND"}') as
      Record<string, string>;
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{__proto__}/{toString}", values);
    const carried = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect(carried.get("__proto__")).toBe("PAYLOAD");
    expect(carried.get("toString")).toBe("SECOND");
    expect(Object.getPrototypeOf(carried)).toBe(Map.prototype);
  });

  it("drops keys no catalogued template could have declared", async () => {
    const { serverId, templateReadMock } = await setup();
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: "notes.md",
      "not a name": "dropped",
      "": "dropped",
      nested: { toString: () => "not a string" },
    });
    const values = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect([...values.keys()]).toEqual(["path"]);
    expect(values.get("path")).toBe("notes.md");
  });

  // Reject overlong path variables instead of clipping them into a different resource.
  it("refuses an over-long value rather than clipping it into another resource", async () => {
    const { serverId, templateReadMock } = await setup();
    const overLong = "v".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS + 1);

    expect(await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", { path: overLong }))
      .toEqual({ ok: false, error: "invalid-request" });
    expect(templateReadMock).not.toHaveBeenCalled();

    const atLimit = "v".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS);
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", { path: atLimit });
    const values = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect(values.get("path")).toBe(atLimit);
  });

  // Requests rejected before a server round-trip must not consume the server's request budget.
  it("does not spend the rate budget on a request it refuses", async () => {
    const { serverId, templateReadMock } = await setup();
    for (let i = 0; i <= USER_PROMPT_RATE_LIMIT_MAX_CALLS + 5; i += 1) {
      const result = await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
        path: "v".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS + 1),
      });
      expect(result).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", { path: "a.md" }))
      .toMatchObject({ ok: true });
    expect(templateReadMock).toHaveBeenCalledTimes(1);
  });

  it("bounds how many variables one request may carry", async () => {
    const { serverId, templateReadMock } = await setup();
    const many = Object.fromEntries(
      Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES + 5 }, (_, i) => [`v${i}`, "x"]),
    );
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", many);
    const values = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect(values.size).toBe(MCP_RESOURCE_TEMPLATE_MAX_VARIABLES);
  });

  it("fails closed on an empty read and on a server error", async () => {
    const empty = await setup(
      undefined,
      vi.fn(async () => ({
        blocks: [],
        droppedBlocks: 0,
        truncated: false,
        uri: "file:///project/a.md",
      })),
    );
    expect(
      await invoke(TEMPLATE_CHANNEL, empty.serverId, "file:///project/{path}", { path: "a.md" }),
    ).toEqual({ ok: false, error: "empty-resource" });

    const boom = await setup(
      undefined,
      vi.fn(async () => {
        throw new Error("ENOENT: C:/Users/secret/path leaked");
      }),
    );
    const failed = await invoke(TEMPLATE_CHANNEL, boom.serverId, "file:///project/{path}", {
      path: "a.md",
    });
    expect(failed).toEqual({ ok: false, error: "resource-failed" });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("shares the user-initiated rate bucket with the plain attach", async () => {
    const { serverId, templateReadMock } = await setup();
    let limited = false;
    for (let i = 0; i <= USER_PROMPT_RATE_LIMIT_MAX_CALLS; i += 1) {
      const result = (await invoke(CHANNEL, serverId, "file:///x")) as { error?: string };
      if (result.error === "rate-limited") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    const result = await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: "a.md",
    });
    expect(result).toMatchObject({ ok: false, error: "rate-limited" });
    expect(templateReadMock).not.toHaveBeenCalled();
  });
});
