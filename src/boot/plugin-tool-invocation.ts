import {
  type PluginRuntime,
  type PluginToolInvocationContext,
} from "../plugins/runtime.js";
import type { InvocationOrigin } from "../plugins/runtime/origin-chain.js";
import { isUiOnly, isModelVisible } from "../plugins/runtime/tool-visibility.js";

type RuntimeManifestView = Pick<PluginRuntime, "listPluginManifests">;

type AppOnlyRuntimeView = Pick<
  PluginRuntime,
  "listPluginManifests" | "callDeclaredAppOnlyTool"
>;

function findOwnerManifest(
  pluginRuntime: RuntimeManifestView,
  ownerPluginId: string | undefined,
) {
  if (!ownerPluginId) return undefined;
  return pluginRuntime
    .listPluginManifests()
    .find((candidate) => candidate.pluginId === ownerPluginId)
    ?.manifest;
}

export function isAppOnlyRuntimeInvocation(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
  effectiveOrigin: InvocationOrigin | undefined,
): boolean {
  // Only trusted panel origins can select the app-only bypass; model and untrusted app chains stay governed.
  if (effectiveOrigin !== "ui") return false;

  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (!manifest) return false;
  // Tool visibility is authoritative; any model-visible tool stays on the governed executor.
  const tool = manifest.tools.find((t) => t.name === toolName);
  // Operation-governed tools stay on the executor even when visible only in apps.
  if (tool?._meta?.["ave/operationPolicy"]) return false;
  return tool != null && isUiOnly(tool);
}

/** Status polling alone skips user activation; untrusted app origins never reach this bypass. */
export function appOnlyRuntimeInvocationRequiresUserAction(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
): boolean {
  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (!manifest) return true;
  return manifest.auth?.statusTool !== toolName;
}

/** The runtime owns the execution ceiling; timing out releases the caller without aborting detached handler work. */
export async function dispatchAppOnlyRuntimeInvocation(
  pluginRuntime: AppOnlyRuntimeView,
  toolName: string,
  input: Record<string, unknown>,
  context: PluginToolInvocationContext,
  ceilingMs?: number,
  beforeHandler?: () => void,
): Promise<unknown> {
  // Recheck routing at this exported boundary so callers cannot bypass review for model-visible tools.
  const ownerManifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  const ownerTool = ownerManifest?.tools.find((t) => t.name === toolName);
  if (ownerTool && isModelVisible(ownerTool)) {
    throw new Error(
      `'${toolName}' is a model-visible tool; refusing ungoverned app-only dispatch`,
    );
  }
  if (
    appOnlyRuntimeInvocationRequiresUserAction(pluginRuntime, toolName, context) &&
    context.userAction !== true
  ) {
    // Nested plugin calls do not carry userAction; report the manifest constraint instead of a missing gesture.
    if (context.origin === "plugin") {
      throw new Error(
        `'${toolName}' is an app-only-visibility method (_meta.ui.visibility:["app"]) and cannot be ` +
          `invoked from a plugin-origin ctx.callTool — give it model visibility ` +
          `(_meta.ui.visibility including "model") for governed model/plugin invocation, or drive it ` +
          `from a direct UI activation`,
      );
    }
    throw new Error(`UI action '${toolName}' requires an active user activation`);
  }
  return pluginRuntime.callDeclaredAppOnlyTool(
    toolName,
    input,
    ceilingMs,
    context.ownerGenerationId,
    beforeHandler,
  );
}
