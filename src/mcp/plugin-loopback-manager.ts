/** Prepare hidden plugin hosts, publish with the shared generation and retire only after leases drain.
 * Natural-name tool calls retain plugin authority and the exact published generation. */
import { ToolRegistry, type PreparedPluginRegistryReplacement } from "../tools/registry.js";
import { PluginMcpHost } from "./plugin-mcp-host.js";
import { pluginRuntimeToolDelegate } from "./plugin-runtime-delegate.js";
import {
  createPluginUiResourceProvider,
  type PluginUiResourceProvider,
} from "./plugin-ui-resource-provider.js";
import { createMcpServerDisconnectedSink } from "./mcp-server-disconnect-sink.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginManifest } from "../plugins/types.js";
import type { McpUiResourceRead } from "./types.js";
import type { Tool } from "../tools/base.js";

export interface PreparedPluginLoopbackGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  readonly host?: PluginMcpHost;
  readonly tools: readonly Tool[];
  readonly registryReplacement: PreparedPluginRegistryReplacement;
  published: boolean;
  disconnectPredecessor: boolean;
  predecessorGenerationId?: string;
}

export class PluginLoopbackManager {
  private readonly hosts = new Map<string, PluginMcpHost>();
  private readonly hostGenerations = new Map<string, string>();
  private readonly retiredHosts = new Map<
    string,
    { host: PluginMcpHost; emitDisconnect: boolean }
  >();

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly toolRegistry: ToolRegistry,
    /** Default retirement notifications keep plugin card teardown aligned with external server teardown. */
    private readonly onServerDisconnected: (serverId: string) => void =
      createMcpServerDisconnectedSink(),
  ) {}

  private retirementKey(pluginId: string, generationId: string): string {
    return `${pluginId}\0${generationId}`;
  }

  async prepareGeneration(
    manifest: PluginManifest,
    generationId: string,
    predecessorMcpServerIds: readonly string[] = [],
  ): Promise<PreparedPluginLoopbackGeneration> {
    const uiResources = this.buildUiResourceProvider(manifest, generationId);
    const declaredUiUris = new Set(uiResources?.list().map((resource) => resource.uri) ?? []);
    const host = PluginMcpHost.loopback(
      manifest,
      pluginRuntimeToolDelegate(this.runtime, manifest.id, declaredUiUris, generationId),
      uiResources,
      generationId,
    );
    try {
      const tools = await host.prepareTools();
      return {
        pluginId: manifest.id,
        generationId,
        host,
        tools,
        registryReplacement: this.toolRegistry.reservePluginReplacement(
          manifest.id,
          tools,
          predecessorMcpServerIds,
          manifest.tools.map((tool) => tool.name),
        ),
        published: false,
        disconnectPredecessor: false,
      };
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  prepareRemoval(
    pluginId: string,
    generationId: string,
    predecessorMcpServerIds: readonly string[] = [],
  ): PreparedPluginLoopbackGeneration {
    return {
      pluginId,
      generationId,
      tools: Object.freeze([]),
      registryReplacement: this.toolRegistry.reservePluginReplacement(
        pluginId,
        [],
        predecessorMcpServerIds,
      ),
      published: false,
      disconnectPredecessor: false,
    };
  }

  /** Publication performs prebuilt assignments only and must not throw. */
  publishGeneration(prepared: PreparedPluginLoopbackGeneration): void {
    if (prepared.published) return;
    const previous = this.hosts.get(prepared.pluginId);
    const previousGeneration = this.hostGenerations.get(prepared.pluginId);
    prepared.registryReplacement.publish();
    if (previous && previousGeneration && previous !== prepared.host) {
      this.retiredHosts.set(
        this.retirementKey(prepared.pluginId, previousGeneration),
        { host: previous, emitDisconnect: prepared.host === undefined },
      );
      prepared.disconnectPredecessor = prepared.host === undefined;
      prepared.predecessorGenerationId = previousGeneration;
    }
    if (prepared.host) {
      prepared.host.publishPrepared(prepared.tools);
      this.hosts.set(prepared.pluginId, prepared.host);
      this.hostGenerations.set(prepared.pluginId, prepared.generationId);
    } else {
      this.hosts.delete(prepared.pluginId);
      this.hostGenerations.delete(prepared.pluginId);
    }
    prepared.published = true;
  }

  /** Retire stale cards immediately after the atomic generation switch. */
  postPublishGeneration(prepared: PreparedPluginLoopbackGeneration): void {
    if (!prepared.published || !prepared.disconnectPredecessor) return;
    prepared.disconnectPredecessor = false;
    this.onServerDisconnected(prepared.pluginId);
    const predecessorGenerationId = prepared.predecessorGenerationId;
    const retired = predecessorGenerationId
      ? this.retiredHosts.get(this.retirementKey(prepared.pluginId, predecessorGenerationId))
      : undefined;
    if (retired) retired.emitDisconnect = false;
  }

  async discardGeneration(prepared: PreparedPluginLoopbackGeneration): Promise<void> {
    if (prepared.published) return;
    prepared.registryReplacement.cancel();
    await prepared.host?.dispose();
  }

  async retireGeneration(pluginId: string, generationId: string): Promise<void> {
    const key = this.retirementKey(pluginId, generationId);
    const retired = this.retiredHosts.get(key);
    if (!retired) return;
    this.retiredHosts.delete(key);
    await retired.host.dispose();
    if (retired.emitDisconnect) this.onServerDisconnected(pluginId);
  }

  /** Serve only this plugin declared UI resources; unknown, undeclared or cross-namespace reads throw. */
  async readUiResource(pluginId: string, uri: string): Promise<McpUiResourceRead> {
    const host = this.hosts.get(pluginId);
    if (!host) {
      throw new Error(`[plugin-loopback] no running loopback host for plugin '${pluginId}'`);
    }
    return host.readUiResource(uri);
  }

  /** Fail closed when a loopback card is not bound to the currently published generation. */
  assertCardGeneration(pluginId: string, generationId: string): void {
    const activeGenerationId = this.hostGenerations.get(pluginId);
    if (!activeGenerationId) {
      throw new Error(`[plugin-loopback] no running loopback host for plugin '${pluginId}'`);
    }
    if (generationId !== activeGenerationId) {
      throw new Error(`[plugin-loopback] stale card generation for plugin '${pluginId}'`);
    }
  }

  /** Manifest declarations supply policy; the bounded plugin hook supplies content after namespace checks. */
  private buildUiResourceProvider(
    manifest: PluginManifest,
    generationId: string,
  ): PluginUiResourceProvider | undefined {
    const declarations = manifest.uiResources;
    if (!declarations || declarations.length === 0) return undefined;
    return createPluginUiResourceProvider({
      pluginId: manifest.id,
      declarations,
      readHtml: (uri) => this.runtime.readUiResource(
        manifest.id,
        uri,
        undefined,
        generationId,
      ),
    });
  }

  has(pluginId: string): boolean {
    return this.hosts.has(pluginId);
  }

  list(): string[] {
    return [...this.hosts.keys()];
  }
}
