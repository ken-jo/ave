// Deny rules hide blocked tools; all model listings also exclude app-only tools.
// Keep app-only tools registered so card execution still traverses risk, approval, and audit.
import { isModelExposedTool, type Tool } from "./base.js";
import type { DenyRule } from "./types.js";
import { compareSemver } from "../shared/semver-compare.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tool-registry");

// Registry owns the stable search tool name; the conversation owns eager versus deferred exposure.
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export interface ToolSchemaEntry {
  name: string;
  description: string;
  input_schema: unknown;
  source: Tool["source"];
  category: Tool["category"];
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: Extract<Tool["source"], "plugin" | "mcp">;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
}

export interface PreparedMcpRegistryReplacement {
  readonly replacementTools: readonly Tool[];
  publish(): void;
  cancel(): void;
}

export interface PreparedPluginRegistryReplacement {
  readonly replacementTools: readonly Tool[];
  publish(): void;
  cancel(): void;
}

// Keep catalogue descriptions to the first sentence and about 100 characters.
function trimCatalogDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  const firstSentence = oneLine.split(/(?<=\.)\s/)[0] ?? oneLine;
  const candidate = firstSentence.length > 0 ? firstSentence : oneLine;
  return candidate.length > 100 ? `${candidate.slice(0, 97)}...` : candidate;
}

function schemaEntryForTool(tool: Tool, inputSchema: unknown): ToolSchemaEntry {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema,
    source: tool.source,
    category: tool.category,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    ...(tool.workerId ? { workerId: tool.workerId } : {}),
    ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
  };
}

function catalogEntryForTool(tool: Tool): ToolCatalogEntry | null {
  if (tool.source !== "plugin" && tool.source !== "mcp") return null;
  return {
    name: tool.name,
    description: trimCatalogDescription(tool.description),
    source: tool.source,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    ...(tool.workerId ? { workerId: tool.workerId } : {}),
    ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
  };
}

function toolOwnerKey(tool: Tool): string {
  if (tool.source === "builtin") return "builtin";
  if (tool.source === "plugin") {
    if (!tool.pluginId) {
      throw new Error(`Plugin tool '${tool.name}' is missing pluginId`);
    }
    return `plugin:${tool.pluginId}`;
  }
  if (tool.source === "mcp") {
    if (!tool.mcpServerId) {
      throw new Error(`MCP tool '${tool.name}' is missing mcpServerId`);
    }
    return `mcp:${tool.mcpServerId}`;
  }
  throw new Error(`Unsupported tool source for '${tool.name}': ${String(tool.source)}`);
}

function assertToolGovernanceShape(tool: Tool): void {
  const external = tool.source !== "builtin";
  const hasDecisionOverride = tool.decisionOverride !== undefined;
  const hasDynamicCategory = tool.categoryForInput !== undefined;

  if (external && tool.category === "meta") {
    throw new Error(`External tool '${tool.name}' cannot declare the host-only meta category`);
  }
  if (external && hasDecisionOverride) {
    throw new Error(`External tool '${tool.name}' cannot declare decisionOverride`);
  }
  if (external && hasDynamicCategory) {
    throw new Error(`External tool '${tool.name}' cannot declare categoryForInput`);
  }
  if (tool.category === "meta") {
    if (hasDynamicCategory) {
      throw new Error(`Meta tool '${tool.name}' cannot declare categoryForInput`);
    }
    if (
      tool.decisionOverride !== "ask" &&
      tool.decisionOverride !== "always-allow-with-audit"
    ) {
      throw new Error(
        `Builtin meta tool '${tool.name}' requires a supported decisionOverride`,
      );
    }
    return;
  }
  if (hasDecisionOverride) {
    throw new Error(`Non-meta builtin tool '${tool.name}' cannot declare decisionOverride`);
  }
}

export class ToolRegistry {
  // Cache the owner's semver-latest tool by name.
  private tools = new Map<string, Tool>();
  // Retain every registered version for pinned lookups while model listings use the latest.
  private versioned = new Map<string, Map<string, Tool>>();
  private denyRules: DenyRule[] = [];
  private generation = 0;
  private readonly reservedMcpToolNames = new Map<string, symbol>();
  private readonly reservedPluginOwners = new Map<string, symbol>();
  private readonly reservedMcpOwners = new Map<string, symbol>();

  constructor(private readonly parentGeneration?: () => string) {}

  // Reject duplicate name/version pairs; alternate versions must share an owner and cannot override another source.
  register(tool: Tool): void {
    if (this.reservedMcpToolNames.has(tool.name)) {
      throw new Error(`Tool name is reserved by an MCP generation transition: ${tool.name}`);
    }
    if (tool.pluginId && this.reservedPluginOwners.has(tool.pluginId)) {
      throw new Error(`Plugin tool owner is reserved by a generation transition: ${tool.pluginId}`);
    }
    if (tool.mcpServerId && this.reservedMcpOwners.has(tool.mcpServerId)) {
      throw new Error(`MCP tool owner is reserved by a generation transition: ${tool.mcpServerId}`);
    }
    const versionMap = this.addToVersioned(this.versioned, tool);
    this.tools.set(tool.name, this.pickLatest(versionMap));
    this.generation += 1;
  }

  registerBatch(tools: Tool[]): void {
    for (const tool of tools) assertToolGovernanceShape(tool);
    for (const tool of tools) this.register(tool);
  }

  unregisterByPlugin(pluginId: string): void {
    this.replacePluginTools([pluginId], []);
  }

  listPluginIds(): string[] {
    const ids = new Set<string>();
    for (const versionMap of this.versioned.values()) {
      for (const tool of versionMap.values()) {
        if (tool.source === "plugin" && tool.pluginId) ids.add(tool.pluginId);
      }
    }
    return [...ids];
  }

  // Validate replacements on cloned indexes so failures leave the live registry unchanged.
  replacePluginTools(pluginIds: Iterable<string>, replacementTools: Tool[]): void {
    const targetPluginIds = new Set([...pluginIds].filter((id) => id.length > 0));
    for (const pluginId of targetPluginIds) {
      if (this.reservedPluginOwners.has(pluginId)) {
        throw new Error(`Plugin tool owner is reserved by a generation transition: ${pluginId}`);
      }
    }
    if (targetPluginIds.size === 0) {
      if (replacementTools.length > 0) {
        throw new Error("replacePluginTools requires pluginIds for replacement tools");
      }
      return;
    }

    for (const tool of replacementTools) {
      if (tool.source !== "plugin" || !tool.pluginId) {
        throw new Error(`replacePluginTools expected plugin-sourced tool: ${tool.name}`);
      }
      if (this.reservedMcpToolNames.has(tool.name)) {
        throw new Error(`Tool name is reserved by a generation transition: ${tool.name}`);
      }
      if (!targetPluginIds.has(tool.pluginId)) {
        throw new Error(
          `replacePluginTools received tool '${tool.name}' for plugin '${tool.pluginId}' outside target set`,
        );
      }
    }

    const nextVersioned = this.cloneVersioned();
    for (const [name, versionMap] of nextVersioned) {
      for (const [version, tool] of versionMap) {
        if (tool.source === "plugin" && tool.pluginId && targetPluginIds.has(tool.pluginId)) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) nextVersioned.delete(name);
    }

    for (const tool of replacementTools) {
      this.addToVersioned(nextVersioned, tool);
    }
    const nextTools = this.buildLatestMap(nextVersioned);

    this.versioned.clear();
    for (const [name, versionMap] of nextVersioned) {
      this.versioned.set(name, versionMap);
    }
    this.tools.clear();
    for (const [name, tool] of nextTools) {
      this.tools.set(name, tool);
    }
    this.generation += 1;
  }

  // Remove all tools for a server when its kill switch fires (tool-governance.md).
  unregisterByMcp(mcpServerId: string): void {
    if (this.reservedMcpOwners.has(mcpServerId)) {
      throw new Error(`MCP tool owner is reserved by a generation transition: ${mcpServerId}`);
    }
    let changed = false;
    for (const [name, versionMap] of this.versioned) {
      for (const [version, tool] of versionMap) {
        if (tool.mcpServerId === mcpServerId) {
          versionMap.delete(version);
          changed = true;
        }
      }
      this.syncLatest(name, versionMap);
    }
    if (changed) this.generation += 1;
  }

  // Reserve exact owner replacements before publishing one synchronous map swap, preventing name races.
  reserveMcpReplacement(
    predecessorServerIds: Iterable<string>,
    replacementTools: readonly Tool[],
  ): PreparedMcpRegistryReplacement {
    const predecessors = new Set(predecessorServerIds);
    const names = new Set(replacementTools.map((tool) => tool.name));
    for (const tool of replacementTools) {
      if (tool.source !== "mcp" || !tool.mcpServerId) {
        throw new Error(`MCP replacement expected an MCP-owned tool: ${tool.name}`);
      }
    }
    const replacementOwners = new Set(replacementTools.map((tool) => tool.mcpServerId!));
    const reservedOwners = new Set([...predecessors, ...replacementOwners]);
    for (const owner of reservedOwners) {
      if (this.reservedMcpOwners.has(owner)) {
        throw new Error(`MCP tool owner is already reserved: ${owner}`);
      }
    }
    const affectedNames = new Set(names);
    for (const [name, versionMap] of this.versioned) {
      if ([...versionMap.values()].some((tool) =>
        tool.source === "mcp" && tool.mcpServerId && predecessors.has(tool.mcpServerId)
      )) {
        affectedNames.add(name);
      }
    }
    for (const name of affectedNames) {
      if (this.reservedMcpToolNames.has(name)) {
        throw new Error(`MCP replacement tool name is already reserved: ${name}`);
      }
    }
    const validate = this.cloneVersioned();
    this.removeMcpOwners(validate, predecessors);
    for (const tool of replacementTools) this.addToVersioned(validate, tool);
    const nextTools = this.buildLatestMap(validate);
    const token = Symbol("mcp-generation-replacement");
    for (const name of affectedNames) this.reservedMcpToolNames.set(name, token);
    for (const owner of reservedOwners) this.reservedMcpOwners.set(owner, token);

    let settled = false;
    const releaseReservations = () => {
      for (const name of affectedNames) {
        if (this.reservedMcpToolNames.get(name) === token) this.reservedMcpToolNames.delete(name);
      }
      for (const owner of reservedOwners) {
        if (this.reservedMcpOwners.get(owner) === token) this.reservedMcpOwners.delete(owner);
      }
    };
    return Object.freeze({
      replacementTools: Object.freeze([...replacementTools]),
      publish: () => {
        if (settled) return;
        this.publishPreparedNames(validate, nextTools, affectedNames);
        this.generation += 1;
        settled = true;
        releaseReservations();
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        releaseReservations();
      },
    });
  }

  /** Reserve a plugin replacement, including runtime methods omitted from discovery. */
  reservePluginReplacement(
    pluginId: string,
    replacementTools: readonly Tool[],
    predecessorMcpServerIds: Iterable<string> = [],
    runtimeMethodNames: Iterable<string> = [],
  ): PreparedPluginRegistryReplacement {
    if (!pluginId) throw new Error("Plugin registry replacement requires pluginId");
    if (this.reservedPluginOwners.has(pluginId)) {
      throw new Error(`Plugin tool owner is already reserved: ${pluginId}`);
    }
    for (const tool of replacementTools) {
      if (tool.source !== "plugin" || tool.pluginId !== pluginId) {
        throw new Error(`Plugin replacement expected '${pluginId}' tool: ${tool.name}`);
      }
    }
    const mcpPredecessors = new Set(predecessorMcpServerIds);
    const affectedNames = new Set(replacementTools.map((tool) => tool.name));
    for (const [name, versionMap] of this.versioned) {
      if ([...versionMap.values()].some((tool) =>
        (tool.source === "plugin" && tool.pluginId === pluginId) ||
        (tool.mcpServerId !== undefined && mcpPredecessors.has(tool.mcpServerId))
      )) {
        affectedNames.add(name);
      }
    }
    const reservedNames = new Set([...affectedNames, ...runtimeMethodNames]);
    const nextVersioned = this.cloneVersioned();
    for (const [name, versionMap] of nextVersioned) {
      for (const [version, tool] of versionMap) {
        if (
          (tool.source === "plugin" && tool.pluginId === pluginId) ||
          (tool.mcpServerId !== undefined && mcpPredecessors.has(tool.mcpServerId))
        ) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) nextVersioned.delete(name);
    }
    for (const tool of replacementTools) this.addToVersioned(nextVersioned, tool);
    const nextTools = this.buildLatestMap(nextVersioned);
    const token = Symbol("plugin-generation-replacement");
    for (const owner of mcpPredecessors) {
      if (this.reservedMcpOwners.has(owner)) {
        throw new Error(`MCP tool owner is already reserved: ${owner}`);
      }
    }
    for (const name of reservedNames) {
      if (this.reservedMcpToolNames.has(name)) {
        throw new Error(`Tool name is already reserved: ${name}`);
      }
    }
    this.reservedPluginOwners.set(pluginId, token);
    for (const owner of mcpPredecessors) this.reservedMcpOwners.set(owner, token);
    for (const name of reservedNames) this.reservedMcpToolNames.set(name, token);
    let settled = false;
    const release = () => {
      if (this.reservedPluginOwners.get(pluginId) === token) this.reservedPluginOwners.delete(pluginId);
      for (const owner of mcpPredecessors) {
        if (this.reservedMcpOwners.get(owner) === token) this.reservedMcpOwners.delete(owner);
      }
      for (const name of reservedNames) {
        if (this.reservedMcpToolNames.get(name) === token) this.reservedMcpToolNames.delete(name);
      }
    };
    return Object.freeze({
      replacementTools: Object.freeze([...replacementTools]),
      publish: () => {
        if (settled) return;
        this.publishPreparedNames(nextVersioned, nextTools, affectedNames);
        this.generation += 1;
        settled = true;
        release();
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        release();
      },
    });
  }

  findByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  findByNameVersion(name: string, version: string): Tool | undefined {
    return this.versioned.get(name)?.get(version);
  }

  listVersions(name: string): Tool[] {
    const map = this.versioned.get(name);
    if (!map) return [];
    return [...map.values()].sort((a, b) =>
      compareSemver(a.version, b.version),
    );
  }

  listAll(): Tool[] {
    return [...this.tools.values()];
  }

  // Executable non-denied tools include app-only tools; model visibility is a narrower surface.
  getVisibleTools(): Tool[] {
    return this.listAll().filter((tool) => !this.isDenied(tool.name));
  }

  // Apply deny and modelVisible filters here for every model listing across plugin and external sources.
  // Lookup still resolves app-only tools for governed card execution.
  getModelVisibleTools(): Tool[] {
    return this.getVisibleTools().filter(isModelExposedTool);
  }

  getToolSchemas(): ToolSchemaEntry[] {
    return this.getModelVisibleTools().map((tool) =>
      schemaEntryForTool(tool, tool.toJsonSchema()),
    );
  }

  // Apply deny and model-visibility before scope; promote eligible plugin/external schemas only by activeToolNames.
  getToolSchemasForScope(scope: {
    activePluginIds: Set<string> | string[];
    activeToolNames?: Set<string> | string[];
    includeBuiltins: boolean;
    includeMcp: boolean;
    includeEgress: boolean;
    deferral?: boolean;
  }): ToolSchemaEntry[] {
    const active = scope.activePluginIds instanceof Set
      ? scope.activePluginIds
      : new Set(scope.activePluginIds);
    const activeNames = scope.activeToolNames instanceof Set
      ? scope.activeToolNames
      : new Set(scope.activeToolNames ?? []);

    // Below the exposure ceiling, load all in-scope schemas; otherwise defer unpromoted tools to the catalogue.
    const deferral = scope.deferral !== false;

    return this.getModelVisibleTools()
      .filter((tool) => {
        if (tool.source === "builtin") {
          // Builtins are eager and do not count toward the exposure ceiling.
          if (!scope.includeBuiltins) return false;
          // Server-data builtins must honor includeMcp so builtin identity cannot bypass headless restrictions.
          if (tool.requiresMcpScope && !scope.includeMcp) return false;
          // Withhold egress schemas at registry scope to resist tool requests from injected content.
          if (tool.arbitraryEgress && !scope.includeEgress) return false;
          return true;
        }
        if (tool.source === "mcp") {
          if (!scope.includeMcp) return false;
          return deferral ? activeNames.has(tool.name) : true;
        }
        if (tool.source === "plugin") {
          // Missing plugin identity must exclude the tool rather than expose it with builtin authority.
          if (!tool.pluginId) {
            log.warn(`plugin tool '${tool.name}' missing pluginId — skipped in scope filter`);
            return false;
          }
          if (!active.has(tool.pluginId)) return false;
          return deferral ? activeNames.has(tool.name) : true;
        }
        // Unknown source kinds fail closed out of scope.
        return false;
      })
      .map((tool) => {
        // Warn and drop malformed schemas without failing the whole turn's tool scope.
        try {
          return schemaEntryForTool(tool, tool.toJsonSchema());
        } catch (err) {
          log.warn(`toJsonSchema failed for '${tool.name}': %s`, (err as Error).message);
          return null;
        }
      })
      .filter((entry): entry is ToolSchemaEntry => entry !== null);
  }

  // Catalogue only in-scope, unloaded plugin/external tools after deny and model-visibility filtering.
  // Loaded tools and builtins must never appear as deferred promotion candidates.
  getToolCatalogForScope(scope: {
    activePluginIds: Set<string> | string[];
    activeToolNames?: Set<string> | string[];
    includeMcp: boolean;
    deferral?: boolean;
  }): ToolCatalogEntry[] {
    // Eager exposure leaves no deferred catalogue entries.
    if (scope.deferral === false) return [];

    const active = scope.activePluginIds instanceof Set
      ? scope.activePluginIds
      : new Set(scope.activePluginIds);
    const activeNames = scope.activeToolNames instanceof Set
      ? scope.activeToolNames
      : new Set(scope.activeToolNames ?? []);

    return this.getModelVisibleTools()
      .filter((tool) => {
        if (activeNames.has(tool.name)) return false;
        if (tool.source === "mcp") return scope.includeMcp;
        if (tool.source === "plugin") {
          if (!tool.pluginId) return false;
          return active.has(tool.pluginId);
        }
        return false;
      })
      .map((tool) => catalogEntryForTool(tool))
      .filter((entry): entry is ToolCatalogEntry => entry !== null);
  }

  setDenyRules(rules: DenyRule[]): void {
    this.denyRules = [...rules];
    this.generation += 1;
  }

  /** Monotonic host identity used to invalidate sealed rationale actions. */
  getGeneration(): string {
    const local = String(this.generation);
    return this.parentGeneration ? `${this.parentGeneration()}:${local}` : local;
  }

  get size(): number {
    return this.tools.size;
  }

  // Restrict sub-agent tools to named entries; deny rules are not inherited because the caller controls exposure.
  createScopedView(allowedNames: Set<string> | string[]): ToolRegistry {
    const allowed = new Set(allowedNames);
    const scoped = new ToolRegistry(() => this.getGeneration());
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) scoped.register(tool);
    }
    return scoped;
  }

  private pickLatest(versionMap: Map<string, Tool>): Tool {
    return [...versionMap.values()].reduce((best, cur) =>
      compareSemver(cur.version, best.version) > 0 ? cur : best,
    );
  }

  private cloneVersioned(): Map<string, Map<string, Tool>> {
    const clone = new Map<string, Map<string, Tool>>();
    for (const [name, versionMap] of this.versioned) {
      clone.set(name, new Map(versionMap));
    }
    return clone;
  }

  private removeMcpOwners(
    index: Map<string, Map<string, Tool>>,
    serverIds: ReadonlySet<string>,
  ): void {
    for (const [name, versionMap] of index) {
      for (const [version, tool] of versionMap) {
        if (tool.source === "mcp" && tool.mcpServerId && serverIds.has(tool.mcpServerId)) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) index.delete(name);
    }
  }

  private addToVersioned(index: Map<string, Map<string, Tool>>, tool: Tool): Map<string, Tool> {
    assertToolGovernanceShape(tool);
    const versionMap = index.get(tool.name) ?? new Map<string, Tool>();
    this.assertNameOwnerCompatible(versionMap, tool);
    if (versionMap.has(tool.version)) {
      throw new Error(`Tool already registered: ${tool.name}@${tool.version}`);
    }
    versionMap.set(tool.version, tool);
    index.set(tool.name, versionMap);
    return versionMap;
  }

  private buildLatestMap(index: Map<string, Map<string, Tool>>): Map<string, Tool> {
    const latest = new Map<string, Tool>();
    for (const [name, versionMap] of index) {
      if (versionMap.size > 0) latest.set(name, this.pickLatest(versionMap));
    }
    return latest;
  }

  /** Publish only prevalidated entries; unrelated registrations remain intact. */
  private publishPreparedNames(
    nextVersioned: ReadonlyMap<string, Map<string, Tool>>,
    nextTools: ReadonlyMap<string, Tool>,
    affectedNames: ReadonlySet<string>,
  ): void {
    for (const name of affectedNames) {
      const versions = nextVersioned.get(name);
      if (versions) this.versioned.set(name, versions);
      else this.versioned.delete(name);
      const latest = nextTools.get(name);
      if (latest) this.tools.set(name, latest);
      else this.tools.delete(name);
    }
  }

  private syncLatest(name: string, versionMap: Map<string, Tool>): void {
    if (versionMap.size === 0) {
      this.tools.delete(name);
      this.versioned.delete(name);
      return;
    }
    this.tools.set(name, this.pickLatest(versionMap));
  }

  private assertNameOwnerCompatible(versionMap: Map<string, Tool>, tool: Tool): void {
    const nextOwner = toolOwnerKey(tool);
    for (const existing of versionMap.values()) {
      const existingOwner = toolOwnerKey(existing);
      if (existingOwner !== nextOwner) {
        throw new Error(
          `Tool name collision: '${tool.name}' already owned by ${existingOwner}; cannot register ${nextOwner}`,
        );
      }
    }
  }

  private isDenied(name: string): boolean {
    return this.denyRules.some((rule) =>
      this.matchPattern(rule.pattern, name),
    );
  }

  private matchPattern(pattern: string, name: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  }
}
