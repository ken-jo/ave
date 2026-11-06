// Request deliberately weak webview preferences to prove that main enforces hardening instead of echoing renderer attributes.
import { describe, expect, it, vi } from "vitest";

// The side browser's guard reads `session` only when its policy is installed, which these tests never do.
vi.mock("electron", () => ({ session: {} }));

import {
  configureAuthWebviewAttach,
  configureMainWindowWebviewAttach,
  configureMcpAppWebviewAttach,
} from "../webview-attach.js";
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

  it.each(["ep", "git", "viewfixture"])("attaches a URL-safe proxy for %s", (serverId) => {
    const event = attachEvent();
    expect(configureMcpAppWebviewAttach({
      event, webPreferences: weakRequest(),
      params: { partition: mcpAppPartitionName(serverId), src: proxyUrl(serverId) },
    })).toBe("enforced");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["another server's proxy", mcpAppPartitionName("weather"), proxyUrl("calendar")],
    ["a web page", mcpAppPartitionName("weather"), "https://example.com/"],
    ["no first URL", mcpAppPartitionName("weather"), ""],
    ["an unprefixed authority", `${MCP_APP_PARTITION_PREFIX}6162`, "ave-mcp-app://6162/proxy.html"],
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
    expect(configureMcpAppWebviewAttach({ event, webPreferences, params: { partition: "persist:plugin:removed", src: "" } })).toBe("ignored");
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
    const mcpApp = attach(mcpAppPartitionName("weather"), proxyUrl("weather"));
    expect(mcpApp.result).toEqual({ owner: "mcp-app", result: "enforced" });
    expect(mcpApp.webPreferences.sandbox).toBe(true);
    expect(mcpApp.webPreferences.nodeIntegration).toBe(false);

    const side = attach(AVE_SIDE_BROWSER_PARTITION, "https://example.com/");
    expect(side.result).toEqual({ owner: "side-browser", result: "accepted" });
    for (const guest of [mcpApp, side]) expect(guest.event.preventDefault).not.toHaveBeenCalled();
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
