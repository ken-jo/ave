



import type { PluginRuntime } from "../plugins/runtime.js";
import type { SettingsService } from "../data/settings-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { activeHostApiVendor } from "./steps/refresh-active-llm-wildcard.js";
import { classifySubscription } from "../plugins/capabilities.js";
import { onEvent } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("ave");

export interface EventCollector {
  collectEvent(type: string, data?: unknown): void;
}

export interface EventHint {
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
}

/**
 * Build the plugin configOverrides map: non-secret metadata only.
 *
 * The wildcard slot must never carry `llmApiKey`.
 * Plugins receive the actual key via `hostApi.getSecret("llm.apiKey.<vendor>")`,
 * which routes through the three-tier `hostSecrets.read[]` allowlist gate.
 * Injecting the key here would bypass the gate and leak the secret to every
 * loaded plugin regardless of its manifest. The host projects `hostApiVendor`
 * only while an API provider owns generation; it deliberately omits that
 * legacy API identity while a subscription runtime is active. The same
 * contract is re-applied by `refreshActiveLlmWildcard` after every runtime
 * selection or API-vendor change.
 *
 * Per-plugin entries in `pluginConfigs` are merged unchanged.
 */
export function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // Wildcard slot carries only non-secret metadata. The host secret stays
  // gated behind getSecret(). Injecting `llmApiKey` here would bypass
  // `hostSecrets.read[]`, so this slot deliberately carries no key.
  const hostApiVendor = activeHostApiVendor(llm);
  if (hostApiVendor) {
    overrides["*"] = { hostApiVendor };
  }

  // Merge per-plugin configs from settings
  const pluginConfigs = settings.get("pluginConfigs");
  for (const [pluginId, config] of Object.entries(pluginConfigs)) {
    overrides[pluginId] = { ...(overrides[pluginId] ?? {}), ...config };
  }

  return overrides;
}

// legacy-removal flag-day (mcp-alignment-design.md §5): the manifest-driven
// `pluginToolsForRegistration` registration path + its `registerPluginTools` /
// `syncPluginToolRegistry` / `syncPluginToolRegistryForPlugin` orchestration are
// REMOVED. Every plugin now registers through `PluginLoopbackManager` (the host
// runs each plugin as an in-process MCP server: server/discover → tools/list →
// reverse projection from `_meta`), wired in `boot/steps/plugin-runtime.ts`.

export function registerManifestEventSubscriptions(
  pluginRuntime: PluginRuntime,
  eventCollector: EventCollector,
  auditLogger?: Pick<AuditLogger, "log">,
): void {
  const eventTypes = new Set<string>();
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      const eventType = typeof entry === "string" ? entry : entry.type;
      // Namespace allowlist. Private namespaces (memory.private.*,
      // settings.apiKey.*, audit.*, dlp.*) are never exposed to plugins;
      // neutral namespaces pass with a warn so ops can track drift.
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
        // Audit unauthorized private namespace subscription attempts.
        try {
          auditLogger?.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "error",
            input: `[plugin:${pluginId}] plugin_subscription_private_denied eventType=${eventType}`,
          });
        } catch { /* audit must not break host */ }
        log.warn(
          `plugin:${pluginId} eventSubscriptions['${eventType}'] dropped — private namespace`,
        );
        continue;
      }
      if (verdict === "neutral") {
        log.warn(
          `plugin:${pluginId} eventSubscriptions['${eventType}'] — outside public allowlist (allowed with warn)`,
        );
      }
      eventTypes.add(eventType);
    }
  }
  for (const eventType of eventTypes) {
    onEvent(eventType, (data) => eventCollector.collectEvent(eventType, data));
  }
}

export function buildManifestEventHints(
  pluginRuntime: PluginRuntime,
): Record<string, EventHint> {
  const hints: Record<string, EventHint> = {};
  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      if (typeof entry === "string") {
        // String form: neutral default hint.
        hints[entry] = { category: "system", priority: "low", title: entry };
      } else {
        // Object form: use plugin-declared hint if present, else default hint.
        hints[entry.type] = entry.hint
          ? { category: entry.hint.category, priority: entry.hint.priority, title: entry.hint.title }
          : { category: "system", priority: "low", title: entry.type };
      }
    }
  }
  return hints;
}
