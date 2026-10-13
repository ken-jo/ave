// Window notice for a profile whose route the settings load found retired.
//
// The settings load leaves `llm.retiredProvider` set when the stored profile
// named a removed LLM vendor (moved off it) or a model the catalog or the
// vendor's own listing retired. While it is set, API-key chat is refused (main
// reads the active route as not configured), and this notice says why and
// where to go. It is not dismissible: it stays until the user picks in
// Settings, which is what clears the marker.

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
  const body = retiredModel
    ? retiredModel.reason === "catalog-deprecated"
      ? t("app.retiredModelNoticeBodyDeprecated")
      : t("app.retiredModelNoticeBodyUnlisted")
    : t("app.retiredProviderNoticeBody");
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
