/**
 * The sources (design §15.4): each git repository the app reads packages
 * from, its pin, status and switch, with Refresh, Set token, Review (a
 * rewritten history) and Remove where the origin allows them. A source whose
 * downloaded copy is damaged offers Repair in place of Refresh and its
 * switch (§18.8), for every origin. A source that needs a confirmation it
 * does not hold (an address that changed class, sign-in over http) offers
 * *Allow…*, which states the risk once more and syncs again (§18.5); its
 * badges say what it was allowed. A folder source (§18.4.8) shows its
 * path, its contents revision and when it was read, the *Local folder* or
 * *Network folder* badge, and *Show in Finder* (Explorer, file manager) in
 * place of Set token.
 */
import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Switch } from "../../../../components/ui/switch.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { scrubDiagnosticSecrets } from "../../../../shared/dlp.js";
import type { GitMarketplaceApi, GitMarketplaceFailure, PackageKeyView, SourceBadge, SourceView, SourceWarning } from "../../../../shared/git-marketplace.js";
import {
  allowableWarning,
  allowRisk,
  badgeLabel,
  badgeTooltip,
  failureText,
  kindLabel,
  middleTruncate,
  originLabel,
  OTHER_SUBJECT,
  relativeTime,
  revealLabel,
  shortSha,
  sourceStatusDetail,
  sourceStatusLabel,
  sourceSubject,
  warningText,
  type FailureSubject,
} from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";

export interface SourcesViewProps {
  api: GitMarketplaceApi;
  sources: SourceView[];
  onChanged: () => void;
  onAdd: () => void;
  /** A source to bring into view and mark (*Show <id>* from a refused add, §18.8); null for none. */
  highlightId?: string | null;
}

type Confirm =
  | { kind: "remove"; source: SourceView }
  | { kind: "rewrite"; source: SourceView; candidate: string }
  | { kind: "token"; source: SourceView }
  /** *Allow…*: the risk once more, then the confirmation; `then: "token"` opens Set token… after it. */
  | { kind: "allow"; source: SourceView; warning: SourceWarning; text: string; then: "token" | null };

/** A source's badges (§18.5): text plus tooltip, never colour alone. */
/** Badges that name a risk or a state to fix, in the warning tone (their text says which). */
const WARNING_BADGES: ReadonlySet<SourceBadge> = new Set(["unencrypted", "network-folder-unconfirmed", "folder-unclassified"]);

// A badge is one line high (h-5): its label must not wrap out of it in a narrow column.
export function SourceBadges({ badges, testId }: { badges: readonly SourceBadge[]; testId?: string }) {
  const { t } = useTranslation();
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <Badge
          key={badge}
          variant="outline"
          className={cn("h-5 whitespace-nowrap px-1.5 text-[10px]", WARNING_BADGES.has(badge) && "border-warning/(--opacity-medium) text-warning")}
          title={badgeTooltip(t, badge)}
          data-testid={testId ? `${testId}:${badge}` : undefined}
        >
          {badgeLabel(t, badge)}
        </Badge>
      ))}
    </>
  );
}

/** The confirmation a source's last sync asks for, when *Allow…* resolves it. */
function statusAllowable(source: SourceView): SourceWarning | null {
  const status = source.status;
  if (status.state === "unreachable") return allowableWarning(status);
  if (status.state === "auth-required") return allowableWarning({ code: "SOURCE_AUTH_REQUIRED", ...(status.detail ? { detail: status.detail } : {}) });
  return null;
}

export function SourcesView({ api, sources, onChanged, onAdd, highlightId = null }: SourcesViewProps) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  /** The last action's failure, with the source it acted on (none for Refresh all), so its sentence names only that row's actions. */
  const [failure, setFailure] = useState<{ failure: GitMarketplaceFailure; subject: FailureSubject; source: SourceView | null } | null>(null);
  const [confirm, setConfirmState] = useState<Confirm | null>(null);
  const [token, setToken] = useState("");
  // A typed token belongs to the dialog it was typed in: opening or closing any dialog drops it, so a
  // token typed for one host and cancelled can never be saved under the next source's host.
  const setConfirm = (next: Confirm | null) => {
    setToken("");
    setConfirmState(next);
  };
  const [orphaned, setOrphaned] = useState<PackageKeyView[] | null>(null);
  // Bring the marked row into view once it is listed (the list may load after the view opens).
  const highlightListed = highlightId !== null && sources.some((source) => source.id === highlightId);
  useEffect(() => {
    if (!highlightListed || highlightId === null || typeof document === "undefined") return;
    document.querySelector(`[data-testid="git-marketplace:source:${CSS.escape(highlightId)}"]`)?.scrollIntoView?.({ block: "center" });
  }, [highlightId, highlightListed]);

  /** *Allow…* for a failure on `source`: the question names the risk accepted (`allowRisk`), else the failure's sentence is that question. */
  const allowFor = (source: SourceView, failure: Pick<GitMarketplaceFailure, "code" | "detail">) => {
    const warning = allowableWarning(failure);
    if (warning === null) return;
    const text = allowRisk(t, failure) ?? failureText(t, { ...failure, message: "" }, sourceSubject(source));
    setConfirm({ kind: "allow", source, warning, text, then: null });
  };

  /** Set token…: an http source sends no sign-in until the user accepts that it travels unencrypted (§18.2.2). */
  const openToken = (source: SourceView) => {
    if (source.url?.startsWith("http://") && !source.acknowledged.includes("token-unencrypted")) {
      setConfirm({ kind: "allow", source, warning: "token-unencrypted", text: warningText(t, { warning: "token-unencrypted", host: source.tokenHost, address: null }), then: "token" });
      return;
    }
    setConfirm({ kind: "token", source });
  };

  const run = async <T,>(key: string, action: () => Promise<{ ok: true; value: T } | ({ ok: false } & GitMarketplaceFailure)>): Promise<T | null> => {
    setBusy(key);
    setFailure(null);
    try {
      const result = await action();
      if (!result.ok) {
        const source = sources.find((candidate) => candidate.id === key);
        setFailure({ failure: result, subject: source ? sourceSubject(source) : OTHER_SUBJECT, source: source ?? null });
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
    } else if (confirm.kind === "allow") {
      const allowed = await run(source.id, () => api.acknowledgeSource(source.id, [confirm.warning]));
      if (allowed && confirm.then === "token") {
        setConfirm({ kind: "token", source: allowed });
        return;
      }
    } else if (source.tokenHost && token) {
      await run(source.id, () => api.setToken(source.tokenHost!, token));
    }
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
      {failure && (
        <MarketplaceProblem
          failure={failure.failure}
          subject={failure.subject}
          {...(failure.source ? { onAllow: () => allowFor(failure.source!, failure.failure) } : {})}
        />
      )}
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
              const warn = status.state === "unreachable" || status.state === "auth-required" || status.state === "history-rewritten" || status.state === "broken" || status.state === "id-holds-credential";
              const statusDetail = sourceStatusDetail(t, source);
              const allowable = statusAllowable(source);
              return (
                <tr
                  key={source.id}
                  // Marked by background, not a ring: a ring on a table row is clipped by the scrolling wrapper.
                  className={cn("border-t align-top", source.id === highlightId && "bg-accent")}
                  aria-current={source.id === highlightId ? "true" : undefined}
                  data-testid={`git-marketplace:source:${source.id}`}
                >
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* The official source goes by its origin's name everywhere in the tab, so a badge would repeat it. */}
                      {source.origin === "official" ? (
                        <span className="font-medium">{originLabel(t, "official")}</span>
                      ) : (
                        <>
                          <span className="font-medium">{source.label}</span>
                          <Badge variant="outline" className="h-5 whitespace-nowrap px-1.5 text-[10px]">{originLabel(t, source.origin)}</Badge>
                        </>
                      )}
                      <SourceBadges badges={source.badges} testId={`git-marketplace:source:${source.id}:badge`} />
                    </div>
                    {source.transport === "git" ? (
                      <div className="break-all font-mono text-[11px] text-muted-foreground">
                        {source.url}
                        {source.subdir ? ` · ${source.subdir}` : ""}
                        {source.mirrors > 0 ? ` · ${t("gitMarketplace.sources.mirrors", { count: source.mirrors })}` : ""}
                      </div>
                    ) : (
                      // Cut in the middle, and still free to wrap: a path must never widen the table past its pane.
                      <div className="break-all text-[11px] text-muted-foreground" data-testid={`git-marketplace:source:${source.id}:folder`}>
                        <Folder className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden="true" />
                        <span className="mr-1">{t("gitMarketplace.sources.folderKind")}</span>
                        <span className="font-mono" title={source.path} data-testid={`git-marketplace:source:${source.id}:path`}>
                          {middleTruncate(source.path)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {source.pinnedCommit ? (
                      <code className="whitespace-nowrap font-mono" title={source.pinnedCommit}>
                        {source.transport === "folder" ? t("gitMarketplace.sources.folderRevision", { revision: shortSha(source.pinnedCommit) }) : shortSha(source.pinnedCommit)}
                      </code>
                    ) : "—"}
                    {source.lastSyncAt && (
                      <div className="text-muted-foreground">
                        {/* "read" only when that read succeeded: after a failed one the cached contents are older. */}
                        {source.transport === "folder" && status.state === "up-to-date"
                          ? t("gitMarketplace.sources.readAt", { time: relativeTime(source.lastSyncAt, locale) })
                          : relativeTime(source.lastSyncAt, locale)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{source.packageCount}</td>
                  <td className={cn("px-3 py-2 text-xs", warn && "text-warning", status.state === "broken" && "text-destructive")}>
                    <span>{sourceStatusLabel(t, status)}</span>
                    {status.state === "broken" && (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0 pl-1 text-xs"
                        data-testid={`git-marketplace:source:${source.id}:copy-details`}
                        onClick={() => void navigator.clipboard?.writeText(scrubDiagnosticSecrets(status.message))}
                      >
                        {t("gitMarketplace.action.copyDetails")}
                      </Button>
                    )}
                    {statusDetail !== null && (
                      <p className="mt-0.5 max-w-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid={`git-marketplace:source:${source.id}:status-detail`}>{statusDetail}</p>
                    )}
                    {allowable !== null && (status.state === "unreachable" || status.state === "auth-required") && (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0 text-xs"
                        disabled={busy !== null}
                        onClick={() => allowFor(source, status.state === "unreachable" ? status : { code: "SOURCE_AUTH_REQUIRED", ...(status.detail ? { detail: status.detail } : {}) })}
                        data-testid={`git-marketplace:source:${source.id}:allow`}
                      >
                        {t("gitMarketplace.action.allow")}
                      </Button>
                    )}
                    {status.state === "history-rewritten" && status.reviewable && (
                      <Button size="sm" variant="link" className="h-auto p-0 pl-1 text-xs" onClick={() => setConfirm({ kind: "rewrite", source, candidate: status.candidate })}>
                        {t("gitMarketplace.sources.review")}
                      </Button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Switch
                      checked={source.enabled}
                      disabled={!source.canDisable || busy !== null || status.state === "broken"}
                      aria-label={t("gitMarketplace.sources.enabledLabel", { source: source.label })}
                      onCheckedChange={(checked) => void run(source.id, () => api.setSourceEnabled(source.id, checked))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {status.state === "broken" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy !== null}
                          onClick={() => void run(source.id, () => api.repairSource(source.id))}
                          data-testid={`git-marketplace:source:${source.id}:repair`}
                        >
                          {busy === source.id ? t("gitMarketplace.sources.status.repairing") : t("gitMarketplace.sources.repair")}
                        </Button>
                      ) : status.state === "id-holds-credential" ? null : (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => void run(source.id, () => api.refreshSources(source.id))}>
                          {busy === source.id ? t("gitMarketplace.sources.status.syncing") : t("gitMarketplace.sources.refresh")}
                        </Button>
                      )}
                      {source.transport === "folder" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busy !== null}
                          onClick={() => void run(source.id, () => api.revealSource(source.id))}
                          data-testid={`git-marketplace:source:${source.id}:reveal`}
                        >
                          {revealLabel(t)}
                        </Button>
                      )}
                      {source.transport === "git" && source.auth === "token" && source.tokenHost && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => openToken(source)} data-testid={`git-marketplace:source:${source.id}:set-token`}>
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
                  : confirm?.kind === "allow"
                    ? t("gitMarketplace.sources.allowTitle", { source: confirm.source.origin === "official" ? originLabel(t, "official") : confirm.source.label })
                    : t("gitMarketplace.sources.tokenTitle", { host: confirm?.source.tokenHost ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "remove"
                ? t("gitMarketplace.sources.removeBody")
                : confirm?.kind === "rewrite"
                  ? t("gitMarketplace.sources.rewriteBody", { candidate: shortSha(confirm.candidate), pinned: confirm.source.pinnedCommit ? shortSha(confirm.source.pinnedCommit) : "—" })
                  : confirm?.kind === "allow"
                    ? confirm.text
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
              {confirm?.kind === "remove"
                ? t("gitMarketplace.sources.remove")
                : confirm?.kind === "rewrite"
                  ? t("gitMarketplace.sources.acceptRewrite")
                  : confirm?.kind === "allow"
                    ? t("gitMarketplace.sources.allowConfirm")
                    : t("gitMarketplace.sources.saveToken")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
