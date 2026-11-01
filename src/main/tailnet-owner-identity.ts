import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isRecord } from "../shared/is-record.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { TailnetOwnerIdentityErrorCode } from "../shared/tailnet-sharing.js";

export class TailnetOwnerIdentityError extends Error {
  constructor(readonly code: TailnetOwnerIdentityErrorCode) { super(code); this.name = "TailnetOwnerIdentityError"; }
}

/** The local node, not a peer request, selects its owner profile. Tagged nodes have no user owner. */
export function tailnetOwnerLoginFromStatus(status: unknown): string | null {
  if (!isRecord(status) || status.BackendState !== "Running" || !isRecord(status.Self) || !isRecord(status.User)) return null;
  if (status.Self.Tags !== undefined && (!Array.isArray(status.Self.Tags) || status.Self.Tags.length > 0)) return null;
  const id = status.Self.UserID;
  if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0 || typeof id === "string" && /^[1-9]\d*$/.test(id))) return null;
  const user = status.User[String(id)];
  if (!isRecord(user) || typeof user.LoginName !== "string" || user.LoginName !== user.LoginName.trim() || !user.LoginName || user.LoginName.length > 512 || /[\u0000-\u001f\u007f]/.test(user.LoginName)) return null;
  return user.LoginName;
}

/** Fresh read-only daemon status is required even at synchronous effect-entry guards. */
export function readTailnetOwnerLogin(): string | null {
  const appCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const cli = process.platform === "darwin" && existsSync(appCli) ? appCli : "tailscale";
  try {
    return tailnetOwnerLoginFromStatus(JSON.parse(execFileSync(cli, ["status", "--json"], {
      encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.tailnetIdentityProbeMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })));
  } catch { return null; }
}

export function tailnetOwnerIdentityError(login: string, getOwnerLogin: () => string | null = readTailnetOwnerLogin): TailnetOwnerIdentityErrorCode | null {
  let owner: string | null = null;
  try { owner = getOwnerLogin(); } catch { /* Unreadable local identity grants nothing. */ }
  return owner === null ? "tailnet-owner-identity-unavailable" : owner !== login ? "tailnet-owner-identity-mismatch" : null;
}
