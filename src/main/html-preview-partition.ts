// The main-process request gate protects LLM-authored HTML even if renderer CSP is bypassed. Untrusted MCP apps use separate lazy per-server partitions,
// opened only to origins declared by that server’s resources.
import { createRequire } from "node:module";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDER_HTML_PARTITION } from "../shared/render-html-preview.js";
import { mcpAppPartitionName } from "../shared/mcp-app-partition.js";
import { runtimeAssetPath } from "./main-paths.js";
import { installPluginAssetProtocolHandler, PLUGIN_ASSET_SCHEME } from "./plugin-asset-protocol.js";
import { preloadBundlePath } from "./preload-bundles.js";
import {
  installMcpAppProtocolHandler,
  isDeclaredOriginForServer,
  isMcpAppPermissionGranted,
  MCP_APP_SCHEME,
} from "./mcp-app-protocol.js";

const require = createRequire(import.meta.url);
// This module may be emitted into `dist/src/main/chunks/*.js`; asset paths must stay anchored at the real `dist/src` directory rather than this chunk.
const pluginShellHtmlPath = normalize(runtimeAssetPath("plugin-ui-shell.html"));
const pluginShellJsPath = normalize(runtimeAssetPath("plugin-ui-shell.js"));
const pluginPreloadPath = preloadBundlePath("pluginPreload");
const mcpAppPreloadPath = preloadBundlePath("mcpAppPreload");

type SessionApi = { fromPartition(partition: string): Electron.Session };

function getElectronSession(): SessionApi {
  return require("electron").session as SessionApi;
}

function installStrictInlineOnly(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

// Derive the per-server origin union and per-resource CSP from the same sanitized declarations; CSP remains the tighter frame boundary.
function installDeclaredOriginGate(ses: Electron.Session, serverId: string): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      // Permit the host proxy scheme; its handler rejects unknown tokens or server-authority mismatches.
      if (url.protocol === `${MCP_APP_SCHEME}:`) {
        callback({ cancel: false });
        return;
      }
      // Local, inline-only schemes: not exfiltration channels.
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      if (url.protocol === "https:" && isDeclaredOriginForServer(serverId, url.origin)) {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

// Request handlers carry mediaTypes arrays while check handlers carry one mediaType; drop unknown kinds and enforce strict per-kind grants on requests.
function extractMediaKinds(details: unknown): ("video" | "audio")[] {
  if (!details || typeof details !== "object") return [];
  const d = details as { mediaTypes?: unknown; mediaType?: unknown };
  const raw = Array.isArray(d.mediaTypes)
    ? d.mediaTypes
    : d.mediaType !== undefined
      ? [d.mediaType]
      : [];
  return raw.filter((k): k is "video" | "audio" => k === "video" || k === "audio");
}

// Install both permission request and check handlers; each must deny undeclared features using the host-minted proxy token.
// Camera and microphone require media-kind checks; never accept permissions supplied by a frame or renderer.
function installDeclaredPermissionGate(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isMcpAppPermissionGranted(webContents?.getURL(), permission, extractMediaKinds(details)));
  });
  ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) =>
    isMcpAppPermissionGranted(webContents?.getURL() ?? undefined, permission, extractMediaKinds(details)),
  );
}

// Block plugin UI network requests; tools use the bridge. Track installed partition policies so reattachment cannot stack handlers.
const installedPluginPartitions = new Set<string>();

// Install each server partition policy once so card rerenders cannot stack request handlers.
const installedMcpAppPartitions = new Set<string>();

// Install network gating, proxy CSP handling, and relay preload before reading a server resource so its first guest request is protected.
// Partition setup failure throws; never mount a card on an ungated session.
export function installMcpAppPartitionPolicy(
  serverId: string,
  sessionApi: SessionApi = getElectronSession(),
): void {
  const partitionName = mcpAppPartitionName(serverId);
  if (installedMcpAppPartitions.has(partitionName)) return;
  installedMcpAppPartitions.add(partitionName);

  const ses = sessionApi.fromPartition(partitionName);
  installDeclaredOriginGate(ses, serverId);

  // Deny-by-default powerful-feature gate. Installed on the SAME per-server session as the network gate, so a card cannot reach a feature — or a host — it never declared.
  installDeclaredPermissionGate(ses);

  // Serves the host-owned sandbox-proxy document (`ave-mcp-app://…/proxy.html`) with its Content-Security-Policy RESPONSE HEADER — the envelope the inner app frame inherits.
  installMcpAppProtocolHandler(partitionName, ses);

  // Register a host-resolved session frame preload before guest loading; sandboxed webviews ignore element preloads and attach hooks strip them.
  // Servers must never nominate executable preloads; resolve assets independently of bundled chunk depth.
  ses.registerPreloadScript({ type: "frame", filePath: mcpAppPreloadPath });
}

function isAllowedPluginShellFile(url: URL): boolean {
  if (url.protocol !== "file:") return false;
  try {
    const filePath = normalize(fileURLToPath(url));
    return filePath === pluginShellHtmlPath || filePath === pluginShellJsPath;
  } catch {
    return false;
  }
}

export function installPluginPartitionPolicy(
  partitionName: string,
  options: { pluginRoot?: string } = {},
  sessionApi: SessionApi = getElectronSession(),
): void {
  const ses = sessionApi.fromPartition(partitionName);
  // Unconditional: the scheme has to be on the session before the partition's first frame loads, and the root is allowed to arrive later. See
  // `installPluginAssetProtocolHandler`.
  installPluginAssetProtocolHandler(partitionName, ses, options.pluginRoot);
  if (installedPluginPartitions.has(partitionName)) return;
  installedPluginPartitions.add(partitionName);

  // Register the frame preload before sandboxed webviews load; the preload attribute alone is silently ignored.
  ses.registerPreloadScript({ type: "frame", filePath: pluginPreloadPath });

  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (
        isAllowedPluginShellFile(url) ||
        url.protocol === `${PLUGIN_ASSET_SCHEME}:` ||
        url.protocol === "data:" ||
        url.protocol === "blob:" ||
        url.protocol === "about:"
      ) {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

export function installHtmlPreviewPartitionBlock(sessionApi: SessionApi = getElectronSession()): void {
  // LLM-authored HTML: strict inline-only partition. The MCP-app partition policy is NOT installed here — it is a PER-SERVER partition (b1) installed
  // lazily in the `ave:mcp:ui-resource` chokepoint via `installMcpAppPartitionPolicy`. There is no bare `ave-mcp-app` partition anymore.
  installStrictInlineOnly(sessionApi.fromPartition(RENDER_HTML_PARTITION));
}
