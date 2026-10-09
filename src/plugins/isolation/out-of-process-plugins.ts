/**
 * The removal predicate of the retained in-process loader.
 *
 * This file used to be the routing census: a frozen set of plugin ids served by
 * a child, with the per-plugin admission record that justified each one. Since
 * Admission (`docs/design/plugin-hostapi-protocol.md` §9.8 A1, decision 50)
 * routing has no input — every `entry` manifest gets a child — so the census
 * and its narrative are gone; the record is in the history of this file
 * before that slice.
 *
 * What is left is the question the census used to answer by lookup: does the
 * in-process loader (`importInProcessPluginFactory`) still have a reason to
 * exist? It is answered over what actually loaded (decision 51), never over a
 * list of ids.
 */
import type { PluginLoadArm } from "../runtime/types.js";

/**
 * True when at least one plugin loaded and every one of them loaded as a child.
 *
 * Fed by the runtime's registry of loaded plugins (`PluginRuntime.listLoadedPluginArms`),
 * which records the arm the routing function returned for each generation. An
 * empty list is no evidence either way, so it is `false`. This is the
 * mechanical half of the Loader removal condition (§9.8, "Loader removal,
 * restated after Admission").
 */
export function allPluginsAreOutOfProcess(
  loaded: ReadonlyArray<{ pluginId: string; arm: PluginLoadArm }>,
): boolean {
  return loaded.length > 0 && loaded.every((plugin) => plugin.arm === "child");
}
