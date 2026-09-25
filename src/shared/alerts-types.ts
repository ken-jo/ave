/**
 * Shared plugin-alert settings types — safe to import from both main-process
 * and renderer (no Node.js built-in imports).
 *
 * `AppSettings.alerts` holds the user's per-kind choices for the alert kinds
 * plugins declare, and `AppSettings.retiredPluginConfigs` holds the effective
 * config a retired (revoked) plugin left behind so its successors can inherit
 * the user's choices. Both keys land here ahead of the pipeline that reads
 * them: the settings store normalises and defaults them, nothing else touches
 * them yet. The design page `docs/design/plugin-alerts.md` owns the shapes.
 */
import type { PluginConfigRecord } from "./plugin-config.js";

/** The delivery levels a kind can declare; a plugin may only lower them at raise time. */
const ALERT_VISIBILITIES =["user-visible", "summary-only", "silent"] as const;
export type AlertVisibility = (typeof ALERT_VISIBILITIES)[number];

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
 * A settings key for one alert kind: `<pluginId>:<kind>` or `@host:<kind>`.
 * Both halves follow the manifest grammar — lowercase, digits and single
 * hyphens, never `--` — so a key can be split back into its parts without
 * ambiguity. Bounded so a hand-edited file cannot store an unbounded key.
 */
const ALERT_KIND_KEY_RE = /^(?!.*--)(?:@host|[a-z][a-z0-9-]{0,62}[a-z0-9]|[a-z]):[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

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
   * dropped once it is two minor releases behind the running version.
   */
  absentSinceAppVersion?: string;
}

export interface AlertSettings {
  /** Master switch for OS notifications from every kind. Default true. */
  osNotificationsEnabled: boolean;
  /** Keyed by {@link isAlertKindKey}. Absent = not yet resolved. */
  kinds: Record<string, AlertKindChoice>;
}

/**
 * How a successor kind reads one toggle out of a retired plugin's config: the
 * list stored at `key` either names the disabled members (`listed:
 * "disabled"`) or the enabled ones (`listed: "enabled"`), and `values` are the
 * spellings — current and legacy — under which this kind appears in it.
 * `masterKey` names a boolean that, when false, turns the toggle off outright.
 */
export interface AlertInheritRule {
  key: string;
  listed: "enabled" | "disabled";
  values: string[];
  masterKey?: string;
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
 * version that retired it, and who may inherit from it.
 */
export interface RetiredPluginConfigRecord {
  config: PluginConfigRecord;
  enabled: boolean;
  sourceId: string | null;
  retiredAtAppVersion: string;
  successors: RetirementSuccessors;
}
