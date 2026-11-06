import { McpAppView } from "./McpAppView.js";
import type { PluginUiExtensionView } from "../../../shared/plugin-ui-view.js";
import { useTranslation } from "../../../i18n/react.js";

/** Panel placement reuses the same resource loader and standard bridge as conversation cards. */
export function McpAppPanelContent({ view, authError, preparing = false }: {
  view: PluginUiExtensionView | null;
  authError?: string | null;
  preparing?: boolean;
}) {
  const { t } = useTranslation();
  if (authError) return <div className="p-3 text-xs text-destructive">{authError}</div>;
  if (!view) return <div className="p-3 text-xs text-muted-foreground">{t(preparing ? "be_pluginUiHost.pluginUiLoadingDesc" : "be_pluginUiHost.pluginViewNotFound")}</div>;
  return <McpAppView payload={view.payload} originSessionId="" />;
}
