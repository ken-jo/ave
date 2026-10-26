// Request deliberately weak webview preferences to prove that main enforces hardening instead of echoing renderer attributes.
import { describe, expect, it, vi } from "vitest";

// The side browser's guard reads `session` only when its policy is installed, which these tests never do.
vi.mock("electron", () => ({ session: {} }));

import {
  configureAuthWebviewAttach,
  configureMainWindowWebviewAttach,
  configureMcpAppWebviewAttach,
  configurePluginWebviewAttach,
} from "../plugin-webview-attach.js";
import { pluginPartitionName } from "../../shared/plugin-partition.js";
import { MCP_APP_PARTITION_PREFIX, mcpAppPartitionName } from "../../shared/mcp-app-partition.js";
import { PRELOAD_BUNDLES } from "../../shared/preload-bundles.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";

// What a compromised or mistyped renderer would ask for.
function weakRequest(): Record<string, unknown> {
  return {
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    webviewTag: true,
  };
}

describe("plugin webview attach", () => {
  it("overrides every weakened preference on a plugin partition", () => {
    const webPreferences = weakRequest();
    const result = configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("meeting") },
    });

    expect(result).toBe("enforced");
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it("closes node reachability in all three forms, not just the headline one", () => {
    // `nodeIntegration: false` alone still leaves workers and subframes, which are separate preferences with their own defaults.
    const webPreferences = weakRequest();
    configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("local-indexer") },
    });
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
  });

  it("stops a plugin frame from embedding further guest views", () => {
    // A nested webview would attach with preferences this guard has no branch for, which is how enforcement gets skipped one level down.
    const webPreferences = weakRequest();
    configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("samplemail") },
    });
    expect(webPreferences.webviewTag).toBe(false);
  });

  it("enforces for every plugin id, not a fixed list", () => {
    for (const pluginId of ["meeting", "samplemail", "sampleportal", "sampleassistant", "unknown-future"]) {
      const webPreferences = weakRequest();
      const result = configurePluginWebviewAttach({
        webPreferences,
        params: { partition: pluginPartitionName(pluginId) },
      });
      expect(result, pluginId).toBe("enforced");
      expect(webPreferences.contextIsolation, pluginId).toBe(true);
    }
  });

  describe("partitions it must not claim", () => {
    it.each([
      [AVE_SIDE_BROWSER_PARTITION, "the side browser, which has its own handler"],
      ["", "no partition at all"],
      ["persist:plugin:", "the prefix with no hash"],
      ["persist:plugin:XYZ", "a non-hex hash"],
      ["persist:plugin:abc", "a hash of the wrong length"],
      ["persist:plugin:0123456789ab", "a hash that is too long"],
      ["persist:evil:00000000", "a lookalike namespace"],
    ])("ignores %s (%s)", (partition) => {
      const webPreferences = weakRequest();
      const result = configurePluginWebviewAttach({ webPreferences, params: { partition } });

      expect(result).toBe("ignored");
      // Untouched, so the handler that DOES own this partition still sees the request as it arrived.
      expect(webPreferences).toEqual(weakRequest());
    });
  });

  it("recognises exactly what pluginPartitionName produces", () => {
    // The predicate and the constructor drifting apart would turn enforcement off silently, which is the failure this whole module exists to prevent.
    const partition = pluginPartitionName("some-plugin");
    expect(partition).toMatch(/^persist:plugin:[0-9a-f]{8}$/);
    expect(
      configurePluginWebviewAttach({ webPreferences: weakRequest(), params: { partition } }),
    ).toBe("enforced");
  });
});

const attachEvent = () => ({ preventDefault: vi.fn() });
const proxyUrl = (serverId: string) => `ave-mcp-app://${mcpAppPartitionName(serverId).slice(MCP_APP_PARTITION_PREFIX.length)}/proxy.html?t=abc`;

describe("auth window webview attach", () => {
  const url = "https://login.example.com/authorize?state=s";
  const partition = "ephemeral-auth-00";

  it("embeds only its own authorization URL", () => {
    const event = { preventDefault: vi.fn() };
    const webPreferences = { ...weakRequest(), preload: "C:/host/preload.cjs" };
    expect(configureAuthWebviewAttach({ event, webPreferences, params: { src: "https://other.example.com/" }, url, partition })).toBe("blocked");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(webPreferences.preload).toBe("C:/host/preload.cjs");
  });

  it("strips host privileges and pins the login partition", () => {
    const event = { preventDefault: vi.fn() };
    const webPreferences: Record<string, unknown> = { ...weakRequest(), preload: "C:/host/preload.cjs", partition: "persist:main" };
    expect(configureAuthWebviewAttach({ event, webPreferences, params: { src: url }, url, partition })).toBe("enforced");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(webPreferences.preload).toBeUndefined();
    expect(webPreferences).toMatchObject({
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, partition,
    });
  });
});

describe("MCP app webview attach", () => {
  it("drops any preload the element names and enforces the relay's sandbox from the table", () => {
    const event = attachEvent();
    const webPreferences: Record<string, unknown> = { ...weakRequest(), preload: "file:///evil.cjs", preloadURL: "file:///evil.cjs", additionalArguments: ["--x"] };
    const result = configureMcpAppWebviewAttach({
      event,
      webPreferences,
      params: { partition: mcpAppPartitionName("weather"), src: proxyUrl("weather") },
    });

    expect(result).toBe("enforced");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(webPreferences).not.toHaveProperty("preload");
    expect(webPreferences).not.toHaveProperty("preloadURL");
    expect(webPreferences).not.toHaveProperty("additionalArguments");
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: PRELOAD_BUNDLES.mcpAppPreload.sandbox,
      webSecurity: true,
      webviewTag: false,
    });
    expect(webPreferences.sandbox).toBe(true);
  });

  it.each([
    ["another server's proxy", mcpAppPartitionName("weather"), proxyUrl("calendar")],
    ["a web page", mcpAppPartitionName("weather"), "https://example.com/"],
    ["no first URL", mcpAppPartitionName("weather"), ""],
    ["a partition token that is not hex", `${MCP_APP_PARTITION_PREFIX}zz`, "ave-mcp-app://zz/proxy.html"],
  ])("refuses %s", (_label, partition, src) => {
    const event = attachEvent();
    const webPreferences = weakRequest();
    expect(configureMcpAppWebviewAttach({ event, webPreferences, params: { partition, src } })).toBe("blocked");
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores partitions that are not MCP app partitions", () => {
    const webPreferences = weakRequest();
    const event = attachEvent();
    expect(configureMcpAppWebviewAttach({ event, webPreferences, params: { partition: pluginPartitionName("meeting"), src: "" } })).toBe("ignored");
    expect(webPreferences).toEqual(weakRequest());
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("main window webview attach", () => {
  const attach = (partition: string, src: string) => {
    const event = attachEvent();
    const webPreferences = weakRequest();
    const result = configureMainWindowWebviewAttach({
      event,
      webPreferences,
      params: { partition, src },
    });
    return { result, event, webPreferences };
  };

  it("hands each guest to the guard that owns its partition", () => {
    const plugin = attach(pluginPartitionName("meeting"), "file:///plugin-ui-shell.html");
    expect(plugin.result).toEqual({ owner: "plugin", result: "enforced" });
    expect(plugin.webPreferences.sandbox).toBe(true);

    const mcpApp = attach(mcpAppPartitionName("weather"), proxyUrl("weather"));
    expect(mcpApp.result).toEqual({ owner: "mcp-app", result: "enforced" });
    expect(mcpApp.webPreferences.sandbox).toBe(true);
    expect(mcpApp.webPreferences.nodeIntegration).toBe(false);

    const side = attach(AVE_SIDE_BROWSER_PARTITION, "https://example.com/");
    expect(side.result).toEqual({ owner: "side-browser", result: "accepted" });
    for (const guest of [plugin, mcpApp, side]) expect(guest.event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["", "no partition"],
    ["persist:other", "a partition no guard owns"],
    ["persist:plugin:XYZ", "a plugin lookalike"],
  ])("refuses a guest on %s (%s) instead of attaching it with the renderer's request", (partition) => {
    const guest = attach(partition, "file:///anything.html");
    expect(guest.result).toEqual({ owner: null, result: "refused" });
    expect(guest.event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("refuses an MCP app guest whose first URL is not its server's proxy", () => {
    const guest = attach(mcpAppPartitionName("weather"), "https://example.com/");
    expect(guest.result).toEqual({ owner: "mcp-app", result: "blocked" });
    expect(guest.event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
