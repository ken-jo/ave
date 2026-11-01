import { runTailscaleCommand, tailscaleCliPath } from "./tailnet-cli.js";
import { createLogger } from "../lib/logger.js";
import { isRecord } from "../shared/is-record.js";
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

const log = createLogger("tailnet-owner-identity");

/** Each admission owns a fresh asynchronous daemon observation; no owner allow is cached here. */
export async function readTailnetOwnerLogin(): Promise<string | null> {
  let category: string;
  try {
    const result = await runTailscaleCommand(tailscaleCliPath(process.platform), ["status", "--json"]);
    if (result.kind === "not-found") category = "ENOENT";
    else if (result.kind === "failed") category = result.category === "timeout" ? "timeout" : "execution-failed";
    else if (result.code !== 0) category = "nonzero-exit";
    else {
      let status: unknown;
      try { status = JSON.parse(result.stdout); } catch {
        log.warn("Owner identity probe unavailable: %s", "invalid-json");
        return null;
      }
      const login = tailnetOwnerLoginFromStatus(status);
      if (login !== null) return login;
      category = "owner-unavailable";
    }
  } catch { category = "execution-failed"; }
  log.warn("Owner identity probe unavailable: %s", category);
  return null;
}
