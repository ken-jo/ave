/**
 * A package's sheet (design §15.2, §15.3, §15.6): the detail sections, then
 * the reviewed plan, the install progress and the result, all in place. What
 * the plan shows is what installs: the plan id is single use and expires.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { scrubDiagnosticSecrets } from "../../../../shared/dlp.js";
import type {
  AuthorityView,
  CatalogEntryView,
  ComponentConsent,
  GitMarketplaceApi,
  GitMarketplaceFailure,
  InstallPlanView,
  InstallProgressView,
  InstallResultView,
  PackageDetailView,
  PackageKeyView,
  RungView,
  SourceView,
  SourceWarning,
  UpdatePlanView,
} from "../../../../shared/git-marketplace.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";
import { actionLabel, allowableWarning, exclusionLabel, kindLabel, originLabel, OTHER_SUBJECT, relativeTime, shortSha, sourceSubject, stateLabel } from "./labels.js";
import { McpRuntimeSummary } from "./McpRuntimeSummary.js";
import { componentInventory } from "../../../../marketplace/app/component-delta.js";
import type { AgentPluginComponents } from "../../../../marketplace/catalog/types.js";

import type { AveApi } from "../../types.js";
import { InstalledPluginAlerts } from "./InstalledPluginAlerts.js";

type Stage =
  | { stage: "detail" }
  | { stage: "review"; plan: InstallPlanView | UpdatePlanView }
  | { stage: "installing"; plan: InstallPlanView | UpdatePlanView; progress: InstallProgressView | null }
  | { stage: "done"; result: InstallResultView }
  | { stage: "failed"; failure: GitMarketplaceFailure; plan: InstallPlanView | UpdatePlanView | null };

export interface PackageSheetProps {
  api: GitMarketplaceApi;
  alertsApi?: AveApi;
  onOpenPluginSettings?: (pluginId: string) => void;
  target: { key: PackageKeyView; mode: "detail" | "update" } | null;
  /** The target's source as Sources lists it, so a failure names only what its row offers; null when it is not listed. */
  source: SourceView | null;
  onClose: () => void;
  /** Something was installed or removed: the catalog should be read again. */
  onChanged: () => void;
}

type PlanOptions = { update?: boolean; version?: string; switchSource?: boolean };

/** Installed states of a row whose package is installed from that row's key. */
const INSTALLED_HERE: ReadonlySet<CatalogEntryView["state"]["state"]> = new Set(["installed", "update", "source-removed"]);

function sameKey(a: Pick<CatalogEntryView["key"], "sourceId" | "kind" | "name">, b: PackageKeyView): boolean {
  return a.sourceId === b.sourceId && a.kind === b.kind && a.name === b.name;
}

function isUpdatePlan(plan: InstallPlanView | UpdatePlanView): plan is UpdatePlanView {
  return "commitRange" in plan;
}

function Sha({ commit }: { commit: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-xs" title={commit}>{shortSha(commit)}</code>
      <button
        type="button"
        className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => void navigator.clipboard?.writeText(commit)}
        aria-label={t("gitMarketplace.copyCommitLabel", { commit })}
      >
        {t("gitMarketplace.copy")}
      </button>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-border/(--opacity-medium) pt-3 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function AuthorityList({ authority, sign }: { authority: AuthorityView; sign?: "+" | "-" }) {
  const { t } = useTranslation();
  const rows: string[] = [
    ...authority.networkHosts.map((host) => t("gitMarketplace.authority.network", { host })),
    ...authority.filesystem.map((grant) => t("gitMarketplace.authority.filesystem", { grant: `${grant.access}: ${grant.target} — ${grant.why}` })),
    ...authority.secrets.map((secret) => t("gitMarketplace.authority.secret", { secret })),
    ...authority.capabilities.map((capability) => t("gitMarketplace.authority.capability", { capability })),
    ...authority.pluginAccess.map((plugin) => t("gitMarketplace.authority.pluginAccess", { plugin })),
    ...authority.dependencies.map((dependency) => t("gitMarketplace.authority.dependency", { dependency })),
  ];
  if (rows.length === 0 && !sign) return <p className="text-muted-foreground">{t("gitMarketplace.authority.none")}</p>;
  return (
    <ul className="space-y-0.5">
      {rows.map((row) => (
        <li key={`${sign ?? ""}${row}`} className={cn(sign === "+" && "text-warning", sign === "-" && "text-muted-foreground line-through")}>
          {sign ? `${sign} ` : ""}
          {row}
        </li>
      ))}
    </ul>
  );
}

function RungList({ rungs }: { rungs: RungView[] }) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-0.5">
      {rungs.map((rung, index) => (
        <li key={rung.rung} className={cn(!rung.declared && "text-muted-foreground")}>
          {index + 1}. {rung.rung === "release" ? t("gitMarketplace.rung.release") : rung.rung === "archive" ? t("gitMarketplace.rung.archive") : rung.rung === "folder" ? t("gitMarketplace.rung.folder") : t("gitMarketplace.rung.tree")}
          {" · "}
          {!rung.declared
            ? t("gitMarketplace.rung.notDeclared")
            : rung.rung !== "tree" && rung.rung !== "folder" && !rung.pinned
              ? t("gitMarketplace.rung.notPinned")
              : rung.detail ?? t("gitMarketplace.rung.declared")}
          {rung.declared && rung.unencrypted && (
            <span className="text-warning" data-testid={`git-marketplace:rung:${rung.rung}:unencrypted`}>{` · ${t("gitMarketplace.rung.unencrypted")}`}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function ComponentsList({ components }: { components: AgentPluginComponents }) {
  const { t } = useTranslation();
  const items = componentInventory(components);
  if (items.length === 0) return <p className="text-muted-foreground">{t("gitMarketplace.components.none")}</p>;
  return <ul className="space-y-0.5">{items.map((item) => (
    <li key={`${item.kind}:${item.name}`}>
      {t(`gitMarketplace.components.${item.kind}`)} · <span className="font-mono">{item.name}</span>
      {" · "}<code className="text-xs text-muted-foreground" title={item.digest}>{item.digest.slice(0, 12)}</code>
    </li>
  ))}</ul>;
}

export function PackageSheet({ api, alertsApi, onOpenPluginSettings, target, source, onClose, onChanged }: PackageSheetProps) {
  const { t, locale } = useTranslation();
  const [detail, setDetail] = useState<PackageDetailView | null>(null);
  const [loadFailure, setLoadFailure] = useState<GitMarketplaceFailure | null>(null);
  // A package whose source Sources no longer lists has no row to point at.
  const failureSubject = source ? sourceSubject(source) : OTHER_SUBJECT;
  const [stage, setStage] = useState<Stage>({ stage: "detail" });
  const [busy, setBusy] = useState(false);
  const [trustRewrite, setTrustRewrite] = useState(false);
  const [switchConsent, setSwitchConsent] = useState(false);
  const [removeData, setRemoveData] = useState(false);
  const [approvedMcpServers, setApprovedMcpServers] = useState<Record<string, boolean>>({});
  const [approvedHooks, setApprovedHooks] = useState<Record<number, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  /**
   * The Installed row for the shown key, read when its detail is refused (a quarantined or removed
   * source, §18.8): what is installed from that key stays removable — or says the policy requires it —
   * however the sheet was opened (a card, a review, a deep link). Null when nothing is installed from it.
   */
  const [installedRow, setInstalledRow] = useState<{ key: PackageKeyView; entry: CatalogEntryView } | null>(null);

  /**
   * Which answers may still change the sheet. A load, and an Installed lookup, each take the next
   * generation; opening, reopening and closing the sheet move both on. An answer to an earlier one is
   * dropped, so a lookup for an earlier opening never decides this one, even for the same key.
   */
  const detailGeneration = useRef(0);
  const lookupGeneration = useRef(0);
  /** The key whose detail the current load was refused: the Installed lookup follows the catalog for it. */
  const refusedKey = useRef<PackageKeyView | null>(null);

  /** The Installed row for `key`, now: null while it is asked, and when the list fails or names no install from `key`. */
  const lookupInstalled = useCallback(async (key: PackageKeyView) => {
    const mine = ++lookupGeneration.current;
    setInstalledRow(null);
    const installed = await api.listCatalog({ installedOnly: true });
    if (mine !== lookupGeneration.current) return;
    const row = installed.ok ? installed.value.entries.find((item) => sameKey(item.key, key) && INSTALLED_HERE.has(item.state.state)) : undefined;
    setInstalledRow(row ? { key, entry: row } : null);
  }, [api]);

  const load = useCallback(async (key: PackageKeyView) => {
    const mine = ++detailGeneration.current;
    lookupGeneration.current += 1;
    refusedKey.current = null;
    setLoadFailure(null);
    setInstalledRow(null);
    const result = await api.packageDetail(key);
    if (mine !== detailGeneration.current) return;
    if (result.ok) {
      setDetail(result.value);
      return;
    }
    setLoadFailure(result);
    refusedKey.current = key;
    await lookupInstalled(key);
  }, [api, lookupInstalled]);

  // What is installed changes under an open sheet (§18.8): the lookup follows the same event the cards do.
  const sheetOpen = target !== null;
  useEffect(() => {
    if (!sheetOpen) return;
    return api.onCatalogChanged(() => {
      if (refusedKey.current) void lookupInstalled(refusedKey.current);
    });
  }, [api, lookupInstalled, sheetOpen]);

  /** The last plan asked for, so a review can be asked again after *Allow…* or an expired plan. */
  const [lastPlan, setLastPlan] = useState<{ key: PackageKeyView; options: PlanOptions } | null>(null);

  const plan = useCallback(async (key: PackageKeyView, options: PlanOptions = {}) => {
    setLastPlan({ key, options });
    setBusy(true);
    setApprovedMcpServers({});
    setApprovedHooks({});
    try {
      const result = options.update
        ? await api.planUpdate(key)
        : await api.planInstall({ ...key, ...(options.version ? { version: options.version } : {}), ...(options.switchSource ? { switchSource: true } : {}) });
      if (result.ok) setStage({ stage: "review", plan: result.value });
      else setStage({ stage: "failed", failure: result, plan: null });
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    // A new opening, or none: nothing asked for an earlier one may change the sheet.
    detailGeneration.current += 1;
    lookupGeneration.current += 1;
    refusedKey.current = null;
    setInstalledRow(null);
    setLoadFailure(null);
    setDetail(null);
    setStage({ stage: "detail" });
    setTrustRewrite(false);
    setSwitchConsent(false);
    setRemoveData(false);
    setApprovedMcpServers({});
    if (!target) return;
    void load(target.key);
    if (target.mode === "update") void plan(target.key, { update: true });
  }, [target, load, plan]);

  // The plan's countdown and the progress events of the plan being installed.
  useEffect(() => {
    if (stage.stage !== "review") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage.stage]);
  const installingPlanId = stage.stage === "installing" ? stage.plan.planId : null;
  useEffect(() => {
    if (!installingPlanId) return;
    return api.onInstallProgress((progress) => {
      if (progress.planId !== installingPlanId) return;
      setStage((current) => (current.stage === "installing" ? { ...current, progress } : current));
    });
  }, [api, installingPlanId]);

  const execute = async (reviewed: InstallPlanView | UpdatePlanView) => {
    setStage({ stage: "installing", plan: reviewed, progress: null });
    const selected: ComponentConsent[] = Object.entries(reviewed.components?.mcpServers ?? {})
      .filter(([name]) => approvedMcpServers[name])
      .map(([name, server]) => ({ name, digest: server.digest }));
    selected.push(...(reviewed.components?.hooks ?? []).flatMap((hook, index) =>
      approvedHooks[index] ? [{ kind: "hook" as const, index, digest: hook.digest }] : []));
    const result = selected.length > 0
      ? await api.executeInstall(reviewed.planId, selected)
      : await api.executeInstall(reviewed.planId);
    if (result.ok) {
      setStage({ stage: "done", result: result.value });
      onChanged();
      if (target) void load(target.key);
    } else {
      setStage({ stage: "failed", failure: result, plan: reviewed });
    }
  };

  /** Review again with a fresh plan (an expired one, or after *Allow…*). */
  const replan = () => {
    if (lastPlan) void plan(lastPlan.key, lastPlan.options);
  };

  /** *Allow…* on a download that needs a confirmation the source does not hold: confirm it for the source, then review again. */
  const allow = async (warning: SourceWarning) => {
    if (!source) return;
    setBusy(true);
    try {
      const result = await api.acknowledgeSource(source.id, [warning]);
      if (!result.ok) {
        setStage({ stage: "failed", failure: result, plan: null });
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
    replan();
  };

  const uninstall = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.uninstall({ ...target.key, ...(target.key.kind === "mcp" || target.key.kind === "agent-plugin" ? { removeData } : {}) });
      if (result.ok) {
        onChanged();
        onClose();
      } else {
        setStage({ stage: "failed", failure: result, plan: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const entry = detail?.entry ?? null;
  const state = entry?.state ?? null;
  const installedHere = state?.state === "installed" || state?.state === "update";
  // What is installed from this key when its detail is refused: removable by that key beside the refusal's reason, unless required.
  const installedWithoutDetail = detail === null && loadFailure !== null && target !== null && installedRow !== null && sameKey(installedRow.key, target.key)
    ? installedRow.entry
    : null;
  const required = entry?.required ?? installedWithoutDetail?.required ?? false;
  const expiresIn = stage.stage === "review" ? Math.max(0, Math.round((new Date(stage.plan.expiresAt).getTime() - now) / 1000)) : 0;
  const reviewPlan = stage.stage === "review" ? stage.plan : null;
  const needsRewriteTrust = reviewPlan !== null && isUpdatePlan(reviewPlan) && reviewPlan.historyRewritten !== null;
  const isSwitch = reviewPlan?.action.action === "switch";
  const confirmDisabled = busy || expiresIn === 0 || (needsRewriteTrust && !trustRewrite) || (isSwitch && !switchConsent);

  const diagnostic = useMemo(() => {
    if (stage.stage !== "failed") return "";
    const subject = stage.plan
      ? `${stage.plan.key.kind} ${stage.plan.key.name} ${stage.plan.version} from ${stage.plan.key.sourceId}`
      : target ? `${target.key.kind} ${target.key.name} from ${target.key.sourceId}` : "";
    return `${stage.failure.code} · ${subject}\n${stage.failure.message}`.trim();
  }, [stage, target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="git-marketplace:sheet">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-8">
            {entry?.displayName ?? target?.key.name}
            {entry?.sourceOrigin && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                {entry.sourceOrigin === "official" ? originLabel(t, "official") : entry.sourceLabel}
              </Badge>
            )}
            {target && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{kindLabel(t, target.key.kind)}</Badge>}
          </DialogTitle>
          <DialogDescription>{entry?.description ?? ""}</DialogDescription>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="absolute right-4 top-4 h-7 w-7 p-0" aria-label={t("common.close")} data-testid="git-marketplace:sheet:close">✕</Button>
          </DialogClose>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {loadFailure && <MarketplaceProblem failure={loadFailure} subject={failureSubject} />}

          {stage.stage === "detail" && detail && (
            <>
              <Section title={t("gitMarketplace.detail.provenance")}>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">{t("gitMarketplace.detail.source")}</dt>
                  <dd>{detail.provenance.sourceLabel}</dd>
                  {detail.provenance.folder === null ? (
                    <>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.repository")}</dt>
                      <dd className="break-all font-mono text-xs">{detail.provenance.repository}</dd>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.path")}</dt>
                      <dd className="font-mono text-xs">{detail.provenance.path || "/"}</dd>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.commit")}</dt>
                      <dd><Sha commit={detail.provenance.versionCommit ?? detail.provenance.snapshotCommit} /></dd>
                    </>
                  ) : (
                    // A folder's provenance (§18.4.8): where it is read, when, and the digest of what this package installs.
                    <>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.folder")}</dt>
                      <dd className="break-all font-mono text-xs" data-testid="git-marketplace:provenance:folder">{detail.provenance.folder.path}</dd>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.path")}</dt>
                      <dd className="font-mono text-xs">{detail.provenance.path || "/"}</dd>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.folderRead")}</dt>
                      <dd title={new Date(detail.provenance.folder.readAt).toLocaleString(locale)} data-testid="git-marketplace:provenance:read">{relativeTime(detail.provenance.folder.readAt, locale)}</dd>
                      {detail.provenance.folder.contents !== null && (
                        <>
                          <dt className="text-muted-foreground">{t("gitMarketplace.detail.contents")}</dt>
                          <dd><code className="font-mono text-xs" title={detail.provenance.folder.contents} data-testid="git-marketplace:provenance:contents">{detail.provenance.folder.contents.slice(0, 12)}</code></dd>
                        </>
                      )}
                    </>
                  )}
                  {detail.provenance.publishedAt && (
                    <>
                      <dt className="text-muted-foreground">{t("gitMarketplace.detail.published")}</dt>
                      <dd>{new Date(detail.provenance.publishedAt).toLocaleDateString(locale)}</dd>
                    </>
                  )}
                </dl>
              </Section>
              <Section title={t("gitMarketplace.detail.compatibility")}>
                {detail.compatibility.minAppVersion === null
                  ? t("gitMarketplace.detail.noVersion")
                  : detail.compatibility.compatible
                    ? t("gitMarketplace.detail.compatible", { version: detail.compatibility.minAppVersion })
                    : t("gitMarketplace.detail.incompatible", { version: detail.compatibility.minAppVersion, app: detail.compatibility.appVersion })}
              </Section>
              {detail.authority && (
                <Section title={t("gitMarketplace.detail.permissions")}>
                  <AuthorityList authority={detail.authority} />
                </Section>
              )}
              {detail.components && (
                <Section title={t("gitMarketplace.components.title")}>
                  <ComponentsList components={detail.components} />
                </Section>
              )}
              {detail.entry.sourceOrigin === "official" && (
                <Section title={t("gitMarketplace.detail.badge")}>
                  <p className="text-muted-foreground">{t("gitMarketplace.detail.badgeOfficial")}</p>
                </Section>
              )}
              {detail.rungs.length > 0 && (
                <Section title={t("gitMarketplace.detail.delivery")}>
                  <RungList rungs={detail.rungs} />
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="git-marketplace:delivery-help">
                    {detail.provenance.folder !== null ? t("gitMarketplace.detail.deliveryHelpFolder") : t("gitMarketplace.detail.deliveryHelp")}
                  </p>
                </Section>
              )}
              <Section title={t("gitMarketplace.detail.versions")}>
                {detail.provenance.folder !== null && (
                  <p className="mb-1 text-xs text-muted-foreground" data-testid="git-marketplace:versions:folder">{t("gitMarketplace.detail.versionsFolder")}</p>
                )}
                <ul className="space-y-1">
                  {detail.versions.map((version) => {
                    // A folder holds one version, its own: no other is offered (§18.4.3).
                    const choosable = detail.provenance.folder === null && !version.candidate && !version.installed
                      && version.excluded.every((reason) => reason === "rollout" || reason === "prerelease");
                    return (
                      <li key={version.version} className="flex flex-wrap items-center gap-1.5" data-testid={`git-marketplace:version:${version.version}`}>
                        <span className="font-mono text-xs">{version.version}</span>
                        {version.candidate && <Badge className="h-5 px-1.5 text-[10px]">{t("gitMarketplace.version.latest")}</Badge>}
                        {version.installed && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{t("gitMarketplace.version.installed")}</Badge>}
                        {version.excluded.map((reason) => (
                          <Badge key={reason} variant="outline" className="h-5 px-1.5 text-[10px]" title={reason === "yanked" ? version.yankedReason ?? undefined : undefined}>
                            {exclusionLabel(t, reason)}
                          </Badge>
                        ))}
                        {choosable && target && (
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void plan(target.key, { version: version.version })}>
                            {t("gitMarketplace.version.installThis")}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            </>
          )}

          {reviewPlan && (
            <div className="space-y-3" data-testid="git-marketplace:review">
              <p className="text-sm">
                {actionLabel(t, reviewPlan.action)} · <span className="font-mono">{reviewPlan.displayName} {reviewPlan.version}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {/* A folder's pin is its contents revision (`local-…`, §18.4.3), not a commit. */}
                {reviewPlan.versionCommit.startsWith("local-")
                  ? t("gitMarketplace.review.boundToFolder", { revision: shortSha(reviewPlan.versionCommit) })
                  : t("gitMarketplace.review.boundTo", { commit: shortSha(reviewPlan.versionCommit) })} ·{" "}
                {t("gitMarketplace.review.expiresIn", { time: `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, "0")}` })}
              </p>
              {isUpdatePlan(reviewPlan) && (
                <>
                  {reviewPlan.historyRewritten && (
                    <div className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning" data-testid="git-marketplace:rewritten">
                      {t("gitMarketplace.review.rewritten", { candidate: shortSha(reviewPlan.historyRewritten.candidate), pinned: reviewPlan.historyRewritten.pinned ? shortSha(reviewPlan.historyRewritten.pinned) : "—" })}
                    </div>
                  )}
                  <p className="text-xs">
                    {t("gitMarketplace.review.versionChange", { from: reviewPlan.from ?? "—", to: reviewPlan.version })} ·{" "}
                    {t("gitMarketplace.review.commitRange", { from: reviewPlan.commitRange.from ? shortSha(reviewPlan.commitRange.from) : "—", to: shortSha(reviewPlan.commitRange.to) })}
                  </p>
                  {reviewPlan.authorityDelta && (
                    <Section title={t("gitMarketplace.review.whatChanges")}>
                      <AuthorityList authority={reviewPlan.authorityDelta.added} sign="+" />
                      <AuthorityList authority={reviewPlan.authorityDelta.removed} sign="-" />
                    </Section>
                  )}
                  {reviewPlan.componentsDelta && (
                    <Section title={t("gitMarketplace.review.componentChanges")}>
                      <ul className="space-y-0.5">
                        {(["added", "removed", "changed"] as const).flatMap((change) => reviewPlan.componentsDelta![change].map((item) => (
                          <li key={`${change}:${item.kind}:${item.name}`}>
                            {t(`gitMarketplace.components.${change}`)} · {t(`gitMarketplace.components.${item.kind}`)} · <span className="font-mono">{item.name}</span>
                          </li>
                        )))}
                      </ul>
                    </Section>
                  )}
                </>
              )}
              {!isUpdatePlan(reviewPlan) && reviewPlan.authority && (
                <Section title={t("gitMarketplace.detail.permissions")}>
                  <AuthorityList authority={reviewPlan.authority} />
                </Section>
              )}
              {reviewPlan.components && (
                <Section title={t("gitMarketplace.components.title")}>
                  <ComponentsList components={reviewPlan.components} />
                </Section>
              )}
              {reviewPlan.key.kind === "agent-plugin" && reviewPlan.components && Object.keys(reviewPlan.components.mcpServers).length > 0 && (
                <Section title={t("gitMarketplace.review.mcpConsentTitle")}>
                  <p className="text-xs text-muted-foreground">{t("gitMarketplace.review.mcpConsentHelp")}</p>
                  <div className="space-y-2 pt-2">
                    {Object.entries(reviewPlan.components.mcpServers).map(([name, server]) => (
                      <label key={name} className="flex items-start gap-2 text-xs" data-testid={`git-marketplace:mcp-consent:${name}`}>
                        <Checkbox checked={approvedMcpServers[name] === true}
                          onCheckedChange={(checked) => setApprovedMcpServers((current) => ({ ...current, [name]: checked === true }))} />
                        <span className="space-y-1">
                          <span className="block font-medium">{t("gitMarketplace.review.mcpConsent", { name })}</span>
                          <code className="block break-all">{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</code>
                          {server.transport === "stdio" && <span className="block">{t("gitMarketplace.review.mcpCwd", { cwd: server.cwd })}</span>}
                          <span className="block">{t("gitMarketplace.review.mcpFingerprint", { digest: server.digest })}</span>
                          {server.auth === "api-key" && <span className="block">{t("gitMarketplace.review.mcpCredential")}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}
              {reviewPlan.key.kind === "agent-plugin" && reviewPlan.components && reviewPlan.components.hooks.length > 0 && (
                <Section title={t("gitMarketplace.review.hookConsentTitle")}>
                  <p className="text-xs text-muted-foreground">{t("gitMarketplace.review.hookConsentHelp")}</p>
                  <p className="text-xs text-muted-foreground">{t(`gitMarketplace.review.hookConfinement.${reviewPlan.hookConfinement}`)}</p>
                  <div className="space-y-2 pt-2">
                    {reviewPlan.components.hooks.map((hook, index) => (
                      <label key={index} className="flex items-start gap-2 text-xs" data-testid={`git-marketplace:hook-consent:${index}`}>
                        <Checkbox checked={approvedHooks[index] === true} disabled={reviewPlan.hookConfinement === "unavailable"}
                          onCheckedChange={(checked) => setApprovedHooks((current) => ({ ...current, [index]: checked === true }))} />
                        <span className="space-y-1">
                          <span className="block font-medium">{t("gitMarketplace.review.hookConsent", { event: hook.event })}</span>
                          <code className="block break-all">{hook.command.join(" ")}</code>
                          {hook.matcher && <span className="block">{hook.matcher}</span>}
                          <span className="block">{t("gitMarketplace.review.hookTimeout", { timeout: hook.timeoutMs })}</span>
                          <span className="block">{t("gitMarketplace.review.mcpFingerprint", { digest: hook.digest })}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}
              {reviewPlan.mcp && (
                <Section title={t("gitMarketplace.review.willRun")}>
                  <McpRuntimeSummary runtime={reviewPlan.mcp} />
                </Section>
              )}
              {reviewPlan.rungs.length > 0 && (
                <Section title={t("gitMarketplace.detail.delivery")}>
                  <RungList rungs={reviewPlan.rungs} />
                  {reviewPlan.notInstalled.length > 0 && (
                    <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="git-marketplace:review:not-installed">
                      {t("gitMarketplace.review.notInstalled", { entries: reviewPlan.notInstalled.join(", ") })}
                    </p>
                  )}
                </Section>
              )}
              {isSwitch && reviewPlan.action.action === "switch" && (
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox checked={switchConsent} onCheckedChange={(checked) => setSwitchConsent(checked === true)} data-testid="git-marketplace:switch-consent" />
                  <span>
                    {reviewPlan.key.kind === "plugin"
                      ? t("gitMarketplace.review.switchPlugin", { from: reviewPlan.action.fromSource ?? t("gitMarketplace.noSource"), to: reviewPlan.key.sourceId })
                      : t("gitMarketplace.review.switch", { from: reviewPlan.action.fromSource ?? t("gitMarketplace.noSource"), to: reviewPlan.key.sourceId })}
                  </span>
                </label>
              )}
              {needsRewriteTrust && (
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox checked={trustRewrite} onCheckedChange={(checked) => setTrustRewrite(checked === true)} data-testid="git-marketplace:trust-rewrite" />
                  <span>{t("gitMarketplace.review.trustRewrite", { source: reviewPlan.key.sourceId })}</span>
                </label>
              )}
              {reviewPlan.runsCode && <p className="text-xs text-muted-foreground">{t("gitMarketplace.review.runsCode")}</p>}
            </div>
          )}

          {stage.stage === "installing" && (
            <div className="space-y-1 text-sm" aria-live="polite" data-testid="git-marketplace:installing">
              <p>{t("gitMarketplace.install.installing", { name: stage.plan.displayName, version: stage.plan.version })}</p>
              <p className="text-xs text-muted-foreground">
                {stage.progress === null || stage.progress.phase === "resolving"
                  ? t("gitMarketplace.install.phaseResolving")
                  : stage.progress.phase === "downloading"
                    ? t("gitMarketplace.install.phaseDownloading")
                    : stage.progress.phase === "verifying"
                      ? t("gitMarketplace.install.phaseVerifying")
                      : stage.progress.phase === "installing"
                        ? t("gitMarketplace.install.phaseInstalling")
                        : t("gitMarketplace.install.phaseActivating")}
              </p>
            </div>
          )}

          {stage.stage === "done" && (
            <div className="space-y-1 text-sm" data-testid="git-marketplace:done">
              <p>{t("gitMarketplace.install.done", { name: stage.result.key.name, version: stage.result.version ?? "" })}</p>
              {stage.result.key.kind === "plugin" && alertsApi && onOpenPluginSettings && <InstalledPluginAlerts api={alertsApi} pluginId={stage.result.key.name} onOpen={(id) => { onClose(); onOpenPluginSettings(id); }} />}
              {stage.result.connectionWarning && (
                <p className="text-xs text-warning" data-testid="git-marketplace:done:connection">
                  {t("gitMarketplace.install.notConnected", { message: scrubDiagnosticSecrets(stage.result.connectionWarning) })}
                </p>
              )}
              {stage.result.rungs.length > 0 && (
                <ol className="text-xs text-muted-foreground">
                  {stage.result.rungs.map((rung) => (
                    <li key={rung.rung}>
                      {rung.rung} · {rung.outcome === "used" ? t("gitMarketplace.rung.used") : rung.outcome === "skipped" ? t("gitMarketplace.rung.skipped", { reason: rung.reason }) : t("gitMarketplace.rung.failed", { code: rung.code, message: scrubDiagnosticSecrets(rung.message) })}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {stage.stage === "failed" && (
            <MarketplaceProblem
              failure={stage.failure}
              subject={failureSubject}
              details={diagnostic}
              testId="git-marketplace:failed"
              {...(() => {
                const warning = allowableWarning(stage.failure);
                if (warning === null || !source) return {};
                return {
                  onAllow: () => void allow(warning),
                  ...(warning === "internal-downloads" ? { allowLabel: t("gitMarketplace.action.allowInternalDownloads") } : {}),
                };
              })()}
            />
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {stage.stage === "detail" && target && !required && ((state && installedHere) || installedWithoutDetail !== null) && (
            <div className="mr-auto flex items-center gap-2">
              {(target.key.kind === "mcp" || target.key.kind === "agent-plugin") && (
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={removeData} onCheckedChange={(checked) => setRemoveData(checked === true)} />
                  {t(target.key.kind === "agent-plugin" ? "gitMarketplace.uninstall.removePluginData" : "gitMarketplace.uninstall.removeData")}
                </label>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void uninstall()} data-testid="git-marketplace:uninstall">
                {t("gitMarketplace.uninstall.button")}
              </Button>
            </div>
          )}
          {required && <span className="mr-auto text-xs text-muted-foreground" data-testid="git-marketplace:sheet:required">{t("gitMarketplace.state.required")}</span>}
          {stage.stage === "detail" && target && state && (state.state === "install" || state.state === "update" || state.state === "installed-elsewhere") && (
            <Button
              size="sm"
              disabled={busy}
              data-testid="git-marketplace:plan"
              onClick={() => void plan(target.key, { update: state.state === "update", switchSource: state.state === "installed-elsewhere" })}
            >
              {state.state === "update" ? t("gitMarketplace.review.reviewUpdate") : state.state === "installed-elsewhere" ? t("gitMarketplace.review.reviewSwitch") : stateLabel(t, state)}
            </Button>
          )}
          {reviewPlan && (
            <>
              <Button variant="outline" size="sm" onClick={() => setStage({ stage: "detail" })}>
                {isUpdatePlan(reviewPlan) && reviewPlan.from ? t("gitMarketplace.review.keep", { version: reviewPlan.from }) : t("common.cancel")}
              </Button>
              <Button size="sm" disabled={confirmDisabled} onClick={() => void execute(reviewPlan)} data-testid="git-marketplace:confirm">
                {actionLabel(t, reviewPlan.action)}
              </Button>
            </>
          )}
          {(stage.stage === "done" || stage.stage === "failed") && (
            <Button size="sm" variant="outline" onClick={() => setStage({ stage: "detail" })}>
              {t("gitMarketplace.back")}
            </Button>
          )}
          {stage.stage === "failed" && stage.failure.code === "PLAN_EXPIRED" && lastPlan && (
            <Button size="sm" disabled={busy} onClick={replan} data-testid="git-marketplace:review-again">
              {t("gitMarketplace.review.again")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
