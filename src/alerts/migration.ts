import type { AlertKindDeclaration, AlertInheritRule, ConfigInheritDeclaration } from "../plugins/public-contract.js";
import type { AlertKindChoice, AlertSettings, RetiredPluginConfigRecord } from "../shared/alerts-types.js";
import type { PluginConfigRecord } from "../shared/plugin-config.js";
import { sanitizePluginConfig } from "../shared/plugin-config.js";
import { alertKindKey } from "./kinds.js";

export interface AlertMigrationPorts {
  records: {
    get(): Record<string, RetiredPluginConfigRecord>;
    set(records: Record<string, RetiredPluginConfigRecord>): Promise<void>;
  };
  installed(): Promise<readonly { pluginId: string; sourceId: string | null }[]>;
  hasPendingCleanup(pluginId: string): boolean;
  /** Reads target keys and writes under the plugin's config mutation lock. */
  applyConfig(pluginId: string, entries: readonly ConfigInheritDeclaration[], config: PluginConfigRecord): Promise<boolean>;
  /** Schedules a restart outside any registration lifecycle hook. */
  configApplied(pluginId: string): void;
  warn(message: string): void;
}

interface Declaration {
  isReady: () => boolean;
  consumedHere: Set<string>;
  kinds: readonly AlertKindDeclaration[];
  config: readonly ConfigInheritDeclaration[];
}

function isEligible(choice: AlertKindChoice): boolean {
  return !choice.seenByUser && !choice.repaired && !choice.escalated;
}

function inheritedToggle(config: PluginConfigRecord, rule: AlertInheritRule): boolean {
  if (rule.masterKey && config[rule.masterKey] === false) return false;
  const list = config[rule.key];
  const listed = Array.isArray(list) && rule.values.some((value) => list.includes(value));
  return rule.listed === "enabled" ? listed : !listed;
}

/** Only unset saved keys are filled; defaults do not count as a user write. */
export function inheritedConfig(
  current: PluginConfigRecord,
  entries: readonly ConfigInheritDeclaration[],
  source: PluginConfigRecord,
): PluginConfigRecord | null {
  const next = { ...current };
  let changed = false;
  for (const entry of entries) {
    if (Object.hasOwn(next, entry.to)) continue;
    if ("from" in entry) {
      if (!Object.hasOwn(source, entry.from)) continue;
      next[entry.to] = structuredClone(source[entry.from]!);
    } else {
      next[entry.to] = sanitizePluginConfig({ [entry.to]: entry.value })[entry.to]!;
    }
    changed = true;
  }
  return changed ? next : null;
}

/** Runs only inside the alerts service's serialized mutation lane. */
export class AlertMigration {
  private readonly declarations = new Map<string, Declaration>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly ports: AlertMigrationPorts,
    private readonly choices: { get(): AlertSettings; set(settings: AlertSettings): Promise<void> },
    private readonly blocks: (pluginId: string, sourceHint: string) => Promise<boolean>,
  ) {}

  register(pluginId: string, kinds: readonly AlertKindDeclaration[], config: readonly ConfigInheritDeclaration[], isReady: () => boolean): void {
    this.declarations.set(pluginId, { kinds, config, isReady, consumedHere: new Set() });
  }

  forget(pluginId: string): void {
    this.declarations.delete(pluginId);
  }

  private warn(pluginId: string, predecessor: string, entry: string, reason: string): void {
    const key = `${pluginId}:${predecessor}:${entry}:${reason}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ports.warn(`Alert inheritance ignored for '${pluginId}' from '${predecessor}' (${entry}): ${reason}`);
  }

  async run(): Promise<void> {
    const installed = await this.ports.installed();
    const records = structuredClone(this.ports.records.get());
    for (const [predecessor, record] of Object.entries(records)) {
      // Host mappings have no consumedBy entry. Eligible existing host choices
      // are written before any record can be removed. A not-yet-registered host
      // kind keeps its mapping pending until the host creates that choice.
      let hostTerminal = true;
      let settings = this.choices.get();
      let changed = false;
      for (const mapping of record.successors.hostKinds) {
        const choice = settings.kinds[mapping.kind];
        if (!choice) { hostTerminal = false; continue; }
        if (!record.enabled || !isEligible(choice)) continue;
        const next = { ...choice, enabled: inheritedToggle(record.config, mapping.enabled),
          osNotification: mapping.osNotification ? inheritedToggle(record.config, mapping.osNotification) : false };
        if (next.enabled !== choice.enabled || next.osNotification !== choice.osNotification) {
          settings = { ...settings, kinds: { ...settings.kinds, [mapping.kind]: next } };
          changed = true;
        }
      }
      if (changed) await this.choices.set(settings);

      for (const [pluginId, declaration] of this.declarations) {
        if (!declaration.isReady()) continue;
        const kinds = declaration.kinds.filter((kind) => kind.inherits?.[0]?.pluginId === predecessor);
        const config = declaration.config.filter((entry) => entry.pluginId === predecessor);
        if (kinds.length === 0 && config.length === 0) continue;
        const entries = [...kinds.map((kind) => `kind:${kind.id}`), ...config.map((entry) => `config:${entry.to}`)];
        if (record.consumedBy.includes(pluginId)) {
          if (declaration.consumedHere.has(predecessor)) continue;
          for (const entry of entries) this.warn(pluginId, predecessor, entry, "already consumed by an earlier registration");
          continue;
        }
        const successor = record.successors.plugins.find((entry) => entry.pluginId === pluginId);
        const source = installed.find((entry) => entry.pluginId === pluginId);
        if (!source) continue;
        if (!successor || (!successor.anySource && (record.sourceId === null || source.sourceId !== record.sourceId))) {
          for (const entry of entries) this.warn(pluginId, predecessor, entry, "retirement does not authorize this successor source");
          continue;
        }
        let kindsTerminal = true;
        for (const kind of kinds) {
          const inherit = kind.inherits![0]!;
          if (await this.blocks(predecessor, inherit.sourceId)) { kindsTerminal = false; continue; }
          const current = this.choices.get();
          const key = alertKindKey(pluginId, kind.id);
          const choice = current.kinds[key];
          if (!choice) { kindsTerminal = false; continue; }
          if (!record.enabled || !isEligible(choice)) continue;
          const next = { ...choice, enabled: inheritedToggle(record.config, inherit.enabled),
            osNotification: kind.osNotification && inherit.osNotification ? inheritedToggle(record.config, inherit.osNotification) : false };
          if (next.enabled !== choice.enabled || next.osNotification !== choice.osNotification) {
            await this.choices.set({ ...current, kinds: { ...current.kinds, [key]: next } });
          }
        }
        if (successor.anySource) {
          for (const entry of config) this.warn(pluginId, predecessor, `config:${entry.to}`, "any-source successors may inherit toggles only");
        } else if (record.enabled && config.length > 0) {
          if (await this.ports.applyConfig(pluginId, config, record.config)) this.ports.configApplied(pluginId);
        }
        if (!kindsTerminal || !declaration.isReady()) continue;
        // Writes above settled before binding this version's whole declaration.
        record.consumedBy = [...record.consumedBy, pluginId];
        await this.ports.records.set({ ...this.ports.records.get(), [predecessor]: record });
        declaration.consumedHere.add(predecessor);
      }
      if (hostTerminal && record.successors.plugins.every((entry) => record.consumedBy.includes(entry.pluginId))
        && !installed.some((entry) => entry.pluginId === predecessor) && !this.ports.hasPendingCleanup(predecessor)) {
        const next = { ...this.ports.records.get() };
        delete next[predecessor];
        await this.ports.records.set(next);
      }
    }
  }
}
