/** The host's own page for a tab whose address did not load: the reason, the address, and what the user can do next. */
import { TriangleAlert } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BrowserLoadError } from "../../../shared/browser-workspace.js";
import { openBrowserPageInSystemBrowser, retryBrowserPageLoad } from "../preview/browser-page-status.js";

export function BrowserLoadErrorView({ tabId, error }: { tabId: string; error: BrowserLoadError }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center"
      data-testid="browser-load-error" data-reason={error.reason} data-tab-id={tabId}>
      <TriangleAlert className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{t(`browserLoadError.title.${error.reason}`)}</p>
      <p className="max-w-md text-xs text-muted-foreground">{t(`browserLoadError.hint.${error.reason}`)}</p>
      {error.url ? <p className="max-w-full break-all font-mono text-xs text-muted-foreground" data-testid="browser-load-error-url">{error.url}</p> : null}
      {error.detail ? <p className="font-mono text-tiny text-muted-foreground">{error.detail}</p> : null}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button type="button" size="sm" onClick={() => retryBrowserPageLoad(tabId)} data-testid="browser-load-error-retry">
          {t("browserLoadError.retry")}
        </Button>
        {error.url ? (
          <Button type="button" size="sm" variant="outline" onClick={() => openBrowserPageInSystemBrowser(error.url)}
            data-testid="browser-load-error-open-external">
            {t("browserLoadError.openExternal")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
