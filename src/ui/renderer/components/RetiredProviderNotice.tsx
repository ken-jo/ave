// Window notice for a profile that was moved off a removed LLM vendor.
//
// The settings load moves `llm.provider` off a retired vendor id and leaves
// `llm.retiredProvider` set. While it is set, API-key chat is refused (main
// reads the active route as not configured), and this notice says why and
// where to go. It is not dismissible: it stays until the user picks a provider
// in Settings, which is what clears the marker.

import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { RetiredLLMVendor } from "../../../shared/llm-vendor-defaults.js";

export function RetiredProviderNotice({
  retiredProvider,
  onChooseProvider,
}: {
  retiredProvider: RetiredLLMVendor | null;
  onChooseProvider: () => void;
}) {
  const { t } = useTranslation();
  if (!retiredProvider) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md mx-2 mt-2 border border-warning/(--opacity-medium) bg-popover px-4 py-2 text-sm text-warning shadow-lg"
      data-testid="retired-provider-notice"
      data-retired-provider={retiredProvider}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-5">{t("app.retiredProviderNoticeTitle")}</span>
        <span className="block text-[11px] leading-4 text-warning/(--opacity-emphatic)">
          {t("app.retiredProviderNoticeBody")}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onChooseProvider}
        className="h-auto shrink-0 px-2 py-0.5 text-xs"
        data-testid="retired-provider-notice-action"
      >
        {t("app.retiredProviderNoticeAction")}
      </Button>
    </div>
  );
}
