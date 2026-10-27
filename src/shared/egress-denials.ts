/** Proxy-deny records as the audit log stores them and Settings shows them. Shared by main (the sandbox audit
 * channel, `audit/sandbox-audit.ts`) and the renderer (Settings → Permissions → Network), so both read one shape. */

/** Who opened the refused connection. The egress token itself is never recorded. */
export type EgressDenialSource =
  | { kind: "shell"; toolName: "bash" | "powershell"; toolUseId: string | null }
  | { kind: "terminal"; tabId: string }
  | { kind: "user-document"; action: "workbook" }
  | {
      kind: "worker";
      role: "plugin-child" | "worker" | "hook" | "mcp-server";
      pluginId: string | null;
      instanceId: string | null;
    }
  /** A key no live invocation held: forged, stale, or absent. */
  | { kind: "unattributed" };

export interface EgressDenial {
  /** Which proxy refusal this was, from ASRT's violation line. */
  action: "network-outbound" | "http-request" | "socks-tunnel";
  host: string;
  port: number | null;
  /** HTTP method, for an `http-request` deny. */
  method: string | null;
  /** The refused URL with its path DLP-masked, for an `http-request` deny. */
  url: string | null;
  /** ASRT's reason, DLP-masked. */
  reason: string;
}

/** One row of the Settings list. */
export interface EgressDenialRow {
  timestamp: string;
  source: EgressDenialSource;
  deny: EgressDenial;
}

/** The window the Settings list covers. */
export const RECENT_EGRESS_DENIALS_WINDOW_HOURS = 24;
/** The most rows the Settings list shows, newest first. */
export const RECENT_EGRESS_DENIALS_LIMIT = 200;
