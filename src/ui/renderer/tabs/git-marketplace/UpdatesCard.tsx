/**
 * The Updates card in Settings → Marketplace → Maintenance (design §18.9):
 * whether packages update by themselves, when Ave checks, how the last
 * check ended, *Check now* and *Apply now*, the updates that need the user
 * with their actions, the recent automatic updates with *What changed*, and
 * the per-source and per-package switches (§18.7.2).
 *
 * An update that needs consent installs only through its review (§15.6),
 * which *Review* and *Retry* open; an agent plugin's `approval-pending`
 * components are approved here, an extension's in its plugin settings.
 *
 * It reads `updates:status` once and then follows `marketplace:update-status`.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { NativeSelect, NativeSelectOption } from "../../../../components/ui/native-select.js";
import { Switch } from "../../../../components/ui/switch.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { TranslateFn as Translate } from "../../../../i18n/translate.js";
import {
  updateNeedsUser,
  type AutoUpdateSwitchView,
  type GitMarketplaceApi,
  type GitMarketplaceFailure,
  type GitMarketplaceResult,
  type PackageKeyView,
  type PackageUpdateView,
  type UpdateReason,
  type UpdateStatusView,
} from "../../../../shared/git-marketplace.js";
import { packageUpdateSkipKey } from "../../../../shared/skipped-plugin-updates.js";
import { kindLabel, OTHER_SUBJECT, relativeTime, shortSha, updateStateLabel } from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";
import { ComponentApprovalDialog } from "./UpdateReview.js";

/** A switch the user changed: the global one, or a source's or package's own (`null`: back to the default). */
export type AutoUpdateSwitchChange =
  | { scope: "global"; value: boolean }
  | { scope: "source"; id: string; value: "on" | "off" | null }
  | { scope: "package"; key: string; value: "on" | "off" | null };

export interface UpdatesCardProps {
  api: Pick<GitMarketplaceApi, "updateStatus" | "checkUpdates" | "applyUpdatesNow" | "approveComponents" | "acknowledgeSource" | "onUpdateStatus">;
  /** Open a package's update review (§15.6). */
  onReview: (key: PackageKeyView) => void;
  /** Open the Sources view, where each unreachable source says why. */
  onShowSources: () => void;
  /** Save a switch through the settings channel (§18.9); resolves with why it was not saved, or null. */
  onSwitch: (change: AutoUpdateSwitchChange) => Promise<string | null>;
  /** Open an extension's settings, where its components are approved (§18.7.5). */
  onOpenPluginSettings?: (pluginId: string) => void;
}

/** Why an update does not apply by itself (§18.7.2, §18.7.3). */
export function updateReasonLabel(t: Translate, reason: UpdateReason): string {
  switch (reason) {
    case "disabled": return t("gitMarketplace.updates.reason.disabled");
    case "source-hidden": return t("gitMarketplace.updates.reason.sourceHidden");
    case "history-rewritten": return t("gitMarketplace.updates.reason.historyRewritten");
    case "not-an-upgrade": return t("gitMarketplace.updates.reason.notAnUpgrade");
    case "unencrypted-updates": return t("gitMarketplace.updates.reason.unencryptedUpdates");
    case "switched-off": return t("gitMarketplace.updates.reason.switchedOff");
    case "consent-changed": return t("gitMarketplace.updates.reason.consentChanged");
    case "baseline-unknown": return t("gitMarketplace.updates.reason.baselineUnknown");
    case "approval-unconfirmed": return t("gitMarketplace.updates.reason.approvalUnconfirmed");
    case "failed-three-times": return t("gitMarketplace.updates.reason.failedThreeTimes");
    case "calls-in-flight": return t("gitMarketplace.updates.reason.callsInFlight");
    case "policy-blocked": return t("gitMarketplace.updates.reason.policyBlocked");
  }
}

function rowId(key: PackageKeyView): string {
  return `${key.sourceId}:${key.kind}:${key.name}`;
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A source's or package's switch as a select: the default (and what it gives), on, off. */
function SwitchSelect({ view, label, disabled, onChange, testId }: {
  view: AutoUpdateSwitchView;
  label: string;
  disabled: boolean;
  onChange: (value: "on" | "off" | null) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const defaultLabel = view.override !== null
    ? t("gitMarketplace.updates.switch.default")
    : view.effective ? t("gitMarketplace.updates.switch.defaultOn") : t("gitMarketplace.updates.switch.defaultOff");
  return (
    <NativeSelect
      size="sm"
      aria-label={label}
      value={view.override ?? "default"}
      disabled={disabled || view.lockedByPolicy}
      onChange={(event) => onChange(event.target.value === "on" || event.target.value === "off" ? event.target.value : null)}
      data-testid={testId}
    >
      <NativeSelectOption value="default">{defaultLabel}</NativeSelectOption>
      <NativeSelectOption value="on">{t("gitMarketplace.updates.switch.on")}</NativeSelectOption>
      <NativeSelectOption value="off">{t("gitMarketplace.updates.switch.off")}</NativeSelectOption>
    </NativeSelect>
  );
}

export function UpdatesCard({ api, onReview, onShowSources, onSwitch, onOpenPluginSettings }: UpdatesCardProps) {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [failure, setFailure] = useState<GitMarketplaceFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  /** The source whose switch waits for `unencrypted-updates` to be accepted (§18.5). */
  const [confirmSource, setConfirmSource] = useState<string | null>(null);
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set());
  const [whatChanged, setWhatChanged] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState<PackageKeyView | null>(null);
  // A pushed status is newer than an answer still on its way.
  const pushed = useRef(false);

  useEffect(() => {
    let alive = true;
    void api.updateStatus().then((result) => {
      if (!alive || pushed.current) return;
      if (result.ok) setStatus(result.value);
      else setFailure(result);
    });
    const off = api.onUpdateStatus((next) => {
      pushed.current = true;
      setStatus(next);
      setFailure(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const answer = (result: GitMarketplaceResult<UpdateStatusView>) => {
    if (result.ok) setStatus(result.value);
    else setFailure(result);
  };

  const checkNow = async () => {
    setChecking(true);
    setFailure(null);
    try {
      answer(await api.checkUpdates());
    } finally {
      setChecking(false);
    }
  };

  const applyNow = async () => {
    setApplying(true);
    setFailure(null);
    try {
      answer(await api.applyUpdatesNow());
    } finally {
      setApplying(false);
    }
  };

  const save = async (change: AutoUpdateSwitchChange) => {
    setSaving(true);
    setSaveFailure(null);
    try {
      setSaveFailure(await onSwitch(change));
    } finally {
      setSaving(false);
    }
  };

  /** Turn a plain-http source on: it accepts `unencrypted-updates` first (§18.7.2). */
  const acceptUnencrypted = async (id: string) => {
    setSaving(true);
    setFailure(null);
    try {
      const result = await api.acknowledgeSource(id, ["unencrypted-updates"]);
      if (!result.ok) {
        setFailure(result);
        return;
      }
    } finally {
      setSaving(false);
    }
    setConfirmSource(null);
    await save({ scope: "source", id, value: "on" });
  };

  const running = checking || status?.running === true;
  const discovery = status?.discovery ?? null;
  const lastChecked = discovery?.lastSuccessAt ? relativeTime(discovery.lastSuccessAt, locale) : null;
  const packages = status?.packages ?? [];
  const needsYou = packages.filter((update) => updateNeedsUser(update.state));
  const inProgress = packages.filter((update) => update.state === "automatic" || update.state === "waiting");
  const recent = packages.filter((update) => update.state === "applied");
  const waiting = packages.filter((update) => update.state === "waiting").length;
  const approvingUpdate = approving
    ? packages.find((update) => rowId(update.key) === rowId(approving) && update.state === "approval-pending") ?? null
    : null;

  /** *Review*: the update review, an agent plugin's component approval, or an extension's settings. */
  const reviewAction = (update: PackageUpdateView): (() => void) | null => {
    if (update.state === "manual" || update.state === "needs-review") return () => onReview(update.key);
    if (update.state !== "approval-pending") return null;
    if (update.key.kind === "agent-plugin") return () => setApproving(update.key);
    if (update.key.kind === "plugin" && onOpenPluginSettings) return () => onOpenPluginSettings(update.key.name);
    return null;
  };

  const updateRow = (update: PackageUpdateView) => {
    const id = rowId(update.key);
    const review = reviewAction(update);
    return (
      <li key={id} className="space-y-1 px-3 py-2 text-xs" data-testid={`git-marketplace:updates:row:${id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{update.displayName}</span>
            <span className="text-muted-foreground">
              {kindLabel(t, update.key.kind)} · <span className="font-mono">{update.from} → {update.to}</span>
            </span>
          </span>
          <span className="text-muted-foreground" data-testid="git-marketplace:updates:state">{updateStateLabel(t, update.state)}</span>
          {review && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={review} data-testid="git-marketplace:updates:review">
              {t("gitMarketplace.updates.review")}
            </Button>
          )}
          {update.state === "failed" && (
            <>
              {update.failure && (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setDetails((current) => toggled(current, id))} data-testid="git-marketplace:updates:details">
                  {t("gitMarketplace.updates.details")}
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onReview(update.key)} data-testid="git-marketplace:updates:retry">
                {t("gitMarketplace.updates.retry")}
              </Button>
            </>
          )}
          {update.autoUpdate && (
            <SwitchSelect
              view={update.autoUpdate}
              label={t("gitMarketplace.updates.packageSwitch", { name: update.displayName })}
              disabled={saving}
              onChange={(value) => void save({ scope: "package", key: packageUpdateSkipKey(update.key), value })}
              testId={`git-marketplace:updates:package-switch:${id}`}
            />
          )}
        </div>
        {update.stale && (
          <span className="block text-muted-foreground" data-testid="git-marketplace:updates:stale">
            {t("gitMarketplace.updates.stale")}
          </span>
        )}
        {update.reasons && update.reasons.length > 0 && (
          <span className="block text-muted-foreground" data-testid="git-marketplace:updates:reasons">
            {update.reasons.map((reason) => updateReasonLabel(t, reason)).join(" · ")}
          </span>
        )}
        {update.failure && (
          <span className="block text-muted-foreground" data-testid="git-marketplace:updates:attempts">
            {t("gitMarketplace.updates.attempts", { count: update.failure.attempts })}
          </span>
        )}
        {update.failure && details.has(id) && (
          <MarketplaceProblem
            failure={{ code: update.failure.code, message: update.failure.message ?? "", ...(update.failure.detail ? { detail: update.failure.detail } : {}) }}
            subject={OTHER_SUBJECT}
            testId="git-marketplace:updates:failure"
          />
        )}
      </li>
    );
  };

  const autoUpdate = status?.autoUpdate ?? null;
  return (
    <div className="space-y-2" data-testid="git-marketplace:updates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("gitMarketplace.updates.title")}</span>
        <div className="flex flex-wrap items-center gap-2">
          {status?.waitingSince && (
            <Button size="sm" variant="outline" disabled={applying} onClick={() => void applyNow()} data-testid="git-marketplace:updates:apply-now">
              {t("gitMarketplace.updates.applyNow")}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={running || status === null} onClick={() => void checkNow()} data-testid="git-marketplace:updates:check">
            {running ? t("gitMarketplace.updates.checking") : t("gitMarketplace.updates.checkNow")}
          </Button>
        </div>
      </div>
      {/* The scheduler's own sentence; main's message is behind Copy details, scrubbed. */}
      {failure && (
        <MarketplaceProblem tone="error" text={t("gitMarketplace.updates.unavailable")} details={`${failure.code}\n${failure.message}`} testId="git-marketplace:updates:error" />
      )}
      {saveFailure !== null && (
        <MarketplaceProblem tone="error" text={t("gitMarketplace.maintenance.saveFailed")} details={saveFailure} testId="git-marketplace:updates:save-error" />
      )}
      {status === null || autoUpdate === null ? (
        failure === null && <p className="text-xs text-muted-foreground">{t("gitMarketplace.loading")}</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{t("gitMarketplace.updates.automatic")}</span>
            <Switch
              checked={autoUpdate.enabled}
              disabled={saving || autoUpdate.lockedByPolicy !== null}
              aria-label={t("gitMarketplace.updates.automatic")}
              data-testid="git-marketplace:updates:automatic"
              onCheckedChange={(checked) => void save({ scope: "global", value: checked })}
            />
          </div>
          {autoUpdate.lockedByPolicy !== null && (
            <p className="text-xs text-muted-foreground" data-testid="git-marketplace:updates:automatic:policy">
              {autoUpdate.lockedByPolicy === "on" ? t("gitMarketplace.updates.policyOn") : t("gitMarketplace.updates.policyOff")}
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="git-marketplace:updates:cadence">
            {t("gitMarketplace.updates.cadence")}
            {" · "}
            {lastChecked === null ? t("gitMarketplace.updates.neverChecked") : t("gitMarketplace.updates.lastChecked", { time: lastChecked })}
            {!running && ` · ${t("gitMarketplace.updates.next", { time: relativeTime(status.discovery.nextAt, locale) })}`}
          </p>
          {status.escalated && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:escalated">
              <span className="min-w-0 flex-1">{t("gitMarketplace.updates.escalated", { count: waiting })}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={applying} onClick={() => void applyNow()}>
                {t("gitMarketplace.updates.applyNow")}
              </Button>
            </div>
          )}
          {status.historyReset && (
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:history-reset">
              {t("gitMarketplace.updates.historyReset")}
            </p>
          )}
          {!running && discovery?.result === "offline" && (
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:offline">
              {lastChecked === null ? t("gitMarketplace.updates.offlineNever") : t("gitMarketplace.updates.offline", { time: lastChecked })}
            </p>
          )}
          {!running && discovery?.result === "partial" && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:partial">
              <span className="min-w-0 flex-1">{t("gitMarketplace.updates.partial")}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onShowSources}>
                {t("gitMarketplace.updates.showSources")}
              </Button>
            </div>
          )}
          {!running && discovery?.result === "error" && (
            <p className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-soft) px-3 py-2 text-xs text-destructive" data-testid="git-marketplace:updates:failed">
              {t("gitMarketplace.updates.error")}
            </p>
          )}
          {needsYou.length === 0 && inProgress.length === 0 ? (
            discovery?.result === "ok" && <p className="text-xs text-muted-foreground" data-testid="git-marketplace:updates:none">{t("gitMarketplace.updates.none")}</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="git-marketplace:updates:list">
              {[...needsYou, ...inProgress].map(updateRow)}
            </ul>
          )}
          {recent.length > 0 && (
            <div className="space-y-1" data-testid="git-marketplace:updates:recent">
              <p className="text-xs font-medium">{t("gitMarketplace.updates.recent")}</p>
              <ul className="divide-y rounded-md border">
                {recent.map((update) => {
                  const id = rowId(update.key);
                  return (
                    <li key={id} className="space-y-1 px-3 py-2 text-xs" data-testid={`git-marketplace:updates:recent:${id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{update.displayName}</span>
                          <span className="text-muted-foreground">
                            <span className="font-mono">{update.from} → {update.to}</span>
                            {update.appliedAt && ` · ${relativeTime(update.appliedAt, locale)}`}
                          </span>
                        </span>
                        {update.commitRange && (
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setWhatChanged((current) => toggled(current, id))} data-testid="git-marketplace:updates:what-changed">
                            {t("gitMarketplace.updates.whatChanged")}
                          </Button>
                        )}
                      </div>
                      {update.commitRange && whatChanged.has(id) && (
                        <span className="block text-muted-foreground" data-testid="git-marketplace:updates:commit-range">
                          {t("gitMarketplace.review.commitRange", { from: update.commitRange.from ? shortSha(update.commitRange.from) : "—", to: shortSha(update.commitRange.to) })}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {autoUpdate.sources.length > 0 && (
            <div className="space-y-1" data-testid="git-marketplace:updates:sources">
              <p className="text-xs font-medium">{t("gitMarketplace.updates.bySource")}</p>
              <ul className="divide-y rounded-md border">
                {autoUpdate.sources.map((source) => (
                  <li key={source.id} className="space-y-1 px-3 py-2 text-xs" data-testid={`git-marketplace:updates:source:${source.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{source.label}</span>
                      <SwitchSelect
                        view={source.switch}
                        label={t("gitMarketplace.updates.sourceSwitch", { source: source.label })}
                        disabled={saving}
                        onChange={(value) => {
                          if (value === "on" && source.needsUnencryptedUpdates) setConfirmSource(source.id);
                          else void save({ scope: "source", id: source.id, value });
                        }}
                        testId={`git-marketplace:updates:source-switch:${source.id}`}
                      />
                    </div>
                    {confirmSource === source.id && (
                      <div className="space-y-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2" data-testid="git-marketplace:updates:unencrypted">
                        <p>{t("gitMarketplace.warning.unencryptedUpdates", { source: source.label })}</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setConfirmSource(null)}>
                            {t("common.cancel")}
                          </Button>
                          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={saving} onClick={() => void acceptUnencrypted(source.id)} data-testid="git-marketplace:updates:unencrypted:continue">
                            {t("gitMarketplace.updates.turnOnAnyway")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ComponentApprovalDialog api={api} update={approvingUpdate} onClose={() => setApproving(null)} onReload={() => void api.updateStatus().then(answer)} />
    </div>
  );
}
