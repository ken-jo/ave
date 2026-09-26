/**
 * Shared plugin-alert settings types — safe to import from both main-process
 * and renderer (no Node.js built-in imports).
 *
 * `AppSettings.alerts` holds the user's per-kind choices for the alert kinds
 * plugins declare, and `AppSettings.retiredPluginConfigs` holds the effective
 * config a retired (revoked) plugin left behind so its successors can inherit
 * the user's choices. The settings store normalises and defaults them, and
 * the alerts service (`src/alerts/service.ts`) is their only writer. The
 * design page `docs/design/plugin-alerts.md` owns the shapes.
 */
import type { AlertInheritRule, AlertVisibility } from "../plugins/public-contract.js";
import type { PluginConfigRecord } from "./plugin-config.js";

export type { AlertInheritRule, AlertVisibility };

/** The delivery levels a kind can declare; a plugin may only lower them at raise time. */
const ALERT_VISIBILITIES = ["user-visible", "summary-only", "silent"] as const satisfies readonly AlertVisibility[];

export function isAlertVisibility(value: unknown): value is AlertVisibility {
  return typeof value === "string" && (ALERT_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * The plugin-id slot of a kind key the host itself owns (`@host:<kind>`). No
 * plugin id can start with `@`, so a host kind can never share a settings key
 * with a plugin's kind.
 */
export const ALERT_HOST_PLUGIN_ID = "@host";

/**
 * The package id no plugin may take. The alert pipeline mints the overlay
 * source `overlay:<pluginId>--<kind>` and host kinds use `overlay:host--<kind>`,
 * because a staged source admits no `@`; a plugin named `host` could otherwise
 * mint a host kind's source.
 */
export const ALERT_RESERVED_PACKAGE_ID = "host";

/**
 * An alert card as main stages it: the renderer's overlay item for source
 * kind `alert`. Built only from the kind's declared templates and sanitised
 * slot values; `pendingPrompt` is the envelope an accept inserts.
 */
export interface AlertCard {
  /** `alert:<alertId>`. */
  id: string;
  source: { kind: "alert"; pluginId: string; kindId: string; alertId: string };
  title: string;
  summary: string;
  running: false;
  primaryActionLabel: string;
  pendingPrompt: string;
  priority: "low" | "normal" | "high";
  createdAt: string;
}

/** What the user did to an alert card. */
export type AlertCardClosedReason = "accepted" | "dismissed";

/**
 * A settings key for one alert kind: `<pluginId>:<kind>` or `@host:<kind>`.
 * Both halves follow the manifest grammar — lowercase, digits and single
 * hyphens, never `--`; a plugin id of 3 to 64 characters, a kind id of 2 to
 * 32 — so a key can be split back into its parts without ambiguity, and a
 * hand-edited file cannot store a key no manifest could declare.
 */
const ALERT_KIND_KEY_RE = /^(?!.*--)(?:@host|[a-z][a-z0-9-]{1,62}[a-z0-9]):[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function isAlertKindKey(value: unknown): value is string {
  return typeof value === "string" && ALERT_KIND_KEY_RE.test(value);
}

/** The user's choice for one declared kind. */
export interface AlertKindChoice {
  /** Whether the kind is delivered at all (card, or toast for summary-only kinds). */
  enabled: boolean;
  /** Whether an accepted alert of this kind may also notify the OS. */
  osNotification: boolean;
  /**
   * The declared visibility the user consented to. When a plugin update
   * declares a higher one, the entry is reset to off so an update cannot
   * turn on a card the user never agreed to; lowering never resets.
   */
  visibility: AlertVisibility;
  /** False while the value was resolved by the host and never visited in Settings. */
  seenByUser: boolean;
  /**
   * The app version at which the kind's plugin was uninstalled. Set so a
   * reinstall keeps the user's choice, cleared on reinstall, and the entry is
   * dropped once it is two minor releases behind the running version — unless
   * it is repaired, which must never fall back to the kind's declaration.
   */
  absentSinceAppVersion?: string;
  /**
   * Set only when the stored entry was malformed and the host replaced it
   * with the fail-closed choice. Re-resolution from a retirement leaves a
   * repaired entry alone, and the user's own change clears the mark.
   */
  repaired?: true;
  /**
   * Set when an update raised the kind's declared visibility above the one
   * the user consented to and the host turned the kind off. The user's own
   * change clears the mark. Unlike `repaired`, it does not keep an absent
   * plugin's entry past its age limit.
   */
  escalated?: true;
}

export interface AlertSettings {
  /** Master switch for OS notifications from every kind. Default true. */
  osNotificationsEnabled: boolean;
  /** Keyed by {@link isAlertKindKey}. Absent = not yet resolved. */
  kinds: Record<string, AlertKindChoice>;
}

/** A plugin allowed to inherit from a retired record, as the retirement entry names it. */
export interface RetirementSuccessorPlugin {
  pluginId: string;
  /**
   * Present when the successor lives in a source the official data cannot
   * name. Such a successor may inherit toggles only, never config values.
   */
  anySource?: true;
}

/** How a host-owned kind inherits a toggle from the retired record. */
export interface RetirementHostKindMapping {
  /** A `@host:<kind>` key. */
  kind: string;
  enabled: AlertInheritRule;
  /** Absent when the host kind declares no OS notification. */
  osNotification?: AlertInheritRule;
}

/** The `successors` block of a retirement entry, copied into the retired record. */
export interface RetirementSuccessors {
  plugins: RetirementSuccessorPlugin[];
  hostKinds: RetirementHostKindMapping[];
}

/**
 * What a retirement leaves behind for a plugin: its effective config as the
 * live getter would have merged it, whether the user had the plugin enabled,
 * the marketplace source it was bound to (`null` when never bound), the app
 * version that retired it, who may inherit from it, and which of those have
 * already inherited.
 */
export interface RetiredPluginConfigRecord {
  config: PluginConfigRecord;
  enabled: boolean;
  sourceId: string | null;
  retiredAtAppVersion: string;
  successors: RetirementSuccessors;
  /**
   * Successor plugin ids that have taken their inheritance from this record.
   * The record stays until every successor in `successors.plugins` is listed
   * here and the retired package is gone, so a successor installed late still
   * inherits.
   */
  consumedBy: string[];
}
