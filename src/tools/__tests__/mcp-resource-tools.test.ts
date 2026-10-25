// Resource tools carry read authority only and share client gates across callers.
// Hide server error details that expose host paths or enable probing; report clipping and refused resources explicitly.
import { describe, expect, it, vi } from "vitest";
import {
  createMcpResourceListTool,
  createMcpResourceReadTool,
  type McpResourceToolDeps,
} from "../mcp-resource-tools.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../../shared/mcp-resource-bounds.js";
import { MCP_RESOURCE_LIST_MAX_CHARS } from "../mcp-resource-tools.js";
import { parseJsonRecord as parse } from "../../__tests__/test-helpers.js";

const ctx = () => ({}) as never;

function deps(over: Partial<McpResourceToolDeps> = {}): McpResourceToolDeps {
  return {
    listResources: () => [
      {
        serverId: "hr-mcp",
        resources: [
          { uri: "file:///policy.md", name: "policy.md", mimeType: "text/markdown", size: 12 },
          { uri: "https://example.com/doc", name: "web doc", hostFetchRefused: true },
        ],
      },
      {
        serverId: "other-mcp",
        // Populate every optional field to exercise the full projection shape.
        resources: [{
          uri: "schema://users",
          name: "users",
          title: "Users table",
          description: "columns and types",
          mimeType: "application/json",
          size: 99,
        }],
      },
    ],
    readDeclaredResource: async () => ({
      blocks: [{ uri: "file:///policy.md", mimeType: "text/markdown", text: "BODY" }],
      droppedBlocks: 0,
      truncated: false,
    }),
    ...over,
  };
}

describe("mcp_resource_list", () => {
  it("is a read-only read-category tool", () => {
    const tool = createMcpResourceListTool(() => deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("lists every server, and narrows when serverId is given", async () => {
    const tool = createMcpResourceListTool(() => deps());
    const all = parse((await tool.execute({}, ctx())).output);
    expect((all.servers as unknown[]).length).toBe(2);

    const one = parse((await tool.execute({ serverId: "other-mcp" }, ctx())).output);
    expect(one.servers).toEqual([
      {
        serverId: "other-mcp",
        resources: [{
          uri: "schema://users",
          name: "users",
          title: "Users table",
          description: "columns and types",
          mimeType: "application/json",
          size: 99,
        }],
      },
    ]);
  });

  it("tells the model which resources the host will not fetch", async () => {
    // Keep refused resources visible so callers do not retry impossible reads.
    const tool = createMcpResourceListTool(() => deps());
    const out = parse((await tool.execute({}, ctx())).output);
    const first = (out.servers as Array<{ resources: Array<Record<string, unknown>> }>)[0];
    expect(first.resources[1]).toMatchObject({ hostFetchRefused: true });
    expect(first.resources[0].hostFetchRefused).toBeUndefined();
  });
});

describe("mcp_resource_read", () => {
  it("is a read-only read-category tool", () => {
    const tool = createMcpResourceReadTool(() => deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("returns the blocks the client produced", async () => {
    const readDeclaredResource = vi.fn(async () => ({
      blocks: [{ text: "BODY" }, { omittedKind: "binary" }],
      droppedBlocks: 3,
      truncated: true,
    }));
    const tool = createMcpResourceReadTool(() => deps({ readDeclaredResource }));
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(readDeclaredResource).toHaveBeenCalledWith("hr-mcp", "file:///policy.md");
    expect(out.blocks).toEqual([{ text: "BODY" }, { omittedKind: "binary" }]);
    // Report clipping so partial content cannot appear complete.
    expect(out.truncated).toBe(true);
    expect(out.droppedBlocks).toBe(3);
  });

  it("omits the clip fields when nothing was clipped", async () => {
    const tool = createMcpResourceReadTool(() => deps());
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(out.truncated).toBeUndefined();
    expect(out.droppedBlocks).toBeUndefined();
  });

  it("rejects a malformed or over-long request before calling the client", async () => {
    const readDeclaredResource = vi.fn();
    const tool = createMcpResourceReadTool(() => deps({ readDeclaredResource: readDeclaredResource as never }));
    for (const args of [
      {},
      { serverId: "hr-mcp" },
      { uri: "file:///x" },
      { serverId: "hr-mcp", uri: "" },
      { serverId: 42, uri: "file:///x" },
      { serverId: "hr-mcp", uri: `file:///${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}` },
    ]) {
      const result = await tool.execute(args, ctx());
      expect(result.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }
    expect(readDeclaredResource).not.toHaveBeenCalled();
  });

  it("never forwards the server's own failure text to the model", async () => {
    // Keep detailed errors host-side to prevent path disclosure and refusal probing.
    const tool = createMcpResourceReadTool(() =>
      deps({
        readDeclaredResource: async () => {
          throw new Error("ENOENT: C:/Users/secret/path leaked");
        },
      }),
    );
    const result = await tool.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("secret");
    expect(result.output).not.toContain("ENOENT");
  });
});

describe("resource tools — wiring and bounds", () => {
  // Tool registration precedes manager startup; distinguish not-ready from failed reads.
  it("says so when resource access is not wired yet", async () => {
    const list = createMcpResourceListTool(() => undefined);
    const read = createMcpResourceReadTool(() => undefined);
    const listed = await list.execute({}, ctx());
    const readOut = await read.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(listed.isError).toBe(true);
    expect(readOut.isError).toBe(true);
    expect(parse(listed.output).error).toBe(parse(readOut.output).error);
    const failing = createMcpResourceReadTool(() =>
      deps({ readDeclaredResource: async () => { throw new Error("boom"); } }),
    );
    const failed = await failing.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(parse(failed.output).error).not.toBe(parse(readOut.output).error);
  });

  it("resolves access per call, so a late-arriving manager is picked up", async () => {
    // Resolve lazily so registration-time undefined does not become permanent.
    let access: McpResourceToolDeps | undefined;
    const tool = createMcpResourceListTool(() => access);
    expect((await tool.execute({}, ctx())).isError).toBe(true);
    access = deps();
    const after = await tool.execute({}, ctx());
    expect(after.isError).toBe(false);
    expect((parse(after.output).servers as unknown[]).length).toBe(2);
  });

  it("bounds one list response and reports what it dropped", async () => {
    // Bound server count times catalogue size and disclose omitted servers.
    const many = Array.from({ length: 40 }, (_, s) => ({
      serverId: `srv-${s}`,
      resources: Array.from({ length: 50 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(200),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => many }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    expect((out.servers as unknown[]).length).toBeLessThan(many.length);
    // Assert the exact byte bound, including narrowed single-server responses.
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Name omitted servers so the caller can narrow by serverId.
    expect(Array.isArray(out.omittedServerIds)).toBe(true);
  });

  // One server's descriptions can exceed the budget even when discovery caps entry count.
  it("drops descriptions before resources, keeping most of the catalogue", async () => {
    const one = [{
      serverId: "srv",
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
        description: "d".repeat(2000),
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    // Resume offsets apply to a single server's catalogue.
    const rawOut = (await tool.execute({ serverId: "srv" }, ctx())).output;
    const out = parse(rawOut);
    const servers = out.servers as Array<{ serverId: string; resources: unknown[] }>;
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Drop descriptions before resource identities to preserve usable reads; completeness is not guaranteed.
    expect(out.descriptionsOmitted).toBe(true);
    expect(servers[0].resources.length).toBeGreaterThan(150);
    expect(out.omittedResources).toBe(200 - servers[0].resources.length);
    expect(out.nextOffset).toBe(servers[0].resources.length);
  });

  it("trims resources from a server too large even without descriptions", async () => {
    const one = [{
      serverId: "srv",
      // Long URIs leave only resource entries available to trim.
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///${"deep/".repeat(30)}f${i}`,
        name: `f${i}`,
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    const servers = out.servers as Array<{ serverId: string; resources: unknown[] }>;
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    expect(servers).toHaveLength(1);
    expect(servers[0].resources.length).toBeGreaterThan(0);
    expect(servers[0].resources.length).toBeLessThan(200);
    expect(out.omittedResources).toBe(200 - servers[0].resources.length);
  });

  // Omitted server IDs also consume the response budget, even when no resources remain.
  it("bounds the response even when almost everything is omitted", async () => {
    const many = Array.from({ length: 200 }, (_, s) => ({
      serverId: `srv-${"x".repeat(100)}-${s}`,
      resources: Array.from({ length: 20 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(500),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => many }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Cap named omissions and count the rest so truncation remains explicit.
    expect((out.omittedServerIds as string[]).length).toBeLessThanOrEqual(20);
    expect(out.unnamedOmittedServers).toBeGreaterThan(0);
  });

  // Source-trimmed content never reaches result-chunk paging, so resource access needs its own offset.
  it("lets the model page past what the host trimmed", async () => {
    const one = [{
      serverId: "srv",
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    const first = parse((await tool.execute({ serverId: "srv" }, ctx())).output);
    const firstServers = first.servers as Array<{ resources: Array<{ uri: string }> }>;
    expect(first.nextOffset).toBe(firstServers[0].resources.length);

    const second = parse(
      (await tool.execute({ serverId: "srv", offset: first.nextOffset }, ctx())).output,
    );
    const secondServers = second.servers as Array<{ resources: Array<{ uri: string }> }>;
    expect(secondServers[0].resources[0].uri)
      .toBe(`file:///f${firstServers[0].resources.length}`);
    const lastUri = secondServers[0].resources[secondServers[0].resources.length - 1].uri;
    expect(lastUri).toBe("file:///f199");
    expect(second.nextOffset).toBeUndefined();
  });

  // Offsets require serverId; one shared cursor would skip entries across independent catalogues.
  it("refuses to page a multi-server response with one cursor", async () => {
    const two = [0, 1].map((s) => ({
      serverId: `srv-${s}`,
      resources: Array.from({ length: 60 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(200),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => two }));
    const first = parse((await tool.execute({}, ctx())).output);
    expect(first.nextOffset).toBeUndefined();
    const paged = await tool.execute({ offset: 40 }, ctx());
    expect(paged.isError).toBe(true);
    expect(String(parse(paged.output).error)).toContain("serverId");

    // Dropping descriptions alone may fit a narrowed catalogue without a resume cursor.
    const narrowed = parse((await tool.execute({ serverId: "srv-1" }, ctx())).output);
    const shown = (narrowed.servers as Array<{ resources: unknown[] }>)[0].resources.length;
    expect(shown).toBe(60);
    expect(narrowed.nextOffset).toBeUndefined();
    expect(narrowed.descriptionsOmitted).toBe(true);
  });

  it("rejects a malformed offset instead of guessing", async () => {
    const tool = createMcpResourceListTool(() => deps());
    for (const offset of [-1, 1.5, "3", Number.NaN]) {
      const result = await tool.execute({ offset }, ctx());
      expect(result.isError, String(offset)).toBe(true);
    }
  });

  it("tells the model which argument was wrong", async () => {
    // List guidance must not request uri, which the list schema rejects.
    const tool = createMcpResourceListTool(() => deps());
    const out = parse((await tool.execute({ serverId: 42 }, ctx())).output);
    expect(String(out.error)).toContain("serverId");
    expect(String(out.error)).not.toContain("uri");
  });

  it("declares the MCP scope dependency on both tools", () => {
    // These builtins expose untrusted server content and must honor includeMcp scope in headless loops.
    expect(createMcpResourceListTool(() => deps()).requiresMcpScope).toBe(true);
    expect(createMcpResourceReadTool(() => deps()).requiresMcpScope).toBe(true);
  });
});
