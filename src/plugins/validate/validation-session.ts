/** Validation-only session binds real dispatch to scripted host answers and remains unreachable from app runtime. */
import type { PluginManifest, PluginRuntimeContext } from "../types.js";
import type { DelegatedWorkerConfinement } from "../isolation/host-api-dispatcher.js";
import type { ChildLink } from "../isolation/plugin-child-transport.js";
import {
  createBoundHostApiDispatchTable,
  type DispatchableHostApi,
} from "../isolation/bound-host-api-table.js";
import { connectionHostProtocol } from "../isolation/out-of-process-plugin.js";
import {
  openPluginProtocolSession,
  type PluginProtocolSession,
} from "../isolation/plugin-protocol-session.js";
import { resolvePluginSocketDir } from "../plugin-storage-layout.js";
import { validationConfinement, type ValidationHost } from "./validation-host.js";

export interface ValidationSessionInput {
  readonly manifest: PluginManifest;
  readonly host: ValidationHost;
  readonly link: ChildLink;
  readonly entryPath: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  /** Abort must tear down even during construct. */
  readonly signal?: AbortSignal;
}

/** Return the enforced envelope beside the session so reports can state its actual authority. */
export interface ValidationSession extends PluginProtocolSession {
  readonly confinement: DelegatedWorkerConfinement;
}

/** Construction and later pushes read the same validation host snapshots. */
function validationRuntimeContext(
  manifest: PluginManifest,
  host: ValidationHost,
  pluginRoot: string,
  pluginDataDir: string,
): PluginRuntimeContext {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(manifest.configSchema?.properties ?? {})) {
    const value = host.api.config.get(key);
    if (value !== undefined) config[key] = value;
  }
  return {
    pluginId: manifest.id,
    pluginRoot,
    hostRoot: host.roots.hostRoot,
    pluginDataDir,
    pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
    userHome: host.roots.userHome,
    aveHome: host.roots.aveHome,
    config,
    // Child logs cross notifications; the session does not invoke the context logger.
    log: () => undefined,
    hostApi: host.api,
  };
}

/** Refuse unsupported protocol before traffic, then bind only the validation host and base envelope. */
export async function openValidationSession(
  input: ValidationSessionInput,
): Promise<ValidationSession> {
  const hostProtocolVersion = connectionHostProtocol(input.manifest);
  const confinement = validationConfinement(input.manifest.id, input.pluginRoot, input.pluginDataDir);
  const table = createBoundHostApiDispatchTable(
    input.host.api as unknown as DispatchableHostApi,
    confinement,
  );
  const session = await openPluginProtocolSession({
    pluginId: input.manifest.id,
    manifest: input.manifest,
    hostProtocolVersion,
    link: input.link,
    context: validationRuntimeContext(input.manifest, input.host, input.pluginRoot, input.pluginDataDir),
    entryPath: input.entryPath,
    table,
    // The caller owns link/process cleanup; validation adds no per-child registrations.
    onClosed: async () => undefined,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { ...session, confinement };
}
