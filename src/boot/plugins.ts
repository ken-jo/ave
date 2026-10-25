

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

/** Wildcard metadata excludes secrets and API identity during subscription generation; refresh must preserve this contract. */
export function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // Keys must pass getSecret’s hostSecrets.read allow-list, never wildcard config injection.
  const hostApiVendor = activeHostApiVendor(llm);
  if (hostApiVendor) {
    overrides["*"] = { hostApiVendor };
  }

  const pluginConfigs = settings.get("pluginConfigs");
  for (const [pluginId, config] of Object.entries(pluginConfigs)) {
    overrides[pluginId] = { ...(overrides[pluginId] ?? {}), ...config };
  }

  return overrides;
}

// Plugin registration flows through loopback discovery in boot/steps/plugin-runtime.ts.

export function registerManifestEventSubscriptions(
  pluginRuntime: PluginRuntime,
  eventCollector: EventCollector,
  auditLogger?: Pick<AuditLogger, "log">,
): void {
  const eventTypes = new Set<string>();
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      const eventType = typeof entry === "string" ? entry : entry.type;
      // Private namespaces never reach plugins; unknown neutral namespaces warn for drift.
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
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
        hints[entry] = { category: "system", priority: "low", title: entry };
      } else {
        hints[entry.type] = entry.hint
          ? { category: entry.hint.category, priority: entry.hint.priority, title: entry.hint.title }
          : { category: "system", priority: "low", title: entry.type };
      }
    }
  }
  return hints;
}
