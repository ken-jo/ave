/** Persist defaults on first registration; update-added kinds start disabled. Increased visibility revokes existing consent. */
import { join } from "node:path";
import type { AlertKindDeclaration, AlertVisibility } from "../plugins/public-contract.js";
import type { AlertKindChoice, AlertSettings } from "../shared/alerts-types.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import { readJsonFileOrEmpty, writeJsonAtomic } from "../main/storage/feature-namespace.js";

const log = createLogger("alerts");

const VISIBILITY_RANK: Record<AlertVisibility, number> = { silent: 0, "summary-only": 1, "user-visible": 2 };

export function alertKindKey(pluginId: string, kindId: string): string {
  return `${pluginId}:${kindId}`;
}

export type RegistrationOrigin = "install" | "update";

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
      const { absentSinceAppVersion: _returned, ...present } = entry;
      entry = present;
    }
    if (VISIBILITY_RANK[kind.visibility] > VISIBILITY_RANK[entry.visibility]) {
      // Visibility escalation only disables; lower-level consent cannot authorize it.
      entry = { ...entry, enabled: false, seenByUser: false, visibility: kind.visibility, escalated: true };
    }
    if (entry !== existing) {
      next[key] = entry;
      changed = true;
    }
  }
  return changed ? { ...settings, kinds: next } : null;
}

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

/** Seed existing plugins as updates; forgetting an uninstall makes a later reinstall fresh. */
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
      log.warn(`could not persist the alert registration ledger: ${errorMessage(err)}`);
    });
  }
}
