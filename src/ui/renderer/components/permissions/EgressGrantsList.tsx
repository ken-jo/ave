/** Settings → Permissions → Network: the hosts a sandboxed shell may reach without asking because someone chose "This session", "This tab" (a workspace terminal), "This project" or "Always" on an egress ask, each with a Revoke button. A project or always grant
 * names its origin (agent shell calls or workspace terminals): it covers only that origin. Revoking also closes the connections that grant let through that are still open. "Allow once" grants end with their call and are not listed. Plugin workers never use these grants. */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ListedEgressGrant, RevocableEgressGrant } from "../../../../shared/egress-grant-scopes.js";
import { formatDateTime } from "../../../../shared/format-time.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { isIpcErrorResult } from "../../types.js";

interface EgressGrantsListProps {
  /** Override fetcher for tests. Defaults to window.ave.permission.egressGrantsList. */
  readonly fetcher?: () => Promise<unknown>;
  /** Override revoker for tests. Defaults to window.ave.permission.egressGrantRevoke. */
  readonly revoker?: (grant: ListedEgressGrant) => Promise<unknown>;
}

/** Who a persistent grant covers: the agent's shell calls or the workspace terminals (never both). */
const ORIGIN_LABEL_KEYS = {
  shell: "permissionsTab.networkGrantOriginShell",
  terminal: "permissionsTab.networkGrantOriginTerminal",
} as const;

const NETWORK_LABEL_KEYS = {
  public: "permissionsTab.networkGrantClassPublic",
  local: "permissionsTab.networkGrantClassLocal",
  unverified: "permissionsTab.networkGrantClassUnverified",
} as const;

function grantKey(grant: ListedEgressGrant): string {
  const owner = grant.scope === "session" ? grant.sessionId
    : grant.scope === "tab" ? grant.tabId
    : `${grant.origin}\n${grant.projectRoot ?? ""}`;
  return `${grant.scope}\n${owner}\n${grant.host}\n${grant.port}\n${grant.network ?? "public"}`;
}

function failureMessage(result: unknown): string | undefined {
  if (isIpcErrorResult(result)) return formatIpcError(result.error, result.message);
  if (result !== null && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
    const failed = result as { message?: unknown; error?: unknown };
    return formatIpcError(
      typeof failed.error === "string" ? failed.error : undefined,
      typeof failed.message === "string" ? failed.message : undefined,
    );
  }
  return undefined;
}


function revokeTarget(grant: ListedEgressGrant): RevocableEgressGrant {
  const destination = {
    host: grant.host,
    port: grant.port,
    ...(grant.network === undefined ? {} : { network: grant.network }),
  };
  if (grant.scope === "session") return { ...destination, scope: "session", sessionId: grant.sessionId };
  if (grant.scope === "tab") return { ...destination, scope: "tab", tabId: grant.tabId };
  return {
    ...destination,
    scope: grant.scope,
    origin: grant.origin,
    ...(grant.projectRoot === undefined ? {} : { projectRoot: grant.projectRoot }),
  };
}

export function EgressGrantsList({ fetcher, revoker }: EgressGrantsListProps): ReactElement {
  const { t: translate } = useTranslation();
  const [grants, setGrants] = useState<ListedEgressGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await (fetcher ?? (() => window.ave!.permission!.egressGrantsList()))();
      const failed = failureMessage(result);
      if (failed !== undefined) {
        setError(failed);
      } else if (result !== null && typeof result === "object" && Array.isArray((result as { grants?: unknown }).grants)) {
        setGrants((result as { grants: ListedEgressGrant[] }).grants);
      } else {
        setError(translate("permissionsTab.networkGrantsLoadFailed"));
      }
    } catch {
      // A thrown fetch carries no user-facing message; its text stays out of the UI.
      setError(translate("permissionsTab.networkGrantsLoadFailed"));
    } finally {
      setBusy(false);
    }
  }, [fetcher, translate]);

  const revoke = useCallback(async (grant: ListedEgressGrant) => {
    setBusy(true);
    setError(null);
    try {
      const result = await (revoker ?? ((g: ListedEgressGrant) => window.ave!.permission!.egressGrantRevoke(revokeTarget(g))))(grant);
      const failed = failureMessage(result);
      // A refused revoke stays on screen with the grant still listed.
      if (failed !== undefined) { setError(failed); return; }
      await refresh();
    } catch {
      setError(translate("permissionsTab.networkGrantRevokeFailed"));
    } finally {
      setBusy(false);
    }
  }, [revoker, refresh, translate]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-2" data-testid="egress-grants">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium">{translate("permissionsTab.networkGrantsHeading")}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()} data-testid="egress-grants-refresh">
          {translate("permissionsTab.networkGrantsRefresh")}
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="egress-grants-error">
          {translate("permissionsTab.networkGrantsError", { message: error })}
        </p>
      ) : null}
      {grants === null ? (
        error === null ? <p className="text-[11px] text-muted-foreground">{translate("permissionsTab.networkGrantsLoading")}</p> : null
      ) : grants.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="egress-grants-empty">
          {translate("permissionsTab.networkGrantsEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border/(--opacity-medium) rounded-md border border-border/(--opacity-medium)">
          {grants.map((grant) => (
            <li key={grantKey(grant)} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2" data-testid="egress-grant-row">
              <div className="min-w-0 space-y-0.5">
                <span className="block min-w-0 break-all font-mono text-[12px]">{`${grant.host}:${grant.port}`}</span>
                <p className="text-[11px] text-muted-foreground" data-testid="egress-grant-class">
                  {translate(NETWORK_LABEL_KEYS[grant.network ?? "public"])}
                </p>
                <p className="min-w-0 break-words text-[11px] text-muted-foreground">
                  {grant.scope === "always"
                    ? translate("permissionsTab.networkGrantScopeAlways", {
                        origin: translate(ORIGIN_LABEL_KEYS[grant.origin]),
                        time: formatDateTime(grant.grantedAt),
                      })
                    : grant.scope === "session"
                      ? translate("permissionsTab.networkGrantScopeSession", {
                          session: grant.sessionId,
                          time: formatDateTime(grant.grantedAt),
                        })
                      : grant.scope === "tab"
                        ? translate("permissionsTab.networkGrantScopeShell", { time: formatDateTime(grant.grantedAt) })
                        : translate("permissionsTab.networkGrantScopeProject", {
                            origin: translate(ORIGIN_LABEL_KEYS[grant.origin]),
                            project: grant.projectRoot ?? "",
                            time: formatDateTime(grant.grantedAt),
                          })}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-[12px]"
                disabled={busy}
                data-testid="egress-grant-revoke"
                onClick={() => void revoke(grant)}
              >
                {translate("permissionsTab.networkGrantRevoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
