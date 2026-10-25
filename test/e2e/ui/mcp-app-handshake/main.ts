// Use production protocol, partition policy and preload modules so security wiring is exercised directly.
import { app, BrowserWindow, protocol } from "electron";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMcpAppPartitionPolicy } from "../../../../src/main/html-preview-partition.js";
import {
  createMcpAppProxySession,
  MCP_APP_CUSTOM_SCHEME,
} from "../../../../src/main/mcp-app-protocol.js";
import { mcpAppPartitionName } from "../../../../src/shared/mcp-app-partition.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ID = "e2e-mcp-server";

// Register before app readiness, as production does.
protocol.registerSchemesAsPrivileged([MCP_APP_CUSTOM_SCHEME]);

app.on("web-contents-created", (_e, contents) => {
  contents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined;
    const message =
      first && typeof first === "object" && "message" in first
        ? first.message
        : (args[2] as string | undefined);
    if (typeof message === "string" && message.startsWith("E2E_")) {
      process.stdout.write(`${message}\n`);
    }
  });
});

app.whenReady().then(() => {
  installMcpAppPartitionPolicy(SERVER_ID);
  const proxyUrl = createMcpAppProxySession(SERVER_ID);

  // Serve the stock guest document without host transport shims.
  const innerJs = readFileSync(join(HERE, "mcp-app-handshake-inner.js"), "utf-8");
  const innerHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${innerJs}</script></body></html>`;

  const hostJs = readFileSync(join(HERE, "mcp-app-handshake-host.js"), "utf-8");
  const dir = mkdtempSync(join(tmpdir(), "ave-mcp-app-e2e-"));
  const hostHtmlPath = join(dir, "host.html");
  writeFileSync(hostHtmlPath, `<!doctype html><html><body><script>${hostJs}</script></body></html>`, "utf-8");

  const win = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(
      `window.__startHandshake(${JSON.stringify({
        proxyUrl,
        partition: mcpAppPartitionName(SERVER_ID),
        html: innerHtml,
      })})`,
    );
  });

  void win.loadFile(hostHtmlPath);
});
