/** Read-only denials come from the persisted sandbox audit channel; grants are decided elsewhere. */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { t } from "../../../../i18n/runtime.js";
import type { EgressDenialRow, EgressDenialSource } from "../../../../shared/egress-denials.js";
import { formatDateTime } from "../../../../shared/format-time.js";
import { errorMessage } from "../../../../shared/error-message.js";
import { isIpcErrorResult } from "../../types.js";
import { terminalTabLabel } from "../../preview/terminal-tab-labels.js";

interface EgressDenialsListProps {
  /** Override fetcher for tests. Defaults to window.ave.permission.egressDenialsRecent. */
  readonly fetcher?: () => Promise<unknown>;
}

/** Who opened the refused connection, as one line of text. */
function egressDenialSourceText(source: EgressDenialSource): string {
  switch (source.kind) {
    case "shell": {
      const tool = source.toolName === "bash" ? "Bash" : "PowerShell";
      return source.toolUseId === null
        ? t("permissionsTab.networkDenialSourceShell", { tool })
        : t("permissionsTab.networkDenialSourceShellCall", { tool, id: source.toolUseId });
    }
    case "terminal":
      // The tab's visible name where this window showed it; otherwise its id (a denial can outlive the tab, and the id is what
      // the audit row names).
      return t("permissionsTab.networkDenialSourceTerminal", { tab: terminalTabLabel(source.tabId) ?? source.tabId });
    case "worker": {
      const extension = source.pluginId ?? "";
      switch (source.role) {
        case "plugin-child":
          return t("permissionsTab.networkDenialSourcePlugin", { extension });
        case "worker":
          return t("permissionsTab.networkDenialSourceWorker", { extension, worker: source.instanceId ?? "" });
        case "hook":
          return t("permissionsTab.networkDenialSourceHook", { extension });
        case "mcp-server":
          return t("permissionsTab.networkDenialSourceMcp", { server: source.instanceId ?? "" });
      }
      break;
    }
    case "unattributed":
      return t("permissionsTab.networkDenialSourceUnattributed");
  }
  // A row written by a newer build, or a damaged one: the audit file is read back, not produced here. Say so in the row
  // instead of failing the tab.
  const kind = String((source as { kind?: unknown }).kind);
  console.warn("[egress-denials] unknown denial source", source);
  return t("permissionsTab.networkDenialSourceUnknown", { kind });
}

function targetText(row: EgressDenialRow): string {
  if (row.deny.url !== null) return row.deny.method === null ? row.deny.url : `${row.deny.method} ${row.deny.url}`;
  return row.deny.port === null ? row.deny.host : `${row.deny.host}:${row.deny.port}`;
}

export function EgressDenialsList({ fetcher }: EgressDenialsListProps): ReactElement {
  const { t: translate } = useTranslation();
  const [rows, setRows] = useState<EgressDenialRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await (fetcher ?? (() => window.ave!.permission!.egressDenialsRecent()))();
      if (isIpcErrorResult(result)) {
        setError(result.message ?? result.error);
      } else if (Array.isArray(result)) {
        setRows(result as EgressDenialRow[]);
      } else {
        setError(translate("permissionsTab.networkDenialsLoadFailed"));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher, translate]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-2" data-testid="egress-denials">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium">{translate("permissionsTab.networkDenialsHeading")}</p>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[12px]" disabled={loading} onClick={() => void refresh()}>
          {translate("permissionsTab.networkDenialsRefresh")}
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="egress-denials-error">
          {translate("permissionsTab.networkDenialsError", { message: error })}
        </p>
      ) : rows === null ? (
        <p className="text-[11px] text-muted-foreground">{translate("permissionsTab.networkDenialsLoading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="egress-denials-empty">
          {translate("permissionsTab.networkDenialsEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border/(--opacity-medium) rounded-md border border-border/(--opacity-medium)">
          {rows.map((row, index) => (
            <li key={`${row.timestamp}-${index}`} className="min-w-0 space-y-0.5 px-3 py-2" data-testid="egress-denial-row">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 break-all font-mono text-[12px]">{targetText(row)}</span>
                <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={row.timestamp}>
                  {formatDateTime(row.timestamp)}
                </time>
              </div>
              <p className="min-w-0 break-words text-[11px] text-muted-foreground">
                {translate("permissionsTab.networkDenialRowDetail", {
                  source: egressDenialSourceText(row.source),
                  reason: row.deny.reason,
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
