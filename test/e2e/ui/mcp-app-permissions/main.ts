// Use production protocol, policy and relay modules for permission probes.
import { app, BrowserWindow, protocol } from "electron";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMcpAppPartitionPolicy } from "../../../../src/main/html-preview-partition.js";
import {
  createMcpAppProxySession,
  disposeMcpAppProxySession,
  MCP_APP_CUSTOM_SCHEME,
} from "../../../../src/main/mcp-app-protocol.js";
import { mcpAppPartitionName } from "../../../../src/shared/mcp-app-partition.js";
import type { McpUiResourcePermissions } from "../../../../src/mcp/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ID = "e2e-perm-server";

// Declarations are inputs; probes determine which capabilities the host actually honors.
const ALL_FOUR: McpUiResourcePermissions = {
  clipboardWrite: {},
  camera: {},
  microphone: {},
  geolocation: {},
};

// A microphone-only grant must not authorize camera despite their shared runtime permission kind.
const MIC_ONLY: McpUiResourcePermissions = { microphone: {} };

protocol.registerSchemesAsPrivileged([MCP_APP_CUSTOM_SCHEME]);

// Keep the app alive between sequential probe windows.
app.on("window-all-closed", () => {});

const doneWaiters = new Map<string, () => void>();

app.on("web-contents-created", (_e, contents) => {
  contents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined;
    const message =
      first && typeof first === "object" && "message" in first
        ? first.message
        : (args[2] as string | undefined);
    if (typeof message !== "string" || !message.startsWith("E2E_")) return;
    process.stdout.write(`${message}\n`);
    for (const [label, resolve] of doneWaiters) {
      if (message === `E2E_PROBE ${label} DONE`) {
        doneWaiters.delete(label);
        resolve();
      }
    }
  });
});

// Record delivered DOM policy separately from whether the runtime honors it.
async function reportFrame(win: BrowserWindow, label: string): Promise<void> {
  const json = await win.webContents
    .executeJavaScript(
      `new Promise((res) => {
         const wv = document.querySelector("webview");
         wv.executeJavaScript(\`(() => {
           const f = document.querySelector("iframe");
           const m = document.querySelector('meta[name="ave-mcp-app-allow"]');
           return JSON.stringify({
             allow: f ? f.getAttribute("allow") : null,
             sandbox: f ? f.getAttribute("sandbox") : null,
             meta: m ? m.getAttribute("content") : null,
           });
         })()\`).then(res, (e) => res(JSON.stringify({ error: String(e) })));
       })`,
    )
    .catch((err: unknown) => JSON.stringify({ error: String(err) }));
  process.stdout.write(`E2E_PROBE ${label} FRAME:${json}\n`);
}

// Revoke sessions after policy delivery to isolate the runtime permission-handler refusal.
async function runCard(
  hostHtmlPath: string,
  card: { label: string; proxyUrl: string; html: string },
  revokeToken = false,
): Promise<void> {
  const win = new BrowserWindow({
    show: true,
    width: 500,
    height: 320,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const done = new Promise<void>((resolve) => doneWaiters.set(card.label, resolve));

  if (revokeToken) {
    const token = new URL(card.proxyUrl).searchParams.get("t") ?? "";
    win.webContents.on("did-attach-webview", (_e, guest) => {
      guest.on("did-finish-load", () => {
        if (!guest.getURL().startsWith("ave-mcp-app:")) return;
        disposeMcpAppProxySession(token);
        process.stdout.write(`E2E_PROBE ${card.label} SESSION_REVOKED\n`);
      });
    });
  }

  win.webContents.on("did-finish-load", () => {
    win.show();
    win.focus();
    void win.webContents.executeJavaScript(
      `window.__startProbe(${JSON.stringify({
        serverId: SERVER_ID,
        partition: mcpAppPartitionName(SERVER_ID),
        card,
      })})`,
    );
  });

  await win.loadFile(hostHtmlPath);
  await done;
  await reportFrame(win, card.label);
  win.destroy();
}

app.whenReady().then(async () => {
  installMcpAppPartitionPolicy(SERVER_ID);


  const declaredUrl = createMcpAppProxySession(SERVER_ID, undefined, ALL_FOUR);
  const absentUrl = createMcpAppProxySession(SERVER_ID, undefined, undefined);
  const revokedUrl = createMcpAppProxySession(SERVER_ID, undefined, ALL_FOUR);
  const micOnlyUrl = createMcpAppProxySession(SERVER_ID, undefined, MIC_ONLY);

  const probeJs = readFileSync(join(HERE, "mcp-app-permissions-probe.js"), "utf-8");
  // Keep probe documents identical apart from the label to isolate declaration effects.
  const cardHtml = (label: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<script>window.__CASE=${JSON.stringify(label)};</script>` +
    `<script>${probeJs}</script></body></html>`;

  const hostJs = readFileSync(join(HERE, "mcp-app-permissions-host.js"), "utf-8");
  const dir = mkdtempSync(join(tmpdir(), "ave-mcp-app-perm-e2e-"));
  const hostHtmlPath = join(dir, "host.html");
  writeFileSync(
    hostHtmlPath,
    `<!doctype html><html><body><script>${hostJs}</script></body></html>`,
    "utf-8",
  );

  await runCard(hostHtmlPath, {
    label: "declared",
    proxyUrl: declaredUrl,
    html: cardHtml("declared"),
  });
  await runCard(hostHtmlPath, { label: "absent", proxyUrl: absentUrl, html: cardHtml("absent") });
  await runCard(
    hostHtmlPath,
    { label: "revoked", proxyUrl: revokedUrl, html: cardHtml("revoked") },
    true,
  );
  await runCard(hostHtmlPath, {
    label: "mic-only",
    proxyUrl: micOnlyUrl,
    html: cardHtml("mic-only"),
  });

  process.stdout.write("E2E_PROBE ALL_DONE\n");
});
