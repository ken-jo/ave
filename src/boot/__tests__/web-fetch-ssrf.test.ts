import { describe, expect, it, vi } from "vitest";
import { registerBuiltinTools } from "../tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { registerStandardCategories } from "../../permissions/category-registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

/** Reject private and reserved destinations before transport; DNS prechecks need no live request. */
describe("web_fetch SSRF guard", () => {
  function makeWebFetchTool(
    workflowDeps: Parameters<typeof registerBuiltinTools>[2] = {
      networkFetch: unusedNetworkFetch,
      singleHopNetworkFetch: unusedNetworkFetch,
    },
  ) {
    const registry = new ToolRegistry();
    const settingsStub = {
      get: () => ({ provider: "duckduckgo" }),
      getSecret: () => null,
    } as unknown as Parameters<typeof registerBuiltinTools>[1];
    registerBuiltinTools(registry, settingsStub, workflowDeps);
    const tool = registry
      .getVisibleTools()
      .find((t) => t.name === "web_fetch");
    if (!tool) throw new Error("web_fetch not registered");
    return tool;
  }

  it("rejects http://localhost with isError=true and no network hit", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "http://localhost/secret" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address|did not resolve|http and https/i);
  });

  it("rejects http://127.0.0.1", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "http://127.0.0.1/" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  it("rejects AWS metadata endpoint 169.254.169.254", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  it("rejects file:// scheme", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "file:///etc/passwd" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/http and https/i);
  });

  it("keeps the network category for every destination", () => {
    const tool = makeWebFetchTool();

    // All model-chosen fetches are network egress; risk screening decides which requests prompt.
    expect(tool.category).toBe("network");
    expect(tool.categoryForInput?.({
      url: "https://example.com/page",
    })).toBe("network");
    expect(tool.categoryForInput?.({
      url: "http://10.10.1.209:8080/status",
      allowPrivateNetwork: true,
    })).toBe("network");
  });

  it("remembers an approval per destination host, not per URL", () => {
    const tool = makeWebFetchTool();

    // Scope persistent grants by host so they bound destinations without being page-specific.
    expect(tool.approvalCacheKey?.({
      url: "https://docs.example.org/guide/install",
    })).toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({
      url: "https://DOCS.example.ORG/other/page?q=1",
    })).toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({
      url: "https://other.example.org/guide",
    })).not.toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({ url: "not a url" })).toBeUndefined();
  });

  it("keeps a private-network grant distinct from the public one for the same host", () => {
    const tool = makeWebFetchTool();

    const privateKey = tool.approvalCacheKey?.({
      url: "http://10.10.1.209:8080/status",
      allowPrivateNetwork: true,
    });
    const publicKey = tool.approvalCacheKey?.({
      url: "http://10.10.1.209:8080/status",
    });
    expect(privateKey).toBe("web_fetch:host:private-network:10.10.1.209");
    expect(publicKey).toBe("web_fetch:host:10.10.1.209");
    expect(privateKey).not.toBe(publicKey);
  });

  it("does not reuse the bare web_fetch allow rule for private network access", () => {
    registerStandardCategories();
    const pm = new PermissionManager();
    pm.setRules([{ pattern: "web_fetch", action: "allow" }]);

    const publicDecision = pm.checkDetailed("web_fetch", "builtin", "network", null, {});
    expect(publicDecision.decision).toBe("allow");

    const privateDecision = pm.checkDetailed(
      "web_fetch",
      "builtin",
      "network",
      null,
      { approvalCacheKey: "web_fetch:host:private-network:10.10.1.209" },
    );
    expect(privateDecision.decision).toBe("ask");
  });

  it("still rejects loopback when private network access is requested", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute(
      { url: "http://127.0.0.1/", allowPrivateNetwork: true },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  // The guard owns redirect validation and must receive redirect responses from its transport.
  it("runs tool calls on the injected single-hop Electron transport", async () => {
    const singleHopNetworkFetch = vi.fn(async () =>
      new Response("<html><body>resolved through electron</body></html>", { status: 200 }),
    );
    const networkFetch = vi.fn(async () => new Response("must not be used"));
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as unknown as typeof fetch,
      singleHopNetworkFetch: singleHopNetworkFetch as unknown as typeof fetch,
    });

    const result = await tool.execute(
      { url: "http://10.10.1.209/page", allowPrivateNetwork: true },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(singleHopNetworkFetch).toHaveBeenCalledOnce();
    expect(networkFetch).not.toHaveBeenCalled();
    expect(result.output).toContain("resolved through electron");
  });

});
