/**
 * The kinds each plugin registered, and what registering does to the user's
 * choices in `settings.alerts.kinds`.
 *
 * A missing entry is written the first time its kind registers, blocked or
 * not, so its origin is durable from that moment: a fresh install takes the
 * kind's declared defaults, and a kind first seen in an update of a plugin
 * already installed is written off — an update must not turn on a card the
 * user never agreed to. An existing entry keeps its value, except that a
 * declared visibility above the one the user consented to turns it off and
 * marks it escalated. Inheritance from a retired plugin is a separate pass.
 */
import { join } from "node:path";
import type { AlertKindDeclaration, AlertVisibility } from "../plugins/public-contract.js";
import type { AlertKindChoice, AlertSettings } from "../shared/alerts-types.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import { readJsonFileOrEmpty, writeJsonAtomic } from "../main/storage/feature-namespace.js";

const log = createLogger("alerts");

const VISIBILITY_RANK: Record<AlertVisibility, number> = { silent: 0, "summary-only": 1, "user-visible": 2 };

/** The settings key of a plugin's kind. */
export function alertKindKey(pluginId: string, kindId: string): string {
  return `${pluginId}:${kindId}`;
}

/** How this registration of the plugin came about. */
export type RegistrationOrigin = "install" | "update";

/**
 * Apply one registration of `pluginId`'s declared kinds to the stored
 * choices. Returns the settings to store, or `null` when nothing changes.
 */
export function resolveRegistration(
  settings: AlertSettings,
  pluginId: string,
  kinds: readonly AlertKindDeclaration[],
  origin: RegistrationOrigin,
): AlertSettings | null {
  const next: Record<string, AlertKindChoice> = { ...settings.kinds };
  let changed = false;
  for (const kind of kinds) {
    const key = alertKindKey(pluginId, kind.id);
    const existing = next[key];
    if (existing === undefined) {
      const fresh = origin === "install";
      next[key] = {
        enabled: fresh && kind.defaultEnabled,
        osNotification: fresh && (kind.osNotification?.defaultEnabled ?? false),
        visibility: kind.visibility,
        seenByUser: false,
      };
      changed = true;
      continue;
    }
    let entry = existing;
    if (entry.absentSinceAppVersion !== undefined) {
      // Reinstalled before the entry aged out: the user's choice is back.
      const { absentSinceAppVersion: _returned, ...present } = entry;
      entry = present;
    }
    if (VISIBILITY_RANK[kind.visibility] > VISIBILITY_RANK[entry.visibility]) {
      // Consent to a lower level is not consent to this one. Escalation only
      // ever turns a kind off, whatever flags the entry carries.
      entry = { ...entry, enabled: false, seenByUser: false, visibility: kind.visibility, escalated: true };
    }
    if (entry !== existing) {
      next[key] = entry;
      changed = true;
    }
  }
  return changed ? { ...settings, kinds: next } : null;
}

/** Mark every stored kind of an uninstalled plugin absent since `appVersion`, so a reinstall keeps them. */
export function markPluginAbsent(settings: AlertSettings, pluginId: string, appVersion: string): AlertSettings | null {
  const prefix = `${pluginId}:`;
  const next: Record<string, AlertKindChoice> = { ...settings.kinds };
  let changed = false;
  for (const [key, entry] of Object.entries(settings.kinds)) {
    if (!key.startsWith(prefix) || entry.absentSinceAppVersion !== undefined) continue;
    next[key] = { ...entry, absentSinceAppVersion: appVersion };
    changed = true;
  }
  return changed ? { ...settings, kinds: next } : null;
}

const LEDGER_FILE = "plugins.json";

/**
 * The plugins the alerts service has seen registered, so a registration can
 * tell a fresh install from an update. The first time the file is created,
 * every plugin already installed is recorded: those predate the service, so
 * a kind they bring is an update's. An uninstall forgets the plugin, so a
 * later reinstall counts as fresh.
 */
export class RegistrationLedger {
  private known: Set<string> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: () => string) {}

  async load(installedAtFirstUse: () => Promise<readonly string[]>): Promise<void> {
    const stored = await readJsonFileOrEmpty<Set<string> | null>(
      join(this.dir(), LEDGER_FILE),
      () => null,
      (parsed) =>
        isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.plugins)
          ? new Set(parsed.plugins.filter((id): id is string => typeof id === "string"))
          : null,
    );
    if (stored) {
      this.known = stored;
      return;
    }
    this.known = new Set(await installedAtFirstUse());
    this.persist();
    await this.writes;
  }

  private loaded(): Set<string> {
    if (this.known === null) throw new Error("RegistrationLedger used before load() resolved");
    return this.known;
  }

  /** Record a registration and say how it came about. */
  register(pluginId: string): RegistrationOrigin {
    const known = this.loaded();
    if (known.has(pluginId)) return "update";
    known.add(pluginId);
    this.persist();
    return "install";
  }

  forget(pluginId: string): void {
    if (this.loaded().delete(pluginId)) this.persist();
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): void {
    const file = { version: 1, plugins: [...this.loaded()].sort() };
    this.writes = this.writes.then(() => writeJsonAtomic(this.dir(), LEDGER_FILE, file)).catch((err: unknown) => {
      // The in-memory set still answers for this session.
      log.warn(`could not persist the alert registration ledger: ${errorMessage(err)}`);
    });
  }
}
