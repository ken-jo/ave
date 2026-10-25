import type { AuditEntry } from "../../../audit/audit-logger.js";
import type { SettingsService } from "../../../data/settings-store.js";
import { validateExternalUrl } from "../../../shared/external-url.js";

/** Persist shared origin-scoped cookies for link viewing; sandboxed plugins never receive cookie values. */
export const EXTERNAL_LINK_PARTITION = "persist:ave-external-link";

/** Read routing policy live; audit origin and path only because queries may contain secrets. */
export async function routeExternalUrl(input: {
  url: string;
  pluginId: string;
  settingsService: Pick<SettingsService, "get">;
  bootAuditLogger: { log: (entry: AuditEntry) => void };
  openLinkWindowService: (
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  shellOpenExternal: (url: string) => Promise<void>;
}): Promise<void> {
  const { url, pluginId, settingsService, bootAuditLogger, openLinkWindowService, shellOpenExternal } = input;
  // Delegate scheme and embedded-credential checks to the shared URL validator.
  const validated = validateExternalUrl(url);
  if (!validated.ok) {
    if (validated.error === "invalid-url") {
      throw new Error(`[plugin:${pluginId}] openExternalUrl: url must be a non-empty string`);
    }
    if (validated.error === "malformed-url") {
      throw new Error(`[plugin:${pluginId}] openExternalUrl: invalid URL`);
    }
    if (validated.error === "embedded-credentials") {
      throw new Error(
        `[plugin:${pluginId}] openExternalUrl: URLs with embedded credentials are not allowed`,
      );
    }
    throw new Error(
      `[plugin:${pluginId}] openExternalUrl: only http(s) URLs are allowed (got ${validated.protocol})`,
    );
  }
  const parsed = new URL(validated.url);
  const safeUrlForLog = `${parsed.origin}${parsed.pathname}`;
  const flow = settingsService.get("webView")?.preferredFlow ?? "in-app";

  try {
    bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input: `[plugin:${pluginId}] openExternalUrl flow=${flow} url=${safeUrlForLog}`,
    });
  } catch { /* audit must not break host */ }

  // Send only the canonical URL; raw markup characters can escape the link-window document.
  if (flow === "system-browser") {
    await shellOpenExternal(validated.url);
    return;
  }
  await openLinkWindowService({ url: validated.url, persistPartition: EXTERNAL_LINK_PARTITION });
}
