import type { PluginManifest } from "../../../plugins/types.js";

export function declaresHostManagedPythonRuntime(
  manifest: Pick<PluginManifest, "python">,
): boolean {
  return manifest.python?.managedBy === "ave" ||
    typeof manifest.python?.requirementsLock === "string";
}
