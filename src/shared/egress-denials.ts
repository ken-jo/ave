/** Who opened the refused connection. The egress token itself is never recorded. */
export type EgressDenialSource =
  | { kind: "shell"; toolName: "bash" | "powershell"; toolUseId: string | null }
  | { kind: "terminal"; tabId: string }
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
