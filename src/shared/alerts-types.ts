/** Browser-safe alert contracts; docs/design/plugin-alerts.md owns their shapes and the alert service owns writes. */
import type { AlertInheritRule, AlertKindDeclaration, AlertVisibility } from "../plugins/public-contract.js";
import { isRecord } from "./is-record.js";
import type { PluginConfigRecord } from "./plugin-config.js";

export type { AlertInheritRule, AlertVisibility };

/** The delivery levels a kind can declare; a plugin may only lower them at raise time. */
const ALERT_VISIBILITIES = ["user-visible", "summary-only", "silent"] as const satisfies readonly AlertVisibility[];

export function isAlertVisibility(value: unknown): value is AlertVisibility {
  return typeof value === "string" && (ALERT_VISIBILITIES as readonly string[]).includes(value);
}

/** Reserve @host keys so host and plugin alert kinds cannot collide. */
export const ALERT_HOST_PLUGIN_ID = "@host";

/** Reserve host as a package id so plugins cannot mint host-kind overlay sources. */
export const ALERT_RESERVED_PACKAGE_ID = "host";

/** Build cards from declared templates and sanitized slots; acceptance inserts the pending envelope. */
export interface AlertCard {
  /** `alert:<alertId>`. */
  id: string;
  source: { kind: "alert"; pluginId: string; kindId: string; alertId: string };
  /** Installed manifest name resolved by the host, or the plugin id. */
  pluginDisplayName: string;
  title: string;
  summary: string;
  running: false;
  primaryActionLabel: string;
  pendingPrompt: string;
  priority: "low" | "normal" | "high";
  createdAt: string;
}

export type AlertCardClosedReason = "accepted" | "dismissed";

/** Main computes removal eligibility; the renderer never supplies these facts. */
export interface AlertPredecessorState {
  pluginId: string;
  label: string;
  locked: boolean;
  restartRequired: boolean;
  removable: boolean;
}

export type RemoveAlertPredecessorResult =
  | { ok: true; value: import("./git-marketplace.js").UninstallResultView }
  | { ok: false; error: "invalid-arguments" | "unauthorized-frame" | "no-alerts-service" | "predecessor-not-removable" | "predecessor-policy-locked" | "predecessor-removal-failed" };

export interface AlertKindRow {
  kindKey: string;
  pluginId: string;
  pluginLabel: string;
  reasoning: string;
  declaration: AlertKindDeclaration;
  choice: AlertKindChoice;
  blockedByPredecessor: string | null;
  predecessor: AlertPredecessorState | null;
}

/** Only user switches are writable; consent metadata is owned by the service. */
export type AlertKindPatch = Partial<Pick<AlertKindChoice, "enabled" | "osNotification">>;

export function isAlertKindPatch(value: unknown): value is AlertKindPatch {
  return isRecord(value) && Object.entries(value).every(
    ([key, entry]) => (key === "enabled" || key === "osNotification") && typeof entry === "boolean",
  );
}

interface AlertSettingsError {
  ok: false;
  error: "invalid-arguments" | "kind-not-registered" | "no-alerts-service" | "unauthorized-frame";
}

export type SetAlertKindResult = AlertKindRow | AlertSettingsError;
export type SetAlertOsNotificationsResult = { osNotificationsEnabled: boolean } | AlertSettingsError;

/** Validate both key halves against manifest grammar so persisted keys remain unambiguously splittable. */
const ALERT_KIND_KEY_RE = /^(?!.*--)(?:@host|[a-z][a-z0-9-]{1,62}[a-z0-9]):[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function isAlertKindKey(value: unknown): value is string {
  return typeof value === "string" && ALERT_KIND_KEY_RE.test(value);
}

export interface AlertKindChoice {
  /** Whether the kind is delivered at all (card, or toast for summary-only kinds). */
  enabled: boolean;
  /** Whether an accepted alert of this kind may also notify the OS. */
  osNotification: boolean;
  /** Raised visibility resets consent to off; lowering visibility preserves the user’s choice. */
  visibility: AlertVisibility;
  /** False while the value was resolved by the host and never visited in Settings. */
  seenByUser: boolean;
  /** Retain uninstall choices for two minor releases; repaired entries must never revert to declaration defaults. */
  absentSinceAppVersion?: string;
  /** Malformed entries resolve fail-closed; only a user change clears the repaired marker. */
  repaired?: true;
  /** Visibility increases disable delivery until the user changes it; this marker does not extend retirement age. */
  escalated?: true;
}

export interface AlertSettings {
  osNotificationsEnabled: boolean;
  /** Keyed by {@link isAlertKindKey}. Absent = not yet resolved. */
  kinds: Record<string, AlertKindChoice>;
}

export interface RetirementSuccessorPlugin {
  pluginId: string;
  /** Successors outside official source identity may inherit toggles but never config values. */
  anySource?: true;
}

export interface RetirementHostKindMapping {
  /** A `@host:<kind>` key. */
  kind: string;
  enabled: AlertInheritRule;
  /** Absent when the host kind declares no OS notification. */
  osNotification?: AlertInheritRule;
}

export interface RetirementSuccessors {
  plugins: RetirementSuccessorPlugin[];
  hostKinds: RetirementHostKindMapping[];
}

/** Retain effective config, enablement, provenance, retirement version, and successor progress for inheritance. */
export interface RetiredPluginConfigRecord {
  config: PluginConfigRecord;
  enabled: boolean;
  sourceId: string | null;
  retiredAtAppVersion: string;
  successors: RetirementSuccessors;
  /** Keep retirement data until all successors inherit and the retired package is gone. */
  consumedBy: string[];
}
