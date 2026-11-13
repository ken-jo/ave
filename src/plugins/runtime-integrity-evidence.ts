import type { RuntimePlugin, RuntimePluginFactory } from "./types.js";
import type { PluginIntegrityEvidence } from "./runtime/index.js";

export interface PluginRuntimeIntegrityEvidence {
  readonly pluginId: string;
  readonly integrity: Readonly<PluginIntegrityEvidence>;
}

const factoryEvidence = new WeakMap<RuntimePluginFactory, PluginRuntimeIntegrityEvidence>();
const instanceEvidence = new WeakMap<RuntimePlugin, PluginRuntimeIntegrityEvidence>();

// Receipt verification reaches the routing funnel before any child is constructed.
export function recordPluginFactoryIntegrity(
  factory: RuntimePluginFactory,
  pluginId: string,
  integrity: PluginIntegrityEvidence | undefined,
): void {
  if (integrity === undefined) {
    factoryEvidence.delete(factory);
    return;
  }
  factoryEvidence.set(factory, Object.freeze({ pluginId, integrity: Object.freeze({ ...integrity }) }));
}

// The exact instance, rather than the plugin ID, keeps replacement attempts separate.
export function bindPluginInstanceIntegrity(instance: RuntimePlugin, factory: RuntimePluginFactory): void {
  const evidence = factoryEvidence.get(factory);
  if (evidence === undefined) {
    instanceEvidence.delete(instance);
    return;
  }
  instanceEvidence.set(instance, evidence);
}

export function readPluginInstanceIntegrity(instance: RuntimePlugin): PluginRuntimeIntegrityEvidence | undefined {
  return instanceEvidence.get(instance);
}
