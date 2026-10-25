/**
 * The floating dock's asset URLs, carried from main to the dock's preload as
 * `webPreferences.additionalArguments`.
 *
 * The dock window runs sandboxed, and a sandboxed preload can require only
 * `electron` — not `node:path`, so it cannot
 * resolve a sibling file from `__dirname` the way the host preload does. Main
 * already resolves every runtime asset (`runtimeAssetPath`), so it passes the
 * two URLs the dock mounts plugin cards with, and the preload reads them from
 * `process.argv`, which a sandboxed preload has. This module is the wire
 * format's single source; it imports nothing.
 */

/** The `plugin-ui-shell.html` URL a dock slot's `<webview>` loads. */
const DOCK_PLUGIN_SHELL_ARG_PREFIX = "--ave-dock-plugin-shell=";
/** The `plugin-preload.cjs` URL a dock slot's `<webview>` names. */
const DOCK_PLUGIN_PRELOAD_ARG_PREFIX = "--ave-dock-plugin-preload=";

export interface DockAssetUrls {
  pluginShellUrl: string;
  pluginPreloadUrl: string;
}

/** The `additionalArguments` main gives the dock window. */
export function dockAssetArgs(urls: DockAssetUrls): string[] {
  return [`${DOCK_PLUGIN_SHELL_ARG_PREFIX}${urls.pluginShellUrl}`, `${DOCK_PLUGIN_PRELOAD_ARG_PREFIX}${urls.pluginPreloadUrl}`];
}

/**
 * The URLs main passed. Missing ones are a broken main/preload contract, not a
 * state to paper over, so this throws and the dock reports its bridge missing.
 */
export function readDockAssetArgs(argv: readonly string[]): DockAssetUrls {
  const read = (prefix: string): string => {
    const arg = argv.find((value) => value.startsWith(prefix));
    const url = arg?.slice(prefix.length) ?? "";
    if (!url.startsWith("file:")) throw new Error(`floating dock preload: main passed no ${prefix.slice(2, -1)} file URL`);
    return url;
  };
  return { pluginShellUrl: read(DOCK_PLUGIN_SHELL_ARG_PREFIX), pluginPreloadUrl: read(DOCK_PLUGIN_PRELOAD_ARG_PREFIX) };
}
