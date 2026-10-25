// Exercise production bridge wiring so fixture reimplementations cannot hide integration failures.
import { createMcpAppBridge } from "../../../../src/ui/renderer/components/mcp-app-bridge.js";
import type { BridgeWebviewElement } from "../../../../src/ui/renderer/components/webview-ipc-transport.js";

declare global {
  interface Window {
    __startHandshake: (opts: { proxyUrl: string; partition: string; html: string }) => void;
  }
}

window.__startHandshake = ({ proxyUrl, partition, html }) => {
  const webview = document.createElement("webview");
  // Set partition before src because guest attachment binds it.
  webview.setAttribute("partition", partition);
  webview.setAttribute(
    "webpreferences",
    "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
  );
  webview.setAttribute("src", proxyUrl);
  webview.style.width = "600px";
  webview.style.height = "300px";
  document.body.appendChild(webview);

  const { bridge, connected } = createMcpAppBridge(
    { serverId: "e2e-mcp-server" },
    html,
    webview as unknown as BridgeWebviewElement,
    // Empty host context isolates handshake behavior from theming.
    {},
    // Handshake does not invoke these adapters; no-ops satisfy the bridge contract.
    {
      onResize: () => {},
      openLink: async () => ({ ok: false }),
      callTool: async () => ({ ok: false as const, error: "not-wired-in-e2e-harness" }),
      postMessage: async () => ({ ok: false as const, error: "not-wired-in-e2e-harness" }),
      getDisplayMode: () => "inline" as const,
      applyDisplayMode: async () => "inline" as const,
      downloadFile: async () => ({
        ok: false as const,
        error: "not-wired-in-e2e-harness",
        message: "not wired in the e2e harness",
      }),
      updateModelContext: async () => ({
        ok: false as const,
        error: "not-wired-in-e2e-harness",
        message: "not wired in the e2e harness",
      }),
    },
  );

  // Add an independent listener without replacing the production readiness handler.
  bridge.addEventListener("sandboxready", () => console.log("E2E_HOST SANDBOX_READY"));

  // This marker requires the unmodified guest to complete initialization across the guest boundary.
  bridge.oninitialized = () => console.log("E2E_HOST HANDSHAKE_OK");

  connected
    .then(() => console.log("E2E_HOST BRIDGE_CONNECTED"))
    .catch((err: unknown) => console.log(`E2E_HOST BRIDGE_CONNECT_FAILED:${String(err)}`));
};
