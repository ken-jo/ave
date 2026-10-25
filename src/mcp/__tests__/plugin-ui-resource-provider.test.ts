/** Serve only declared own-namespace cards using manifest policy; reject before invoking the serving hook. */
import { describe, it, expect, vi } from "vitest";
import {
  createPluginUiResourceProvider,
  MCP_APP_MIME_TYPE,
} from "../plugin-ui-resource-provider.js";
import type { PluginUiResourceDecl } from "../types.js";

const PLUGIN_ID = "acme-cards";

const DECLS: PluginUiResourceDecl[] = [
  {
    uri: `ui://${PLUGIN_ID}/hello.html`,
    csp: { connectDomains: ["https://api.acme.example"] },
    permissions: { geolocation: {} },
  },
  { uri: `ui://${PLUGIN_ID}/plain.html` },
];

function providerWith(cards: Record<string, string>, declarations = DECLS) {
  const readHtml = vi.fn(async (uri: string) => {
    const body = cards[uri];
    if (body === undefined) throw new Error(`plugin has no card '${uri}'`);
    return body;
  });
  return { provider: createPluginUiResourceProvider({ pluginId: PLUGIN_ID, declarations, readHtml }), readHtml };
}

describe("createPluginUiResourceProvider — plugin ui:// serving chokepoint", () => {
  it("serves a declared own-namespace resource: plugin HTML + the MANIFEST's csp", async () => {
    const uri = `ui://${PLUGIN_ID}/hello.html`;
    const { provider, readHtml } = providerWith({ [uri]: "<h1>hello</h1>" });

    const res = await provider.read(uri);
    expect(res.html).toBe("<h1>hello</h1>");
    expect(res.csp).toEqual({ connectDomains: ["https://api.acme.example"] });
    expect(readHtml).toHaveBeenCalledWith(uri);
  });

  it("serves a declared resource that omits the csp (undefined ⇒ the host's default policy)", async () => {
    const uri = `ui://${PLUGIN_ID}/plain.html`;
    const res = await providerWith({ [uri]: "<p>plain</p>" }).provider.read(uri);
    expect(res.html).toBe("<p>plain</p>");
    expect(res.csp).toBeUndefined();
    expect(res.permissions).toBeUndefined();
  });

  it("attaches the MANIFEST's declared permissions, never the plugin hook's return", async () => {
    // Serving hooks return bytes only; permissions come from the reviewed manifest.
    const uri = `ui://${PLUGIN_ID}/hello.html`;
    const res = await providerWith({ [uri]: "<h1>hi</h1>" }).provider.read(uri);
    expect(res.permissions).toEqual({ geolocation: {} });
  });

  it("rejects a uri whose authority is a DIFFERENT plugin (own-namespace-only, fail-closed)", async () => {
    const { provider, readHtml } = providerWith({ "ui://evil-plugin/hello.html": "<h1>pwn</h1>" }, [
      { uri: "ui://evil-plugin/hello.html" },
    ]);
    await expect(provider.read("ui://evil-plugin/hello.html")).rejects.toThrow(/own namespace/i);
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("rejects an undeclared uri in its OWN namespace — without asking the plugin", async () => {
    const undeclared = `ui://${PLUGIN_ID}/nope.html`;
    const { provider, readHtml } = providerWith({ [undeclared]: "<h1>undeclared</h1>" });
    await expect(provider.read(undeclared)).rejects.toThrow(/no declared ui:\/\/ resource/i);
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("rejects a non-ui:// scheme", async () => {
    await expect(providerWith({}).provider.read(`https://${PLUGIN_ID}/hello.html`)).rejects.toThrow(
      /own namespace/i,
    );
  });

  it("fails closed when the plugin's serving hook rejects (no body)", async () => {
    const provider = createPluginUiResourceProvider({
      pluginId: PLUGIN_ID,
      declarations: DECLS,
      readHtml: async () => {
        throw new Error("readUiResource timed out");
      },
    });
    await expect(provider.read(`ui://${PLUGIN_ID}/hello.html`)).rejects.toThrow(/timed out/i);
  });

  it("lists declared resources with the mcp-app mime", () => {
    expect(providerWith({}).provider.list()).toEqual([
      { uri: `ui://${PLUGIN_ID}/hello.html`, mimeType: MCP_APP_MIME_TYPE },
      { uri: `ui://${PLUGIN_ID}/plain.html`, mimeType: MCP_APP_MIME_TYPE },
    ]);
  });
});
