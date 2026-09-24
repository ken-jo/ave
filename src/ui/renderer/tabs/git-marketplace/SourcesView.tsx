/**
 * The sources (design §15.4): each git repository the app reads packages
 * from, its pin, status and switch, with Refresh, Set token, Review (a
 * rewritten history) and Remove where the origin allows them.
 */
import { useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Switch } from "../../../../components/ui/switch.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import type { GitMarketplaceApi, GitMarketplaceErrorCode, PackageKeyView, SourceView } from "../../../../shared/git-marketplace.js";
import { failureText, kindLabel, originLabel, relativeTime, shortSha, sourceStatusLabel } from "./labels.js";

export interface SourcesViewProps {
  api: GitMarketplaceApi;
  sources: SourceView[];
  onChanged: () => void;
  onAdd: () => void;
}

type Confirm =
  | { kind: "remove"; source: SourceView }
  | { kind: "rewrite"; source: SourceView; candidate: string }
  | { kind: "token"; source: SourceView };

export function SourcesView({ api, sources, onChanged, onAdd }: SourcesViewProps) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: GitMarketplaceErrorCode; message: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [token, setToken] = useState("");
  const [orphaned, setOrphaned] = useState<PackageKeyView[] | null>(null);

  const run = async <T,>(key: string, action: () => Promise<{ ok: true; value: T } | { ok: false; code: GitMarketplaceErrorCode; message: string }>): Promise<T | null> => {
    setBusy(key);
    setFailure(null);
    try {
      const result = await action();
      if (!result.ok) {
        setFailure(result);
        return null;
      }
      onChanged();
      return result.value;
    } finally {
      setBusy(null);
    }
  };

  const confirmAction = async () => {
    if (!confirm) return;
    const { source } = confirm;
    if (confirm.kind === "remove") {
      const removed = await run(source.id, () => api.removeSource(source.id));
      if (removed) setOrphaned(removed.orphanedPackages);
    } else if (confirm.kind === "rewrite") {
      await run(source.id, () => api.acceptRewrite(source.id, confirm.candidate));
    } else if (source.tokenHost && token) {
      await run(source.id, () => api.setToken(source.tokenHost!, token));
    }
    setToken("");
    setConfirm(null);
  };

  return (
    <div className="space-y-3" data-testid="git-marketplace:sources">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("gitMarketplace.sources.description")}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("all", () => api.refreshSources())} data-testid="git-marketplace:sources:refresh-all">
            {t("gitMarketplace.sources.refreshAll")}
          </Button>
          <Button size="sm" onClick={onAdd}>{t("gitMarketplace.add.title")}</Button>
        </div>
      </div>
      {failure && <p className="text-sm text-destructive">{failureText(t, failure)}</p>}
      {orphaned && orphaned.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="git-marketplace:sources:orphaned">
          {t("gitMarketplace.sources.orphaned", { packages: orphaned.map((key) => `${kindLabel(t, key.kind)} ${key.name}`).join(", ") })}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/(--opacity-soft) text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t("gitMarketplace.sources.colSource")}</th>
              <th className="px-3 py-2 font-medium">{t("gitMarketplace.sources.colCommit")}</th>
              <th className="px-3 py-2 font-medium">{t("gitMarketplace.sources.colPackages")}</th>
              <th className="px-3 py-2 font-medium">{t("gitMarketplace.sources.colStatus")}</th>
              <th className="px-3 py-2 font-medium">{t("gitMarketplace.sources.colOn")}</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">{t("gitMarketplace.sources.colActions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const status = source.status;
              const warn = status.state === "unreachable" || status.state === "auth-required" || status.state === "history-rewritten" || status.state === "broken";
              return (
                <tr key={source.id} className="border-t align-top" data-testid={`git-marketplace:source:${source.id}`}>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{source.label}</span>
                      <Badge variant={source.origin === "official" ? "default" : "outline"} className="h-5 px-1.5 text-[10px]">{originLabel(t, source.origin)}</Badge>
                    </div>
                    <div className="break-all font-mono text-[11px] text-muted-foreground">
                      {source.url}
                      {source.subdir ? ` · ${source.subdir}` : ""}
                      {source.mirrors > 0 ? ` · ${t("gitMarketplace.sources.mirrors", { count: source.mirrors })}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {source.pinnedCommit ? <code className="font-mono" title={source.pinnedCommit}>{shortSha(source.pinnedCommit)}</code> : "—"}
                    {source.lastSyncAt && <div className="text-muted-foreground">{relativeTime(source.lastSyncAt, locale)}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{source.packageCount}</td>
                  <td className={cn("px-3 py-2 text-xs", warn && "text-warning", status.state === "broken" && "text-destructive")}>
                    <span title={status.state === "broken" ? status.problem : status.state === "unreachable" ? status.code : undefined}>{sourceStatusLabel(t, status)}</span>
                    {status.state === "history-rewritten" && status.reviewable && (
                      <Button size="sm" variant="link" className="h-auto p-0 pl-1 text-xs" onClick={() => setConfirm({ kind: "rewrite", source, candidate: status.candidate })}>
                        {t("gitMarketplace.sources.review")}
                      </Button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Switch
                      checked={source.enabled}
                      disabled={!source.canDisable || busy !== null}
                      aria-label={t("gitMarketplace.sources.enabledLabel", { source: source.label })}
                      onCheckedChange={(checked) => void run(source.id, () => api.setSourceEnabled(source.id, checked))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null || status.state === "broken"} onClick={() => void run(source.id, () => api.refreshSources(source.id))}>
                        {busy === source.id ? t("gitMarketplace.sources.status.syncing") : t("gitMarketplace.sources.refresh")}
                      </Button>
                      {source.auth === "token" && source.tokenHost && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirm({ kind: "token", source })}>
                          {t("gitMarketplace.sources.setToken")}
                        </Button>
                      )}
                      {source.canRemove && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setConfirm({ kind: "remove", source })} data-testid={`git-marketplace:source:${source.id}:remove`}>
                          {t("gitMarketplace.sources.remove")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("gitMarketplace.sources.footnote")}</p>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "remove"
                ? t("gitMarketplace.sources.removeTitle", { source: confirm.source.label })
                : confirm?.kind === "rewrite"
                  ? t("gitMarketplace.sources.rewriteTitle", { source: confirm.source.label })
                  : t("gitMarketplace.sources.tokenTitle", { host: confirm?.source.tokenHost ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "remove"
                ? t("gitMarketplace.sources.removeBody")
                : confirm?.kind === "rewrite"
                  ? t("gitMarketplace.sources.rewriteBody", { candidate: shortSha(confirm.candidate), pinned: confirm.source.pinnedCommit ? shortSha(confirm.source.pinnedCommit) : "—" })
                  : t("gitMarketplace.sources.tokenBody")}
            </DialogDescription>
          </DialogHeader>
          {confirm?.kind === "token" && (
            <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t("gitMarketplace.add.tokenPlaceholder")} autoFocus />
          )}
          <DialogFooter className="gap-2">
            {confirm?.kind === "token" && confirm.source.tokenStored && confirm.source.tokenHost && (
              <Button variant="outline" className="mr-auto" onClick={() => void run(confirm.source.id, () => api.deleteToken(confirm.source.tokenHost!)).then(() => setConfirm(null))}>
                {t("gitMarketplace.sources.deleteToken")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
            <Button
              variant={confirm?.kind === "remove" ? "destructive" : "default"}
              disabled={busy !== null || (confirm?.kind === "token" && token.length === 0)}
              onClick={() => void confirmAction()}
              data-testid="git-marketplace:sources:confirm"
            >
              {confirm?.kind === "remove" ? t("gitMarketplace.sources.remove") : confirm?.kind === "rewrite" ? t("gitMarketplace.sources.acceptRewrite") : t("gitMarketplace.sources.saveToken")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
