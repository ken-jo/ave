/**
 * The validation-only entry to the plugin protocol
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * It opens the production protocol session over a link the CALLER owns — the
 * validator's own child, or a pair of in-memory streams in a conformance
 * suite — against the validation host, with the base envelope as its
 * authority. It spawns nothing and confines nothing: the production factory is
 * the only place a confined child is spawned, and this is the only other
 * caller of `openPluginProtocolSession` among production modules. Nothing the
 * runtime, the boot sequence or the main process loads imports this directory
 * (`validate-boundary.test.ts`).
 */
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
  /** The child, on a link the caller spawned or paired and still owns. */
  readonly link: ChildLink;
  /** The resolved, real entry path of the plugin the child imports. */
  readonly entryPath: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  /** Tears the session down at any point, construct included. */
  readonly signal?: AbortSignal;
}

/**
 * The whole protocol session — channel and `teardown` included — plus the
 * envelope its table was bound to, so a report can say what was enforced.
 */
export interface ValidationSession extends PluginProtocolSession {
  readonly confinement: DelegatedWorkerConfinement;
}

/**
 * The context a validated plugin is constructed with: its own two roots, the
 * validation host's fixed roots, and the config the host resolves for the
 * keys its manifest declares — read from the same host the later snapshots
 * are read from, so construction and re-push agree.
 */
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
    // The out-of-process session never calls the context's logger: the
    // child's own log lines cross as notifications and reach the transport.
    log: () => undefined,
    hostApi: host.api,
  };
}

/**
 * Open a validation session: refuse an undeclared or unserved protocol before
 * any frame is written, bind the real dispatch table to the validation host
 * under the base envelope, and construct the plugin over the caller's link.
 */
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
    // The caller owns the link and whatever process is behind it, and the
    // validation host registers nothing per child, so there is nothing of the
    // session's own to clean up.
    onClosed: async () => undefined,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { ...session, confinement };
}
