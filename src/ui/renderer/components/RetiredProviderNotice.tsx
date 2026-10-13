// Window notices for a profile whose route is going away.
//
// RetiredProviderNotice: the settings load leaves `llm.retiredProvider` set
// when the stored profile named a removed LLM vendor (moved off it) or a model
// its vendor's own complete listing no longer names (the retired tier). While
// it is set, API-key chat is refused (main reads the active route as not
// configured), and this notice says why and where to go. It is not
// dismissible: it stays until the user picks in Settings, which is what
// clears the marker.
//
// DeprecatedModelNotice: the catalog marks the saved model deprecated (design
// `model-capability-catalog.md` §6.1). Chat keeps working, so the notice is a
// status line the user can dismiss for this window's lifetime.

import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { isRetiredLlmModelMarker, type LlmRouteRetirement } from "../../../shared/llm-vendor-defaults.js";

export function RetiredProviderNotice({
  retiredProvider,
  onChooseProvider,
}: {
  retiredProvider: LlmRouteRetirement | null;
  onChooseProvider: () => void;
}) {
  const { t } = useTranslation();
  if (!retiredProvider) return null;
  const retiredModel = isRetiredLlmModelMarker(retiredProvider) ? retiredProvider : null;
  const title = retiredModel
    ? t("app.retiredModelNoticeTitle", { model: retiredModel.model })
    : t("app.retiredProviderNoticeTitle");
  const body = retiredModel ? t("app.retiredModelNoticeBodyUnlisted") : t("app.retiredProviderNoticeBody");
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md mx-2 mt-2 border border-warning/(--opacity-medium) bg-popover px-4 py-2 text-sm text-warning shadow-lg"
      data-testid="retired-provider-notice"
      {...(retiredModel
        ? { "data-retired-model": retiredModel.model, "data-retired-reason": retiredModel.reason }
        : { "data-retired-provider": retiredProvider })}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-5 [overflow-wrap:anywhere]">{title}</span>
        <span className="block text-[11px] leading-4 text-warning/(--opacity-emphatic)">
          {body}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onChooseProvider}
        className="h-auto shrink-0 px-2 py-0.5 text-xs"
        data-testid="retired-provider-notice-action"
      >
        {retiredModel ? t("app.retiredModelNoticeAction") : t("app.retiredProviderNoticeAction")}
      </Button>
    </div>
  );
}

export function DeprecatedModelNotice({
  model,
  onChooseModel,
}: {
  model: string | null;
  onChooseModel: () => void;
}) {
  const { t } = useTranslation();
  // Dismissal is per model: choosing another deprecated model tells again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!model || dismissed === model) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-md mx-2 mt-2 border border-info/(--opacity-medium) bg-popover px-4 py-2 text-sm text-info shadow-lg"
      data-testid="deprecated-model-notice"
      data-deprecated-model={model}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-5 [overflow-wrap:anywhere]">
          {t("app.deprecatedModelNoticeTitle", { model })}
        </span>
        <span className="block text-[11px] leading-4 text-info/(--opacity-emphatic)">
          {t("app.deprecatedModelNoticeBody")}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onChooseModel}
          className="h-auto px-2 py-0.5 text-xs"
          data-testid="deprecated-model-notice-action"
        >
          {t("app.retiredModelNoticeAction")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDismissed(model)}
          aria-label={t("app.deprecatedModelNoticeDismiss")}
          className="h-auto p-1"
          data-testid="deprecated-model-notice-dismiss"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}
