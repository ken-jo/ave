import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PluginHostApi, PluginManifest } from "../types.js";
import { createPluginStorage } from "../storage.js";
import { createNodeSecretEncryption } from "../../data/node-secret-encryption.js";
import type { SecretEncryption } from "../../data/secret-document-store.js";
import { applyConfigDefaults } from "../config-schema.js";
import { createLogger } from "../../lib/logger.js";
import { aveHome } from "../../shared/ave-home.js";
import {
  PLUGIN_DATA_DIR_NAME,
  hostStorageMigrationFailureFor,
  resolvePluginHostStorageDir,
  resolvePluginSocketDir,
} from "../plugin-storage-layout.js";
import { resolvePluginDataRoot } from "../plugin-storage-containment.js";
const log = createLogger("sandbox");

/** App visibility is an allowlist, not risk classification; model tools still require executor permission and audit. */

/** Reject absolute and traversing entry paths before loading plugin code. */
export function resolvePluginEntryPath(pluginRoot: string, entry: string,
): string {
  if (isAbsolute(entry)) {
    throw new Error(
      `Plugin entry must be a relative path inside the plugin directory, got absolute: ${entry}`,
    );
  }
  const pluginRootResolved = resolve(pluginRoot);
  const resolved = resolve(pluginRootResolved, entry);
  if (resolved !== pluginRootResolved) {
    const rel = relative(pluginRootResolved, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Plugin entry '${entry}' resolves outside plugin directory (${pluginRootResolved})`,
      );
    }
  }
  return resolved;
}

/** Every install source requires containment; installSource does not relax the path boundary. */
export function resolveEntryPath(
  pluginRoot: string,
  entry: string,
  _hostRoot: string,
): string {
  return resolvePluginEntryPath(pluginRoot, entry);
}

/** Canonicalize symlinks and Windows short names before forming import URLs; retain the original on resolution failure. */
export function resolveRealEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

/** Resolve without creating on per-request paths; mkdir during a swap can invent conflicting state. */
export function resolvePluginDataDir(
  pluginId: string,
  pluginRoot: string,
  pluginsRoot: string | undefined,
): string {
  const baseRoot = pluginsRoot ?? dirname(pluginRoot);
  return resolve(baseRoot, pluginId, PLUGIN_DATA_DIR_NAME);
}

/** Create storage only for fresh state; existing data without storage requires boot migration rather than empty replacement. */
function ensurePluginHostStorageDir(pluginId: string, dataDir: string, dataCreated: boolean): void {
  const storageDir = resolvePluginHostStorageDir(dataDir);
  try {
    resolvePluginDataRoot(`plugin '${pluginId}'`, storageDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!dataCreated && readdirSync(dataDir).length > 0) {
    const failure = hostStorageMigrationFailureFor(dataDir);
    throw new Error(
      `[plugin '${pluginId}'] ${storageDir} is missing while ${dataDir} holds state; `
        + (failure !== undefined
          ? `the boot migration that creates it failed for ${dirname(dataDir)}: ${failure} — `
            + "fix that and restart the app to retry"
          : "the boot migration creates it from that state — restart the app to migrate"),
    );
  }
  mkdirSync(storageDir, { mode: 0o700 });
}

/** Provision data, socket and host-only storage directories together at load. */
export function ensurePluginDataDir(
  pluginId: string,
  pluginRoot: string,
  pluginsRoot: string | undefined,
): string {
  const dataDir = resolvePluginDataDir(pluginId, pluginRoot, pluginsRoot);
  // Verify an existing root itself; recursive mkdir accepts symlinks and cannot establish identity.
  let dataCreated = false;
  try {
    resolvePluginDataRoot(`plugin '${pluginId}'`, dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dataDir, { recursive: true });
    dataCreated = true;
  }
  ensurePluginHostStorageDir(pluginId, dataDir, dataCreated);
  // Provision sockets at load so all execution arms receive the same layout.
  mkdirSync(resolvePluginSocketDir(dataDir), { recursive: true, mode: 0o700 });
  return dataDir;
}

/** Tests must inject the inert HostApi explicitly; storage still uses real guarded operations. */
export function createNoopHostApi(
  pluginId: string,
  pluginDataDir: string,
  encryption: SecretEncryption,
): PluginHostApi {
  return {
    storage: createPluginStorage(pluginId, resolvePluginHostStorageDir(pluginDataDir), encryption),
    config: {
      get: () => undefined,
      set: async () => {
        throw new Error("config.set not available in noop context");
      },
      onChange: () => () => {},
    },
    emitEvent: () => {},
    onEvent: () => () => {},
    getInstalledPluginIds: () => [],
    onPluginsChanged: () => () => {},
    getSecret: async () => null,
    callLlm: async () => {
      throw new Error("LLM not available in noop context");
    },
    logEvent: () => {},
    onShutdown: () => {},
    openExternalUrl: async () => {
      throw new Error("openExternalUrl not available in noop context");
    },
    // The inert private-network probe returns false without disrupting caller flow.
    probePrivateHost: async () => false,
    authRedirect: {
      open: async () => {
        throw new Error("authRedirect.open not available in noop context");
      },
      wait: async () => {
        throw new Error("authRedirect.wait not available in noop context");
      },
      close: async () => {
        throw new Error("authRedirect.close not available in noop context");
      },
    },
    pickFolders: async () => {
      throw new Error("pickFolders not available in noop context");
    },
    listAudioInputDevices: async () => {
      throw new Error("listAudioInputDevices not available in noop context");
    },
    startAudioCapture: async () => {
      throw new Error("startAudioCapture not available in noop context");
    },
    attachFloatingPanel: async () => {
      throw new Error("attachFloatingPanel not available in noop context");
    },
    resizeFloatingPanel: async () => {
      throw new Error("resizeFloatingPanel not available in noop context");
    },
    resolveMappedDriveRoot: async () => {
      throw new Error("resolveMappedDriveRoot not available in noop context");
    },
    openAuthWindow: async () => {
      throw new Error("openAuthWindow not available in noop context");
    },
    openAuthPartitionViewer: async () => {
      throw new Error("openAuthPartitionViewer not available in noop context");
    },
    getAuthPartitionCookies: async () => [],
    clearAuthPartition: async () => {
      throw new Error("clearAuthPartition not available in noop context");
    },
    triggerConversation: async (spec) => ({
      accepted: false,
      reason: "loop_unavailable",
      source: typeof spec?.source === "string" ? spec.source : "",
    }),
    hasRoutineBySource: async () => false,
    // Without a board, return the ordinary proposal refusal status rather than throw.
    proposeWork: async (input) => ({ status: "kind_not_granted", kind: input.kind }),
    withdrawWorkProposal: async () => false,
    raiseAlert: async (input) => ({ status: "kind_not_granted", kind: input.kind }),
    withdrawAlert: async () => false,
    agentApproval: {
      request: async () => "deny-once" as const,
      respond: async () => {},
    },
  };
}

export function createNoopHostApiForTests(
  pluginId: string,
  _manifest: PluginManifest,
  pluginDataDir: string,
): PluginHostApi {
  return createNoopHostApi(pluginId, pluginDataDir, createNodeSecretEncryption());
}

export function buildPluginContext(opts: {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  pluginDataDir: string;
  manifest: Pick<PluginManifest, "config" | "configSchema">;
  configOverrides: Record<string, Record<string, unknown>>;
  hostApi: PluginHostApi;
}) {
  return {
    pluginId: opts.pluginId,
    pluginRoot: opts.pluginRoot,
    hostRoot: opts.hostRoot,
    pluginDataDir: opts.pluginDataDir,
    // Build context paths without creating them; only load provisioning owns filesystem mutation.
    pluginSocketDir: resolvePluginSocketDir(opts.pluginDataDir),
    // Read real user/home paths in the host; a confined child would derive throwaway values.
    userHome: homedir(),
    aveHome: aveHome(),
    // Apply precedence: saved plugin values, host wildcard, manifest config, schema defaults.
    config: applyConfigDefaults(opts.manifest.configSchema, {
      ...(opts.manifest.config ?? {}),
      ...(opts.configOverrides["*"] ?? {}),
      ...(opts.configOverrides[opts.pluginId] ?? {}),
    }),
    log: (message: string, meta?: unknown) => {
      if (meta !== undefined) {
        log.info({ pluginId: opts.pluginId, meta }, message);
        return;
      }
      log.info({ pluginId: opts.pluginId }, message);
    },
    hostApi: opts.hostApi,
  };
}
