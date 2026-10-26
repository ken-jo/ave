/** Read the execution arm of loaded generations; plugin IDs never decide whether the in-process loader is removable. */
import type { PluginLoadArm } from "../runtime/types.js";

/** Return true only for a nonempty loaded set consisting entirely of child generations. */
export function allPluginsAreOutOfProcess(
  loaded: ReadonlyArray<{ pluginId: string; arm: PluginLoadArm }>,
): boolean {
  return loaded.length > 0 && loaded.every((plugin) => plugin.arm === "child");
}
