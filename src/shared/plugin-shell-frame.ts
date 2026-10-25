/** Shell frames receive only the plugin bridge. Match file protocol and the anchored, case-folded pathname; query-string matches would weaken host IPC denial. */

const PLUGIN_SHELL_PATHNAME_SUFFIX = "/plugin-ui-shell.html";

/** Malformed or empty URLs fail closed here; host IPC guards must separately reject empty URLs because a non-shell frame is not necessarily trusted. */
export function isPluginShellFrameUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") return false;
    return url.pathname.toLowerCase().endsWith(PLUGIN_SHELL_PATHNAME_SUFFIX);
  } catch {
    return false;
  }
}
