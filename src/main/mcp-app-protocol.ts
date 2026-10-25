// A privileged per-server proxy supplies an inherited CSP header and stable origin; app HTML travels over JSON-RPC. Main computes CSP from sanitized
// resource policy and binds each token to its server authority.
import type { Session } from "electron";
import { randomUUID } from "node:crypto";
import type { McpUiResourceCsp, McpUiResourcePermissions } from "../mcp/types.js";
import { MCP_APP_ALLOW_META_NAME } from "../shared/mcp-app-bridge-contract.js";
import { buildMcpCspHeader, declaredOrigins } from "../shared/mcp-app-csp.js";
import { encodeMcpServerId, MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";
import {
  buildMcpAppAllowAttr,
  isElectronPermissionGranted,
} from "../shared/mcp-app-permissions.js";
import { escapeHtml } from "../shared/escape-html.js";

export { MCP_APP_SCHEME };

// Registered with the other privileged schemes in one call before `app.ready` (see `early-boot-env.ts`).
export const MCP_APP_CUSTOM_SCHEME: Electron.CustomScheme = Object.freeze({
  scheme: MCP_APP_SCHEME,
  privileges: Object.freeze({
    standard: true, // real origin (not opaque) — required for header CSP + partition binding
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  }),
});

type ProxySession = {
  serverId: string;
  // Effective CSP header string. Computed in main; never supplied by the renderer.
  csp: string;
  // The RESOURCE's declared permissions. Kept in its structured form (not just the serialized allow string) because the Electron session handlers need to
  // answer per-permission — including telling `camera` from `microphone`, which Electron collapses into one `media` permission.
  permissions?: McpUiResourcePermissions;
  // The `allow` attribute for the inner app frame. Computed in main from the closed feature table; never supplied by the renderer or the app.
  allow: string;
};

const proxySessions = new Map<string, ProxySession>();

// Network policy is the per-server union of declared origins; per-frame CSP separates resources within that server.
// Never grant undeclared origins or another server’s policy.
const declaredOriginsByServer = new Map<string, Set<string>>();

// Does `origin` appear in any resource this server declared? (network gate)
export function isDeclaredOriginForServer(serverId: string, origin: string): boolean {
  return declaredOriginsByServer.get(serverId)?.has(origin) ?? false;
}

// Permission authority lasts for the mounted card; explicit disposal reclaims it.
// The high FIFO cap only bounds leaks after missed disposal and must not evict plausible live-card counts.
const MAX_PROXY_SESSIONS = 4096;

// The token selects card CSP and grants; resource declarations are untrusted input from which main derives policy.
export function createMcpAppProxySession(
  serverId: string,
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions,
): string {
  const authority = encodeMcpServerId(serverId); // fail-closed on empty/over-length
  const token = randomUUID();
  proxySessions.set(token, {
    serverId,
    csp: buildMcpCspHeader(csp),
    permissions,
    allow: buildMcpAppAllowAttr(permissions),
  });

  // Keep the network gate in lockstep with the CSP: whatever this resource declared (and only that) becomes reachable at the webRequest layer too.
  const origins = declaredOriginsByServer.get(serverId) ?? new Set<string>();
  for (const origin of declaredOrigins(csp)) origins.add(origin);
  declaredOriginsByServer.set(serverId, origins);

  // Leak backstop only — see MAX_PROXY_SESSIONS. Reaching this bound means many disposes were missed; the authoritative reclaim is disposeMcpAppProxySession on card unmount.
  while (proxySessions.size > MAX_PROXY_SESSIONS) {
    const oldest = proxySessions.keys().next().value;
    if (oldest === undefined) break;
    proxySessions.delete(oldest);
  }
  return `${MCP_APP_SCHEME}://${authority}/proxy.html?t=${token}`;
}

// Dispose idempotently on card unmount; the leak cap must not replace authoritative lifetime cleanup.
export function disposeMcpAppProxySession(token: string): void {
  proxySessions.delete(token);
}

export function _resetMcpAppProxySessions(): void {
  proxySessions.clear();
  declaredOriginsByServer.clear();
}

// The token in a proxy URL — the only thing that identifies WHICH card (and therefore which declaration) a webContents is running. Returns undefined for
// any URL that is not one of ours, so a caller cannot accidentally key a decision off a foreign page.
function proxySessionForUrl(url: string | undefined): ProxySession | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${MCP_APP_SCHEME}:`) return undefined;
  const token = parsed.searchParams.get("t");
  if (!token) return undefined;
  const session = proxySessions.get(token);
  if (!session) return undefined;
  // Same fail-closed authority check the protocol handler makes: a URL whose authority is not its token's serverId is not a session we minted.
  if (parsed.hostname !== encodeMcpServerId(session.serverId)) return undefined;
  return session;
}

// Deny unknown frames, missing tokens, authority mismatches, absent declarations, and undeclared features.
// Bind to the top-level proxy URL; mediaKinds disambiguates camera from microphone.
export function isMcpAppPermissionGranted(
  frameUrl: string | undefined,
  permission: string,
  mediaKinds?: readonly ("video" | "audio")[],
): boolean {
  const session = proxySessionForUrl(frameUrl);
  if (!session) return false;
  return isElectronPermissionGranted(session.permissions, permission, mediaKinds);
}

// Keep the proxy script-free; isolated host preload owns relay and untrusted code runs only in the inner sandbox.
// Deliver host-computed frame permissions in the served document, never through renderer-controlled forwarding.
function proxyDocument(allow: string): string {
  const allowMeta = allow
    ? `<meta name="${MCP_APP_ALLOW_META_NAME}" content="${escapeHtml(allow)}">`
    : "";
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>MCP App</title>${allowMeta}
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
      iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; }
    </style>
  </head>
  <body></body>
</html>`;
}

const handledPartitions = new Set<string>();

// Idempotent per partition. Registered by `installMcpAppPartitionPolicy`.
export function installMcpAppProtocolHandler(partitionName: string, ses: Session): void {
  if (handledPartitions.has(partitionName)) return;
  handledPartitions.add(partitionName);

  ses.protocol.handle(MCP_APP_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad url", { status: 400 });
    }
    const token = url.searchParams.get("t");
    const session = token ? proxySessions.get(token) : undefined;
    if (!session) return new Response("unknown mcp app session", { status: 404 });

    // Fail-closed: the URL's authority MUST be the token's own serverId, so a proxy origin can never serve another server's session.
    if (url.hostname !== encodeMcpServerId(session.serverId)) {
      return new Response("mcp app session/authority mismatch", { status: 403 });
    }

    return new Response(proxyDocument(session.allow), {
      status: 200,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Content-Security-Policy": session.csp,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

export function _resetMcpAppProtocolHandlers(): void {
  handledPartitions.clear();
}
