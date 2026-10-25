/** Sandboxed preload cannot resolve filesystem paths; main passes runtime asset URLs through additionalArguments. */

/** The `plugin-ui-shell.html` URL a dock slot's `<webview>` loads. */
const DOCK_PLUGIN_SHELL_ARG_PREFIX = "--ave-dock-plugin-shell=";
/** The `plugin-preload.cjs` URL a dock slot's `<webview>` names. */
const DOCK_PLUGIN_PRELOAD_ARG_PREFIX = "--ave-dock-plugin-preload=";

export interface DockAssetUrls {
  pluginShellUrl: string;
  pluginPreloadUrl: string;
}

export function dockAssetArgs(urls: DockAssetUrls): string[] {
  return [`${DOCK_PLUGIN_SHELL_ARG_PREFIX}${urls.pluginShellUrl}`, `${DOCK_PLUGIN_PRELOAD_ARG_PREFIX}${urls.pluginPreloadUrl}`];
}

/** Missing URLs are a broken main/preload contract and must fail loudly. */
export function readDockAssetArgs(argv: readonly string[]): DockAssetUrls {
  const read = (prefix: string): string => {
    const arg = argv.find((value) => value.startsWith(prefix));
    const url = arg?.slice(prefix.length) ?? "";
    if (!url.startsWith("file:")) throw new Error(`floating dock preload: main passed no ${prefix.slice(2, -1)} file URL`);
    return url;
  };
  return { pluginShellUrl: read(DOCK_PLUGIN_SHELL_ARG_PREFIX), pluginPreloadUrl: read(DOCK_PLUGIN_PRELOAD_ARG_PREFIX) };
}
