/**
 * The git the marketplace runs (design §15.7): the detected state, the mode,
 * and installing the managed copy with its phase progress. The same card is
 * the blocking step of the Add dialog when git is missing (`compact`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { GitRuntimeMode } from "../../../../shared/git-runtime-mode.js";
import type { GitRuntimeProgress, GitRuntimeStatus } from "../../../../shared/git-runtime.js";
import { isIpcErrorResult, type AveApi } from "../../types.js";
import { formatBytes, OTHER_SUBJECT } from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";

const MODES: readonly GitRuntimeMode[] = ["auto", "system", "managed"];
const PHASES = ["checking", "downloading", "verifying", "extracting", "smoke-testing"] as const;

type Phase = (typeof PHASES)[number];

export interface GitRuntimeCardProps {
  api: Pick<AveApi, "gitRuntime" | "updateSettings">;
  /** The Add dialog's blocking step: no mode selector. */
  compact?: boolean;
  /** Called once git is usable, after an install or when it already was. */
  onReady?: () => void;
}

export function GitRuntimeCard({ api, compact = false, onReady }: GitRuntimeCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitRuntimeStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [progress, setProgress] = useState<GitRuntimeProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  /** Why the last mode change was not saved, as the raw text behind *Copy details*. */
  const [modeError, setModeError] = useState<string | null>(null);
  // The caller passes a fresh closure each render; reading it through a ref
  // keeps `refresh` (and the status read it starts) to one per mount.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  const refresh = useCallback(async () => {
    const result = await api.gitRuntime.status();
    if (!result.ok) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setStatus(result.status);
    if (result.status.state === "ready") onReadyRef.current?.();
  }, [api]);

  useEffect(() => {
    void refresh();
    return api.gitRuntime.onProgress((next) => setProgress(next));
  }, [api, refresh]);

  const install = async () => {
    setInstalling(true);
    setProgress({ phase: "checking" });
    try {
      const result = await api.gitRuntime.install();
      if (result.ok) {
        setStatus(result.status);
        if (result.status.state === "ready") onReadyRef.current?.();
      } else {
        setUnavailable(true);
      }
    } finally {
      setInstalling(false);
    }
  };

  const setMode = async (mode: GitRuntimeMode) => {
    setModeError(null);
    const result = await api.updateSettings({ marketplace: { git: { mode } } });
    if (isIpcErrorResult(result)) {
      setModeError(result.message === undefined ? result.error : `${result.error}\n${result.message}`);
      return;
    }
    await refresh();
  };

  if (unavailable) {
    return <p className="text-xs text-destructive" data-testid="git-runtime:unavailable">{t("gitMarketplace.git.unavailable")}</p>;
  }
  if (!status) return <p className="text-xs text-muted-foreground">{t("gitMarketplace.loading")}</p>;

  const size = status.managed.size;
  const installLabel = size === null ? t("gitMarketplace.git.install") : t("gitMarketplace.git.installSize", { size: formatBytes(size) });
  const failed = status.lastInstallError;
  const phaseIndex = progress && progress.phase !== "ready" && progress.phase !== "failed" ? PHASES.indexOf(progress.phase as Phase) : -1;
  const canInstall = status.managed.available && status.mode !== "system" && !installing;

  return (
    <div className="space-y-3" data-testid="git-runtime:card">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t("gitMarketplace.git.title")}</span>
          <div role="radiogroup" aria-label={t("gitMarketplace.git.modeLabel")} className="inline-flex rounded-md border p-0.5">
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={status.mode === mode}
                data-testid={`git-runtime:mode:${mode}`}
                onClick={() => void setMode(mode)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs",
                  status.mode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode === "auto" ? t("gitMarketplace.git.modeAuto") : mode === "system" ? t("gitMarketplace.git.modeSystem") : t("gitMarketplace.git.modeManaged")}
              </button>
            ))}
          </div>
        </div>
      )}
      {modeError !== null && (
        <MarketplaceProblem tone="error" text={t("gitMarketplace.git.modeSaveFailed")} details={modeError} testId="git-runtime:mode-error" />
      )}

      {status.state === "ready" && status.active && (
        <div className="rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-runtime:ready">
          {status.active.kind === "managed"
            ? t("gitMarketplace.git.readyManaged", { version: status.active.version })
            : t("gitMarketplace.git.readySystem", { version: status.active.version })}
          {status.systemTooOld && status.active.kind === "managed" && (
            <span className="block text-muted-foreground">{t("gitMarketplace.git.systemTooOldUsingManaged", { version: status.systemTooOld.version })}</span>
          )}
        </div>
      )}
      {status.state === "too-old" && status.systemTooOld && (
        <div className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning" data-testid="git-runtime:too-old">
          {t("gitMarketplace.git.tooOld", { version: status.systemTooOld.version })}
        </div>
      )}
      {status.state === "missing" && (
        <div className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning" data-testid="git-runtime:missing">
          {t("gitMarketplace.git.missing")}
        </div>
      )}
      {failed && !installing && (
        <div className="space-y-1" data-testid="git-runtime:failed">
          <p className="text-xs text-destructive">{t("gitMarketplace.git.failed")}</p>
          <MarketplaceProblem failure={failed} subject={OTHER_SUBJECT} />
        </div>
      )}
      {status.mode === "system" && status.state !== "ready" && (
        <p className="text-xs text-muted-foreground">{t("gitMarketplace.git.systemModeHint")}</p>
      )}
      {!status.managed.available && status.state !== "ready" && (
        <p className="text-xs text-muted-foreground">{t("gitMarketplace.git.noManagedBuild")}</p>
      )}

      {installing && (
        <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-live="polite" data-testid="git-runtime:progress">
          {PHASES.map((phase, index) => (
            <li key={phase} className={cn(index < phaseIndex ? "text-muted-foreground" : index === phaseIndex ? "font-medium text-foreground" : "text-muted-foreground/(--opacity-medium)")}>
              {index < phaseIndex ? "✓ " : index === phaseIndex ? "● " : ""}
              {phase === "checking" && t("gitMarketplace.git.phaseChecking")}
              {phase === "downloading" && (progress?.phase === "downloading"
                ? t("gitMarketplace.git.phaseDownloadingBytes", { done: formatBytes(progress.bytes), total: formatBytes(progress.total) })
                : t("gitMarketplace.git.phaseDownloading"))}
              {phase === "verifying" && t("gitMarketplace.git.phaseVerifying")}
              {phase === "extracting" && t("gitMarketplace.git.phaseExtracting")}
              {phase === "smoke-testing" && t("gitMarketplace.git.phaseSmokeTesting")}
            </li>
          ))}
        </ol>
      )}

      {status.state !== "ready" || (status.mode === "managed" && !status.managed.installed) ? (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!canInstall} onClick={() => void install()} data-testid="git-runtime:install">
            {failed ? t("common.retry") : installLabel}
          </Button>
          <span className="text-[11px] text-muted-foreground">{t("gitMarketplace.git.pinned", { version: status.managed.version })}</span>
        </div>
      ) : null}
    </div>
  );
}
