/**
 * A package's sheet (design §15.2, §15.3, §15.6): the detail sections, then
 * the reviewed plan, the install progress and the result, all in place. What
 * the plan shows is what installs: the plan id is single use and expires.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import type {
  AuthorityView,
  GitMarketplaceApi,
  GitMarketplaceErrorCode,
  InstallPlanView,
  InstallProgressView,
  InstallResultView,
  PackageDetailView,
  PackageKeyView,
  RungView,
  UpdatePlanView,
} from "../../../../shared/git-marketplace.js";
import { actionLabel, exclusionLabel, failureText, kindLabel, originLabel, shortSha, stateLabel } from "./labels.js";
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
  | { stage: "failed"; failure: { code: GitMarketplaceErrorCode; message: string }; plan: InstallPlanView | UpdatePlanView | null };

export interface PackageSheetProps {
  api: GitMarketplaceApi;
  alertsApi?: AveApi;
  onOpenPluginSettings?: (pluginId: string) => void;
  target: { key: PackageKeyView; mode: "detail" | "update" } | null;
  onClose: () => void;
  /** Something was installed or removed: the catalog should be read again. */
  onChanged: () => void;
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
          {index + 1}. {rung.rung === "release" ? t("gitMarketplace.rung.release") : rung.rung === "archive" ? t("gitMarketplace.rung.archive") : t("gitMarketplace.rung.tree")}
          {" · "}
          {!rung.declared
            ? t("gitMarketplace.rung.notDeclared")
            : rung.rung !== "tree" && !rung.pinned
              ? t("gitMarketplace.rung.notPinned")
              : rung.detail ?? t("gitMarketplace.rung.declared")}
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

export function PackageSheet({ api, alertsApi, onOpenPluginSettings, target, onClose, onChanged }: PackageSheetProps) {
  const { t, locale } = useTranslation();
  const [detail, setDetail] = useState<PackageDetailView | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ code: GitMarketplaceErrorCode; message: string } | null>(null);
  const [stage, setStage] = useState<Stage>({ stage: "detail" });
  const [busy, setBusy] = useState(false);
  const [trustRewrite, setTrustRewrite] = useState(false);
  const [switchConsent, setSwitchConsent] = useState(false);
  const [removeData, setRemoveData] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (key: PackageKeyView) => {
    setLoadFailure(null);
    const result = await api.packageDetail(key);
    if (result.ok) setDetail(result.value);
    else setLoadFailure(result);
  }, [api]);

  const plan = useCallback(async (key: PackageKeyView, options: { update?: boolean; version?: string; switchSource?: boolean } = {}) => {
    setBusy(true);
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
    setDetail(null);
    setStage({ stage: "detail" });
    setTrustRewrite(false);
    setSwitchConsent(false);
    setRemoveData(false);
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
    const result = await api.executeInstall(reviewed.planId);
    if (result.ok) {
      setStage({ stage: "done", result: result.value });
      onChanged();
      if (target) void load(target.key);
    } else {
      setStage({ stage: "failed", failure: result, plan: reviewed });
    }
  };

  const uninstall = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.uninstall({ ...target.key, ...(target.key.kind === "mcp" ? { removeData } : {}) });
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
          {loadFailure && <p className="text-sm text-destructive">{failureText(t, loadFailure)}</p>}

          {stage.stage === "detail" && detail && (
            <>
              <Section title={t("gitMarketplace.detail.provenance")}>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">{t("gitMarketplace.detail.source")}</dt>
                  <dd>{detail.provenance.sourceLabel}</dd>
                  <dt className="text-muted-foreground">{t("gitMarketplace.detail.repository")}</dt>
                  <dd className="break-all font-mono text-xs">{detail.provenance.repository}</dd>
                  <dt className="text-muted-foreground">{t("gitMarketplace.detail.path")}</dt>
                  <dd className="font-mono text-xs">{detail.provenance.path || "/"}</dd>
                  <dt className="text-muted-foreground">{t("gitMarketplace.detail.commit")}</dt>
                  <dd><Sha commit={detail.provenance.versionCommit ?? detail.provenance.snapshotCommit} /></dd>
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
                  <p className="mt-1 text-xs text-muted-foreground">{t("gitMarketplace.detail.deliveryHelp")}</p>
                </Section>
              )}
              <Section title={t("gitMarketplace.detail.versions")}>
                <ul className="space-y-1">
                  {detail.versions.map((version) => {
                    const choosable = !version.candidate && !version.installed
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
                {t("gitMarketplace.review.boundTo", { commit: shortSha(reviewPlan.versionCommit) })} ·{" "}
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
              {reviewPlan.mcp && (
                <Section title={t("gitMarketplace.review.willRun")}>
                  <McpRuntimeSummary runtime={reviewPlan.mcp} />
                </Section>
              )}
              {reviewPlan.rungs.length > 0 && (
                <Section title={t("gitMarketplace.detail.delivery")}>
                  <RungList rungs={reviewPlan.rungs} />
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
                  {t("gitMarketplace.install.notConnected", { message: stage.result.connectionWarning })}
                </p>
              )}
              {stage.result.rungs.length > 0 && (
                <ol className="text-xs text-muted-foreground">
                  {stage.result.rungs.map((rung) => (
                    <li key={rung.rung}>
                      {rung.rung} · {rung.outcome === "used" ? t("gitMarketplace.rung.used") : rung.outcome === "skipped" ? t("gitMarketplace.rung.skipped", { reason: rung.reason }) : t("gitMarketplace.rung.failed", { code: rung.code, message: rung.message })}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {stage.stage === "failed" && (
            <div className="space-y-2" data-testid="git-marketplace:failed">
              <p className="text-sm text-destructive">{failureText(t, stage.failure)}</p>
              <pre className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px]">{diagnostic}</pre>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(diagnostic)}>
                {t("gitMarketplace.copyDiagnostic")}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {stage.stage === "detail" && target && state && !entry?.required && installedHere && (
            <div className="mr-auto flex items-center gap-2">
              {target.key.kind === "mcp" && (
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={removeData} onCheckedChange={(checked) => setRemoveData(checked === true)} />
                  {t("gitMarketplace.uninstall.removeData")}
                </label>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void uninstall()} data-testid="git-marketplace:uninstall">
                {t("gitMarketplace.uninstall.button")}
              </Button>
            </div>
          )}
          {entry?.required && <span className="mr-auto text-xs text-muted-foreground">{t("gitMarketplace.state.required")}</span>}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
