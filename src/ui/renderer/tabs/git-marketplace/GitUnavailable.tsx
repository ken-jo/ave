/** The Add dialog's blocking step when no git is usable: the Windows installer downloads git, so this only says why none can be used. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { GitRuntimeStatus } from "../../../../shared/git-runtime.js";
import type { AveApi } from "../../types.js";

export interface GitUnavailableProps {
  api: Pick<AveApi, "gitRuntime">;
  /** Called once git is usable, after *Check again* or when it already was. */
  onReady?: () => void;
}

function problemKey(status: GitRuntimeStatus) {
  if (status.systemTooOld) return status.installerProvides ? "gitMarketplace.git.tooOldInstaller" : "gitMarketplace.git.tooOld";
  return status.installerProvides ? "gitMarketplace.git.missingInstaller" : "gitMarketplace.git.missing";
}

export function GitUnavailable({ api, onReady }: GitUnavailableProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitRuntimeStatus | "unavailable" | null>(null);
  const [checking, setChecking] = useState(false);
  // The caller passes a fresh closure each render; reading it through a ref keeps one status read per mount.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const result = await api.gitRuntime.status();
      setStatus(result.ok ? result.status : "unavailable");
      if (result.ok && result.status.state === "ready") onReadyRef.current?.();
    } finally {
      setChecking(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === null) return <p className="text-xs text-muted-foreground">{t("gitMarketplace.loading")}</p>;
  if (status !== "unavailable" && status.state === "ready") return null;
  const text = status === "unavailable"
    ? t("gitMarketplace.git.unavailable")
    : t(problemKey(status), { version: status.systemTooOld?.version ?? "" });

  return (
    <div className="space-y-2" data-testid="git-runtime:missing">
      <div className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning">{text}</div>
      <Button size="sm" variant="outline" disabled={checking} onClick={() => void refresh()} data-testid="git-runtime:check-again">
        {t("gitMarketplace.git.checkAgain")}
      </Button>
    </div>
  );
}
