/** Enforce runtime admission and manifest integrity before plugin execution.
 * Preserve structured success data; emit cards only from the reviewed declared UI set. */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginToolDelegate, PluginToolOutcome } from "./plugin-mcp-server.js";
import {
  ManifestIntegrityError,
  manifestIntegrityState,
} from "../permissions/manifest-integrity.js";
import { checkRuntimeAdmission } from "../plugins/runtime/runtime-admission.js";
import { createLogger } from "../lib/logger.js";
import type { McpUiSlot, McpUiToolMeta } from "./types.js";
import { RAW_RESULT_META } from "./protocol-constants.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("plugin-runtime-delegate");

function errorOutcome(text: string): PluginToolOutcome {
  return { content: [{ type: "text", text }], isError: true };
}

/** Split plain-object card metadata from payload without changing other return shapes. */
export function splitPluginToolUiMeta(value: unknown): { value: unknown; ui?: McpUiToolMeta } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { value };
  const record = value as Record<string, unknown>;
  const meta = record._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return { value };
  const rawUi = (meta as Record<string, unknown>).ui;
  if (typeof rawUi !== "object" || rawUi === null || Array.isArray(rawUi)) return { value };

  const { resourceUri, slot, height, title } = rawUi as Record<string, unknown>;
  if (typeof resourceUri !== "string" || resourceUri.length === 0) return { value };

  const ui: McpUiToolMeta = { resourceUri };
  if (typeof slot === "string") ui.slot = slot as McpUiSlot;
  if (typeof height === "number" && Number.isFinite(height)) ui.height = height;
  if (typeof title === "string") ui.title = title;

  // Strip protocol metadata whether or not the card declaration passes, keeping model data consistent.
  const { _meta: _protocol, ...rest } = record;
  return { value: rest, ui };
}

export function pluginRuntimeToolDelegate(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  /** Only declared, servable UI URIs can trigger cards; absent declarations mean none. */
  declaredUiUris: ReadonlySet<string> = new Set(),
  generationId: string,
): PluginToolDelegate {
  return async (toolName, args): Promise<PluginToolOutcome> => {
    // Preserve the plugin handler contract: some plugins distinguish no payload
    // from an empty object.
    const finalPayload = Object.keys(args).length > 0 ? args : undefined;

    // Share runtime admission with UI resource reads; only the refusal shape differs.
    const refusal = checkRuntimeAdmission(pluginRuntime, pluginId);
    if (refusal === "inactive") {
      return errorOutcome(
        `Plugin '${pluginId}' is inactive; tool '${toolName}' is unavailable ` +
          `until the plugin is re-enabled.`,
      );
    }
    if (refusal === "integrity-disabled") {
      return errorOutcome(
        `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin ` +
          `to re-enable.`,
      );
    }

    try {
      const returned = await pluginRuntime.callForPlugin(
        pluginId,
        toolName,
        finalPayload,
        generationId,
      );
      const { value: result, ui } = splitPluginToolUiMeta(returned);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      const meta: Record<string, unknown> = { [RAW_RESULT_META]: result };
      if (ui) {
        // Undeclared cards have no reviewed policy and must not render.
        if (declaredUiUris.has(ui.resourceUri)) {
          meta.ui = ui;
        } else {
          log.warn(
            `plugin '${pluginId}' tool '${toolName}' requested ui resource '${ui.resourceUri}' ` +
              `which it did not declare in manifest.uiResources[] — no card rendered`,
          );
        }
      }
      return { content: [{ type: "text", text }], _meta: meta };
    } catch (err) {
      if (err instanceof ManifestIntegrityError) {
        let violationAuditError: unknown;
        try {
          await manifestIntegrityState.recordViolation(
            err.pluginId,
            err.toolName,
            err.attemptedMethod,
          );
        } catch (auditErr) {
          violationAuditError = auditErr;
        }
        return errorOutcome(
          violationAuditError
            ? `${err.message}\nManifest violation audit failed: ${errorMessage(violationAuditError)}`
            : err.message,
        );
      }
      return errorOutcome(errorMessage(err));
    }
  };
}
