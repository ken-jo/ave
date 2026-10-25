// Mount permission probes through the production bridge so host-computed policy reaches the real frame.
import { createMcpAppBridge } from "../../../../src/ui/renderer/components/mcp-app-bridge.js";
import type { BridgeWebviewElement } from "../../../../src/ui/renderer/components/webview-ipc-transport.js";

declare global {
  interface Window {
    __startProbe: (opts: {
      card: { label: string; proxyUrl: string; html: string };
      partition: string;
      serverId: string;
    }) => void;
  }
}

// Run one focused card at a time; unfocused clipboard calls can look falsely denied.
window.__startProbe = ({ card, partition, serverId }) => {
  const webview = document.createElement("webview");
  // Set partition before src because attachment binds it.
  webview.setAttribute("partition", partition);
  webview.setAttribute(
    "webpreferences",
    "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
  );
  webview.setAttribute("src", card.proxyUrl);
  webview.style.width = "400px";
  webview.style.height = "200px";
  document.body.appendChild(webview);
  // Establish the guest focus chain before the inner frame requests clipboard access.
  webview.addEventListener("dom-ready", () => webview.focus());

  const { connected } = createMcpAppBridge(
    { serverId },
    card.html,
    webview as unknown as BridgeWebviewElement,
    {},
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

  connected.catch((err: unknown) =>
    console.log(`E2E_PROBE ${card.label} BRIDGE_CONNECT_FAILED:${String(err)}`),
  );
};
