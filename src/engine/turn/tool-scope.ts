import type { ToolSchema } from "../llm/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import {
  EAGER_TOOL_EXPOSURE_CEILING,
  EAGER_TOOL_EXPOSURE_TOKEN_BUDGET,
} from "../../shared/tool-exposure-policy.js";
import { estimateTokens } from "../auto-compact.js";
import { createLogger } from "../../lib/logger.js";
import type { ConversationLoopDeps, ToolScope } from "./types.js";

const log = createLogger("ave");

function isBuiltinToolInventoryQuestion(input: string): boolean {
  const text = input.toLowerCase();
  const mentionsTool = /tool|툴|도구/.test(text);
  const mentionsBuiltin = /builtin|built-in|빌트인|내장|기본/.test(text);
  const mentionsNonBuiltin = /plugin|플러그인|mcp/.test(text);
  return mentionsTool && mentionsBuiltin && !mentionsNonBuiltin;
}

export function rebuildToolSchemas(toolRegistry: ToolRegistry, scope: ToolScope,
): ToolSchema[] {
    const raw = toolRegistry.getToolSchemasForScope(scope);
    const result: ToolSchema[] = [];
    for (const s of raw) {
      try {
        result.push({
          name: s.name,
          description: s.description,
          inputSchema: s.input_schema as ToolSchema["inputSchema"],
        });
      } catch (err) {
      log.warn(`rebuildToolSchemas: tool '${s.name}' schema conversion failed, skipping: %s`,
        err,
      );
    }
    }
    return result;
  }

export function resolveToolScope(
  input: string,
  deps: ConversationLoopDeps,
  state: {
    lastTurnScope: Set<string> | null;
    lastTurnToolNames: Set<string> | null;
    sessionActivatedPluginIds: Set<string>;
  },
): ToolScope {
    const resetCarryForward = isBuiltinToolInventoryQuestion(input);
    const activePluginIds = new Set(
    resetCarryForward ? new Set<string>() : (state.lastTurnScope ?? new Set<string>()),
  );
    for (const pluginId of deps.forcedActivePluginIds ?? []) {
      activePluginIds.add(pluginId);
    }
    const allowed = deps.allowedPluginIds;
    if (allowed) {
      const effectiveAllowed = new Set(allowed);
      for (const pluginId of deps.forcedActivePluginIds ?? []) {
        effectiveAllowed.add(pluginId);
      }
      for (const pluginId of [...activePluginIds]) {
        if (!effectiveAllowed.has(pluginId)) activePluginIds.delete(pluginId);
      }
    }

    // Disabled plugins stay loaded but leave model scope next turn; undefined enabled state remains active.
    const pluginRuntime = deps.pluginRuntime;
    if (pluginRuntime?.isPluginEnabled) {
      for (const pluginId of [...activePluginIds]) {
        // Session-activated plugins keep scope without persisting registry enabled state.
        if (
          !pluginRuntime.isPluginEnabled(pluginId) &&
          !state.sessionActivatedPluginIds.has(pluginId)
        ) {
          activePluginIds.delete(pluginId);
        }
      }
    }

    // Count only eligible plugin/MCP tools; expose eagerly below the ceiling and defer at or above it.
    const deferral = shouldDeferToolSchemas(deps, activePluginIds);

  // Restrict carried and explicit loaded names to tools whose owner plugin remains in scope.
  const activeToolNames = new Set<string>();
    const forcedToolNames = new Set<string>();
    const inScopeToolNames = scopedToolNameSet(deps, activePluginIds);
  for (const name of resetCarryForward ? [] : (state.lastTurnToolNames ?? [])) {
      if (inScopeToolNames.has(name)) activeToolNames.add(name);
    }
    // Forced names cannot expose tools excluded from the model-visible registry.
    const registeredToolNames = new Set(deps.toolRegistry.getModelVisibleTools().map((tool) => tool.name),
  );
    for (const name of deps.forcedActiveToolNames ?? []) {
      if (registeredToolNames.has(name)) {
        activeToolNames.add(name);
        forcedToolNames.add(name);
      }
    }

    return {
      activePluginIds,
      activeToolNames,
      forcedToolNames,
      includeBuiltins: true,
      includeMcp: deps.headless !== true,
      // Unattended input is untrusted and cannot access arbitrary-egress builtins.
      includeEgress: deps.headless !== true,
      deferral,
    };
  }

function scopedToolNameSet(deps: ConversationLoopDeps, activePluginIds: Set<string>,
): Set<string> {
    const includeMcp = deps.headless !== true;
    const names = new Set<string>();
  // Model-hidden app tools cannot count toward eager limits or become preloaded.
    for (const tool of deps.toolRegistry.getModelVisibleTools()) {
      if (tool.source === "plugin") {
        if (tool.pluginId && activePluginIds.has(tool.pluginId)) names.add(tool.name);
      } else if (tool.source === "mcp" && includeMcp) {
        names.add(tool.name);
      }
    }
    return names;
  }

export function shouldDeferToolSchemas(deps: ConversationLoopDeps, activePluginIds: Set<string>,
): boolean {
    const inScope = scopedToolNameSet(deps, activePluginIds);
    // Count limits prevent pathological eager catalogs even without token estimates.
    if (inScope.size >= EAGER_TOOL_EXPOSURE_CEILING) return true;
    if (inScope.size === 0) return false;
    // Below the count ceiling, defer if actual in-scope schema tokens exceed budget; exclude builtins.
    const schemas = deps.toolRegistry
      .getToolSchemas()
      .filter((entry) => inScope.has(entry.name));
    const estimatedTokens = estimateTokens(JSON.stringify({ tools: schemas }));
    return estimatedTokens >= EAGER_TOOL_EXPOSURE_TOKEN_BUDGET;
  }

export function filterAllowedPluginIds(deps: ConversationLoopDeps, pluginIds: string[],
): string[] {
    const allowed = deps.allowedPluginIds;
    if (!allowed) return pluginIds;
    const effectiveAllowed = new Set(allowed);
    for (const pluginId of deps.forcedActivePluginIds ?? []) {
      effectiveAllowed.add(pluginId);
    }
    return pluginIds.filter((id) => effectiveAllowed.has(id));
  }

export function nextCarryForwardToolNames(
  deps: ConversationLoopDeps,
    scope: ToolScope,
    toolCalls: Array<{ name: string }>,
  ): Set<string> {
    const inScopeToolNames = scopedToolNameSet(deps, scope.activePluginIds);
    const next = new Set<string>();

    for (const name of scope.forcedToolNames) {
      if (inScopeToolNames.has(name)) next.add(name);
    }
    for (const call of toolCalls) {
      if (inScopeToolNames.has(call.name)) next.add(call.name);
    }

    return next;
  }
