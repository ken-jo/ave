import { usePluginAuthRevision, type PluginAuthState } from "../hooks/use-plugin-auth-status.js";
import { McpAppView } from "./McpAppView.js";
import type { PluginUiExtensionView } from "../../../shared/plugin-ui-view.js";
import { useTranslation } from "../../../i18n/react.js";

/** Panel placement reuses the same resource loader and standard bridge as conversation cards. */
export function McpAppPanelContent({ view, authStatus, authError, preparing = false }: {
  view: PluginUiExtensionView | null;
  authStatus?: PluginAuthState;
  authError?: string | null;
  preparing?: boolean;
}) {
  const { t } = useTranslation();
  const authRevision = usePluginAuthRevision(authStatus);
  if (authError) return <div className="p-3 text-xs text-destructive">{authError}</div>;
  if (!view) return <div className="p-3 text-xs text-muted-foreground">{t(preparing ? "be_pluginUiHost.pluginUiLoadingDesc" : "be_pluginUiHost.pluginViewNotFound")}</div>;
  return <McpAppView key={authRevision} payload={view.payload} originSessionId="" />;
}
