import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ValidateFunction } from "ajv";
import { resolveAddFormats, resolveAjv } from "../config-schema.js";
import type { PluginPaths } from "../plugin-paths.js";
import { resolvePluginPaths } from "../plugin-paths.js";
import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_HOST_STORAGE_DIR_NAME,
  resolvePluginHostStorageDir,
  resolvePluginSocketDir,
  resolvePluginWorkerRunRoot,
} from "../plugin-storage-layout.js";
import { ensurePluginDataDir } from "../runtime/sandbox.js";
import {
  PluginMarketplaceService,
  type PreparedMarketplacePluginActivation,
} from "../marketplace.js";
import {
  createNoopHostApiForTests,
  PluginRuntime,
  type PluginRuntimeOptions,
} from "../runtime.js";
import type { PluginManifest, Tool } from "../types.js";
import {
  AGENT_PLUGINS_SCHEMA_URL,
  AVE_EXTENSION_NAMESPACE,
} from "../public-contract.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationAccess,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import type { ActivePluginGeneration } from "../plugin-generation-coordinator.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { HOST_PROTOCOL_VERSIONS_SERVED } from "../isolation/host-api-wire.js";

type GenerationCommitScope = <T>(operation: () => Promise<T>) => Promise<T>;

/** Admit and lease only generationId without coordinator scheduling; effect-scope tests cover lease machinery. */
export function admittedGenerationAccess(generationId: string): PluginRuntimeGenerationAccess {
  return {
    getActive: () => undefined,
    isExactAdmitted: (_pluginId: string, candidate: string) => candidate === generationId,
    acquire: async () => {
      throw new Error("admittedGenerationAccess: acquire is not used");
    },
    acquireExact: async (_pluginId: string, candidate: string) => {
      if (candidate !== generationId) throw new Error(`generation ${candidate} is not admitted`);
      return { generation: { generationId } as never, release: () => undefined };
    },
    runWithLease: async <T>(_lease: unknown, operation: () => Promise<T>) => operation(),
  } as unknown as PluginRuntimeGenerationAccess;
}

const execFileAsync = promisify(execFile);

/** Lay out sibling data/ and host-only storage/ roots; return data/ for the runtime context. */
export function pluginDataDirIn(root: string): string {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(resolvePluginHostStorageDir(dataDir), { recursive: true, mode: 0o700 });
  return dataDir;
}

/** Reproduce child-created cleanup obstacles: unreadable directories and macOS user-immutable entries. */
export async function seedChildLockedTree(dir: string): Promise<void> {
  const locked = join(dir, "locked");
  await mkdir(join(locked, "deep"), { recursive: true });
  await writeFile(join(locked, "deep", "state.bin"), "state");
  await chmod(locked, 0o000);
  if (process.platform === "darwin") {
    const immutable = join(dir, "immutable");
    await mkdir(immutable, { recursive: true });
    await writeFile(join(immutable, "pinned.txt"), "pinned");
    await execFileAsync("/usr/bin/chflags", ["uchg", join(immutable, "pinned.txt")]);
    await execFileAsync("/usr/bin/chflags", ["uchg", immutable]);
  }
}

/** Clear macOS uchg before chmod; repeat after unreadable parents become traversable. */
export async function makeTestTreeWritable(root: string): Promise<void> {
  if (process.platform === "darwin") await clearUserImmutable(root);
  await restoreOwnerModes(root);
  if (process.platform === "darwin") await clearUserImmutable(root);
}

async function clearUserImmutable(root: string): Promise<void> {
  await execFileAsync("/usr/bin/chflags", ["-R", "-P", "nouchg", root]).catch(() => undefined);
}

async function restoreOwnerModes(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => restoreOwnerModes(join(root, entry.name))));
}

/** Storage fixtures must cross the same mandatory activation seam as production. */
export const activateAndCommitPreparedPluginForTest: PreparedMarketplacePluginActivation =
  async (prepared) => {
    const completion = Promise.resolve();
    return {
      result: await prepared.durableCommit(),
      retirement: completion,
      completion,
      retirementDeferred: false,
    };
  };

export const preparedActivationOptionsForTest = Object.freeze({
  activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
});

/** Materialize runtime directories at the final root before commit, matching real candidate activation. */
export function materialiseCandidateRuntimeDirsForTest(
  pluginId: string,
  stagedPluginRoot: string,
  pluginsRoot: string,
): { dataDir: string; socketDir: string; workerRunRoot: string } {
  const dataDir = ensurePluginDataDir(pluginId, stagedPluginRoot, pluginsRoot);
  const workerRunRoot = resolvePluginWorkerRunRoot(dataDir);
  mkdirSync(workerRunRoot, { recursive: true, mode: 0o700 });
  return { dataDir, socketDir: resolvePluginSocketDir(dataDir), workerRunRoot };
}

/** Keep test lifecycle defaults here without weakening production activation requirements. */
export class TestPluginMarketplaceService extends PluginMarketplaceService {
  override installLocal(...args: Parameters<PluginMarketplaceService["installLocal"]>) {
    const [sourcePath, options] = args;
    return super.installLocal(
      sourcePath,
      options ?? preparedActivationOptionsForTest,
    );
  }
}

/** Expand names into pure model-and-app-visible tools with empty input schemas. */
export function pureTool(
  name: string,
  visibility: Array<"model" | "app"> = ["model", "app"],
  extra: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility } },
    ...extra,
  };
}

export function pureTools(...names: string[]): Tool[] {
  return names.map((n) => pureTool(n));
}

function normalizeTestTools(
  tools: ReadonlyArray<string | Tool> | undefined,
): Tool[] {
  return (tools ?? []).map((t) => (typeof t === "string" ? pureTool(t) : t));
}

export interface TestPluginPathsInput {
  rootDir: string;
  pluginsRoot?: string;
  cacheRoot?: string;
}

export function makeTestPluginPaths(input: TestPluginPathsInput): PluginPaths {
  return resolvePluginPaths({
    pluginsRoot: input.pluginsRoot ?? resolve(input.rootDir, "plugins"),
    cacheRoot: input.cacheRoot,
  });
}

/** Required manifest defaults stay type-checked so schema changes fail at compile time. */
export function makeTestManifest(
  overrides: Partial<Omit<PluginManifest, "tools">> &
    Pick<PluginManifest, "id"> & {
      tools?: ReadonlyArray<string | Tool>;
    },
): PluginManifest {
  const { tools: overrideTools, ...rest } = overrides;
  const tools = normalizeTestTools(overrideTools);
  return {
    name: overrides.id,
    version: "0.0.0",
    description: "test fixture",
    entry: "dist/hostPlugin.js",
    ...(rest as Partial<PluginManifest>),
    requires: { hostProtocol: "4", ...overrides.requires },
    tools,
  };
}

export interface TestPluginRuntimeFixture {
  rootDir: string;
  pluginsRoot: string;
  registryPath: string;
}

export interface TestPluginRuntimeFixtureOptions {
  /** Prefix passed to `mkdtempSync`; defaults to `ave-plugin-test-`. */
  prefix?: string;
  /** Optional plugin root override relative to `rootDir`; defaults to `plugins/installed`. */
  pluginsRootRelative?: string;
}

export async function makeTestPluginRuntimeFixture(
  options: TestPluginRuntimeFixtureOptions = {},
): Promise<TestPluginRuntimeFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? "ave-plugin-test-"));
  const pluginsRoot = join(rootDir, options.pluginsRootRelative ?? "plugins/installed");
  const registryPath = join(rootDir, "plugins", "registry.json");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(dirname(registryPath), { recursive: true });
  return { rootDir, pluginsRoot, registryPath };
}

export interface WriteTestPluginOptions {
  id: string;
  entry?: string;
  entrySource?: string;
  tools?: string[];
  manifest?: Partial<PluginManifest> & Record<string, unknown>;
}

export interface WrittenTestPlugin {
  pluginDir: string;
  manifestPath: string;
  manifest: PluginManifest;
}

export function makeTestPluginEntrySource(
  handlers: Record<string, string> = {},
): string {
  const handlerEntries = Object.entries(handlers)
    .map(([name, body]) => `${JSON.stringify(name)}: async () => ${body}`)
    .join(", ");
  return `export default async function createPlugin() {
  return { handlers: { ${handlerEntries} }, start: async () => {}, stop: async () => {} };
}
`;
}

/** Edit Ave fields inside the existing namespace; rewrapping the document would double-nest it. */
export function patchAveFields(
  document: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const extensions = document.extensions as
    | Record<string, Record<string, unknown>>
    | undefined;
  const namespace = extensions?.[AVE_EXTENSION_NAMESPACE];
  if (!namespace) {
    throw new Error(
      `manifest document has no extensions["${AVE_EXTENSION_NAMESPACE}"] to patch`,
    );
  }
  Object.assign(namespace, patch);
  return document;
}

// A permissive envelope must preserve document shape so host-check tests fail at the intended boundary.
// Only namespaceProperties are constrained unless strict.
export function permissiveManifestEnvelopeSchema(options: {
  namespaceProperties?: Record<string, unknown>;
  namespaceRequired?: string[];
  strict?: boolean;
} = {}): Record<string, unknown> {
  const strict = options.strict ?? false;
  return {
    type: "object",
    additionalProperties: !strict,
    required: ["$schema", "name", "version", "description", "extensions"],
    properties: {
      $schema: { type: "string" },
      name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$", minLength: 3 },
      description: { type: "string" },
      version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
      extensions: {
        type: "object",
        // Non-strict envelopes must still allow unknown vendor objects.
        additionalProperties: strict ? false : { type: "object" },
        properties: {
          [AVE_EXTENSION_NAMESPACE]: {
            type: "object",
            additionalProperties: !strict,
            required: options.namespaceRequired ?? [],
            properties: {
              displayName: { type: "string" },
              ...options.namespaceProperties,
            },
          },
        },
      },
    },
  };
}

/** Create a validator per suite because its errors belong to the last validation call. */
export function permissiveManifestValidatorFactory(
  options: Parameters<typeof permissiveManifestEnvelopeSchema>[0] = {},
): () => ValidateFunction {
  const schema = permissiveManifestEnvelopeSchema(options);
  const Ajv = resolveAjv();
  const addFormats = resolveAddFormats();
  return () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    return ajv.compile(schema);
  };
}

/** Ave fields live inside extensions["ai.agent-connector.ave"], not portable top-level properties. */
export function aveSchemaProperties(
  schema: unknown,
): Record<string, Record<string, unknown>> {
  const properties = (schema as { properties?: Record<string, unknown> })
    .properties;
  const extensions = properties?.extensions as
    | { properties?: Record<string, unknown> }
    | undefined;
  const namespace = extensions?.properties?.[AVE_EXTENSION_NAMESPACE] as
    | { properties?: Record<string, Record<string, unknown>> }
    | undefined;
  if (!namespace?.properties) {
    throw new Error(
      `host manifest schema has no extensions["${AVE_EXTENSION_NAMESPACE}"].properties`,
    );
  }
  return namespace.properties;
}

/** Portable top-level fields must match flattenAgentPluginsManifest so round trips preserve field ownership. */
const AGENT_PLUGINS_PORTABLE_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]);

/** Write nested documents from flat fixtures while preserving missing identity for rejection tests. */
export function agentPluginsDocument(
  manifest: Readonly<Record<string, unknown>> | PluginManifest,
): Record<string, unknown> {
  const { id, name, ...rest } = manifest as Record<string, unknown>;
  const top: Record<string, unknown> = { $schema: AGENT_PLUGINS_SCHEMA_URL };
  if (id !== undefined) top.name = id;
  const ave: Record<string, unknown> = {};
  if (name !== undefined) ave.displayName = name;
  for (const [key, value] of Object.entries(rest)) {
    if (AGENT_PLUGINS_PORTABLE_FIELDS.has(key)) top[key] = value;
    else ave[key] = value;
  }
  top.extensions = { [AVE_EXTENSION_NAMESPACE]: ave };
  return top;
}

export function servedAgentPluginsDocument(
  manifest: Readonly<Record<string, unknown>> | PluginManifest,
): Record<string, unknown> {
  const requires = (manifest as Record<string, unknown>).requires;
  if (requires !== undefined && (typeof requires !== "object" || requires === null || Array.isArray(requires))) {
    return agentPluginsDocument(manifest);
  }
  return agentPluginsDocument({
    ...manifest,
    requires: { hostProtocol: HOST_PROTOCOL_VERSIONS_SERVED[0], ...requires },
  });
}

// Share a valid manifest envelope so each suite tests its chosen field rather than unrelated schema failures.
// Read the scratch directory per call because fixtures create it per test.
export function pluginManifestWriter(
  identity: { readonly id: string; readonly name: string },
  directory: () => string,
): (extra?: Record<string, unknown>) => Promise<string> {
  return async (extra = {}) => {
    const path = join(directory(), "plugin.json");
    await writeFile(
      path,
      JSON.stringify(
        agentPluginsDocument({
          id: identity.id,
          name: identity.name,
          description: "x",
          version: "1.0.0",
          entry: "dist/p.js",
          tools: [
            {
              name: "t_one",
              description: "t_one tool",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model", "app"] } },
            },
          ],
          ...extra,
        }),
      ),
    );
    return path;
  };
}

export async function writeTestPlugin(
  fixture: TestPluginRuntimeFixture,
  options: WriteTestPluginOptions,
): Promise<WrittenTestPlugin> {
  const entry = options.entry ?? "entry.mjs";
  const tools = options.tools ?? [];
  const pluginDir = join(fixture.pluginsRoot, options.id);
  await mkdir(pluginDir, { recursive: true });
  if (options.entrySource !== undefined) {
    await writeFile(join(pluginDir, entry), options.entrySource, "utf-8");
  }
  const manifest = makeTestManifest({
    id: options.id,
    entry,
    tools,
    ...options.manifest,
  });
  const manifestPath = join(pluginDir, "plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify(agentPluginsDocument(manifest)),
    "utf-8",
  );
  return { pluginDir, manifestPath, manifest };
}

export interface TestRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  approvedPluginAccess?: unknown;
  /** Staged-update marker. Rows carrying it are skipped by manifest discovery. */
  pendingUpdate?: unknown;
  installSource?: "admin" | "user" | "local-dev";
  installedBy?: "admin" | "user";
  _devLinked?: boolean;
  /** The source binding of a git install. */
  origin?: unknown;
}

export async function writeTestPluginRegistry(
  fixture: Pick<TestPluginRuntimeFixture, "registryPath">,
  entries: TestRegistryEntry[],
): Promise<void> {
  await mkdir(dirname(fixture.registryPath), { recursive: true });
  await writeFile(
    fixture.registryPath,
    JSON.stringify({ version: 1, plugins: entries }),
    "utf-8",
  );
}

export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Use src-relative POSIX paths for portable boundary failure messages. */
export function sourceDisplayPath(file: string): string {
  return relative(SOURCE_ROOT, file).split(sep).join("/");
}

export function isProductionSourceModule(file: string): boolean {
  const name = sourceDisplayPath(file);
  return !/(^|\/)__tests__\//u.test(name)
    && !/(^|\/)__probes__\//u.test(name)
    && !/\.test\.tsx?$/u.test(name);
}

/** Cross-process tests signal through atomically renamed files under their own temporary root; globals cannot reach plugin children. */
export interface ChildProcessGate {
  readonly moduleSource: string;
  signal(name: string, value?: string): Promise<void>;
  waitFor(name: string, timeoutMs?: number): Promise<string>;
}

export async function childProcessGate(dir: string): Promise<ChildProcessGate> {
  await mkdir(dir, { recursive: true });
  const at = (name: string): string => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`gate signal '${name}' is not a plain name`);
    return join(dir, name);
  };
  return {
    moduleSource: `import { existsSync as __gateExists, readFileSync as __gateRead, renameSync as __gateRename, writeFileSync as __gateWrite } from "node:fs";
import { join as __gateJoin } from "node:path";
const __gateDir = ${JSON.stringify(dir)};
const gate = {
  signal(name, value = "") {
    const path = __gateJoin(__gateDir, name);
    __gateWrite(path + ".tmp", value);
    __gateRename(path + ".tmp", path);
  },
  async waitFor(name) {
    const path = __gateJoin(__gateDir, name);
    while (!__gateExists(path)) await new Promise((resolve) => setTimeout(resolve, 5));
    return __gateRead(path, "utf8");
  },
};
`,
    signal: async (name, value = "") => {
      const path = at(name);
      await writeFile(`${path}.tmp`, value, "utf8");
      await rename(`${path}.tmp`, path);
    },
    waitFor: async (name, timeoutMs = 10_000) => {
      const path = at(name);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (Date.now() >= deadline) throw new Error(`plugin never signalled '${name}' within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

export function makeTestPluginRuntime(
  fixture: TestPluginRuntimeFixture,
  options: Partial<PluginRuntimeOptions> = {},
): PluginRuntime {
  return bindTestPluginRuntimeGeneration(new PluginRuntime({ encryption: unavailableSecretEncryption,
    childEntryPath: pluginChildEntryPath(),
    hostRoot: fixture.rootDir,
    registryPath: fixture.registryPath,
    pluginsRoot: fixture.pluginsRoot,
    createHostApi: createNoopHostApiForTests,
    ...options,
  }));
}

export function makeTestPluginRuntimeWithAudit(
  fixture: TestPluginRuntimeFixture,
  auditEntries: Array<{ level: string; message: string; data?: unknown }>,
): PluginRuntime {
  return makeTestPluginRuntime(fixture, {
    auditLog: (level, message, data) => {
      auditEntries.push({ level, message, data });
    },
  });
}

/** Runtime unit tests use mutable fixture roots with real coordinator publication; production keeps strict receipt-backed generation binding. */
export function bindTestPluginRuntimeGeneration(runtime: PluginRuntime): PluginRuntime {
  const active = new Map<string, ActivePluginGeneration<HostPluginGenerationState>>();
  const lifecycleTails = new Map<string, Promise<void>>();
  const lifecycleQueueContext = new AsyncLocalStorage<ReadonlyMap<string, object>>();
  const activeLifecycleQueueTokens = new WeakSet<object>();
  const retirementTasks = new Map<Promise<void>, ActivePluginGeneration<HostPluginGenerationState>>();
  let sequence = 0;
  // The production lifecycle's admission contract: once closed (shutdown) no
  // lease is granted and no candidate publishes.
  let admissionClosure: ((pluginId: string) => Error) | undefined;
  const assertAdmissionOpen = (pluginId: string): void => {
    if (admissionClosure) throw admissionClosure(pluginId);
  };

  const trackRetirement = (
    retirement: Promise<void>,
    generation: ActivePluginGeneration<HostPluginGenerationState>,
  ): Promise<void> => {
    retirementTasks.set(retirement, generation);
    void retirement
      .finally(() => retirementTasks.delete(retirement))
      .catch(() => undefined);
    return retirement;
  };

  const runInLifecycleQueue = <T>(
    pluginId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const current = lifecycleQueueContext.getStore();
    const currentToken = current?.get(pluginId);
    if (currentToken && activeLifecycleQueueTokens.has(currentToken)) return operation();
    const prior = lifecycleTails.get(pluginId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const token = {};
      const inherited = new Map(lifecycleQueueContext.getStore() ?? current ?? []);
      inherited.set(pluginId, token);
      activeLifecycleQueueTokens.add(token);
      try {
        return await lifecycleQueueContext.run(inherited, operation);
      } finally {
        activeLifecycleQueueTokens.delete(token);
      }
    });
    const tail = next.then(() => undefined, () => undefined);
    lifecycleTails.set(pluginId, tail);
    return next.finally(() => {
      if (lifecycleTails.get(pluginId) === tail) lifecycleTails.delete(pluginId);
    });
  };

  const adoptLegacyProjection = (
    pluginId: string,
  ): ActivePluginGeneration<HostPluginGenerationState> | undefined => {
    const existing = active.get(pluginId);
    if (existing) return existing;
    // Unpublished failed candidates have no active identity; inventing one would make retries collide with phantom install claims.
    if (!runtime.listPluginIds().includes(pluginId)) return undefined;
    if (runtime.resolvePluginInstallIdIfKnown(pluginId) === undefined) {
      (runtime as unknown as {
        rememberPluginInstallAlias(id: string, alias: undefined): void;
      }).rememberPluginInstallAlias(pluginId, undefined);
    }
    const projection = runtime.getRuntimeGenerationProjection(pluginId);
    if (!projection) return undefined;
    const methods = new Map(
      [...runtime.getMethodMap()].flatMap(([name, entry]) =>
        entry.pluginId === pluginId ? [[name, entry.handler] as const] : [],
      ),
    );
    const generationId = projection.activationId || `test-generation-${++sequence}`;
    const normalizedProjection = Object.freeze({
      ...projection,
      activationId: generationId,
      pluginRoot: projection.pluginRoot || "/tmp/test-plugin-runtime",
      methods,
    });
    const generation: ActivePluginGeneration<HostPluginGenerationState> = {
      pluginId,
      pluginVersion: projection.manifest.version,
      artifactGenerationId: generationId,
      generationId,
      manifestSha256: generationId,
      receiptSha256: generationId,
      contributions: [],
      state: {
        payloadRoot: normalizedProjection.pluginRoot,
        runtime: normalizedProjection,
        hooks: [],
        mcpServers: [],
      },
    };
    active.set(pluginId, generation);
    return generation;
  };

  const runRuntimeRetirement = async (
    projection: PluginRuntimeGenerationProjection,
  ): Promise<void> => {
    const errors: Error[] = [];
    for (const step of runtime.prepareRuntimeRetirement(projection)) {
      try {
        await step.run();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `plugin '${projection.manifest.id}' generation retirement failed`,
      );
    }
  };

  const publish = async (
    projection: PluginRuntimeGenerationProjection,
  ): Promise<{ retirement: Promise<void> }> => {
    const pluginId = projection.manifest.id;
    assertAdmissionOpen(pluginId);
    const predecessor = active.get(pluginId);
    const generationId = `test-generation-${++sequence}`;
    projection.hostEffects?.bindGeneration(lifecycle as never, generationId);
    runtime.prepareRuntimeGeneration(projection, predecessor?.generationId).publish();
    active.set(pluginId, {
      pluginId,
      pluginVersion: projection.manifest.version,
      artifactGenerationId: generationId,
      generationId,
      manifestSha256: generationId,
      receiptSha256: generationId,
      contributions: [],
      state: {
        payloadRoot: projection.pluginRoot,
        runtime: projection,
        hooks: [],
        mcpServers: [],
      },
    });
    const retirement = predecessor && predecessor.state.runtime !== projection
      ? trackRetirement(runRuntimeRetirement(predecessor.state.runtime), predecessor)
      : Promise.resolve();
    return { retirement };
  };

  const deactivate = async (
    pluginId: string,
  ): Promise<{ retirement: Promise<void> }> => {
    const predecessor = active.get(pluginId);
    runtime.prepareRuntimeRemoval(pluginId, predecessor?.generationId).publish();
    active.delete(pluginId);
    const retirement = predecessor
      ? trackRetirement(runRuntimeRetirement(predecessor.state.runtime), predecessor)
      : Promise.resolve();
    return { retirement };
  };

  const lifecycle = {
    runInLifecycleQueue,
    getActive: (pluginId: string) => {
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      return generation
        ? {
            pluginId: generation.pluginId,
            generationId: generation.generationId,
            manifest: generation.state.runtime.manifest,
          }
        : undefined;
    },
    isExactAdmitted: (pluginId: string, generationId: string) =>
      active.get(pluginId)?.generationId === generationId,
    acquire: async (pluginId: string) => {
      assertAdmissionOpen(pluginId);
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      if (!generation) throw new Error(`test generation is not active for '${pluginId}'`);
      return { generation, release: () => undefined };
    },
    acquireExact: async (pluginId: string, generationId: string) => {
      assertAdmissionOpen(pluginId);
      const generation = active.get(pluginId) ?? adoptLegacyProjection(pluginId);
      if (!generation || generation.generationId !== generationId) {
        throw new Error(`test generation '${pluginId}:${generationId}' is not active`);
      }
      return { generation, release: () => undefined };
    },
    runWithLease: async <T>(_lease: unknown, operation: () => Promise<T>) => operation(),
    replaceRuntime: async (
      projection: PluginRuntimeGenerationProjection,
      commitScope?: GenerationCommitScope,
    ) => {
      const commit = () => publish(projection);
      await (commitScope ? commitScope(commit) : commit());
    },
    replaceRuntimeWithCommit: <T>(
      projection: PluginRuntimeGenerationProjection,
      _receiptRaw: string,
      durableCommit: () => Promise<T>,
      commitScope?: GenerationCommitScope,
    ) => runInLifecycleQueue(projection.manifest.id, async () => {
      const commit = async () => {
        const result = await durableCommit();
        const { retirement } = await publish(projection);
        return {
          result,
          retirement,
          completion: retirement,
          retirementDeferred: false,
        };
      };
      return commitScope ? commitScope(commit) : commit();
    }),
    deactivate: (pluginId: string) => runInLifecycleQueue(pluginId, async () => {
      await deactivate(pluginId);
    }),
    deactivateWithCommit: <T>(
      pluginId: string,
      durableCommit: () => Promise<T>,
      commitScope?: GenerationCommitScope,
    ) =>
      runInLifecycleQueue(pluginId, async () => {
        const commit = async () => {
          const result = await durableCommit();
          const { retirement } = await deactivate(pluginId);
          return {
            result,
            retirement,
            completion: retirement,
            retirementDeferred: false,
          };
        };
        return commitScope ? commitScope(commit) : commit();
      }),
    recoverRetirements: async () => undefined,
    waitForRetirements: async () => {
      await Promise.all([...retirementTasks.keys()]);
    },
    closeAdmission: (reason: (pluginId: string) => Error) => {
      admissionClosure ??= reason;
    },
    listRetiringGenerations: () => [...retirementTasks].map(([retired, generation]) => ({
      pluginId: generation.pluginId,
      generationId: generation.generationId,
      runtime: generation.state.runtime,
      retired,
    })),
  };

  const testInternals = runtime as unknown as {
    materializeImmutableRuntimeRoot: (
      pluginId: string,
      pluginRoot: string,
      activationId: string,
    ) => Promise<string>;
    removeUnpublishedRuntimeRoot: (pluginId: string, pluginRoot: string) => Promise<void>;
  };
  testInternals.materializeImmutableRuntimeRoot = async (_pluginId, pluginRoot) => pluginRoot;
  testInternals.removeUnpublishedRuntimeRoot = async () => undefined;
  runtime.setGenerationAccess(lifecycle as never);
  return runtime;
}

export function createTestHostApiFactory(
  provided?: PluginRuntimeOptions["createHostApi"],
): PluginRuntimeOptions["createHostApi"] {
  return (...args) => {
    const fallback = createNoopHostApiForTests(...args);
    const hostApi = provided?.(...args);
    if (!hostApi) return fallback;
    return {
      ...fallback,
      ...hostApi,
      storage: hostApi.storage ?? fallback.storage,
    };
  };
}

/** PluginRuntime constructor for tests that need the complete generation fixture. */
export class TestPluginRuntime extends PluginRuntime {
  constructor(
    options: Omit<PluginRuntimeOptions, "createHostApi" | "encryption" | "childEntryPath">
      & Partial<Pick<PluginRuntimeOptions, "createHostApi" | "encryption" | "childEntryPath">>,
  ) {
    super({
      encryption: unavailableSecretEncryption,
      // This run's bundle of the child entry every `entry` plugin spawns.
      childEntryPath: pluginChildEntryPath(),
      ...options,
      createHostApi: createTestHostApiFactory(options.createHostApi),
    });
    bindTestPluginRuntimeGeneration(this);
  }
}

export function makeTestPluginMarketplaceService(rootDir: string): PluginMarketplaceService {
  return new TestPluginMarketplaceService(makeTestPluginPaths({ rootDir }));
}

/** Flat and nested binary state in both data/ and storage/ must survive root swaps. */
export const PLUGIN_DATA_FIXTURE: ReadonlyMap<string, Buffer> = new Map([
  [`${PLUGIN_DATA_DIR_NAME}/state.json`, Buffer.from(`${JSON.stringify({ sessions: 3, lastRun: "2026-08-01T00:00:00.000Z" })}\n`)],
  [`${PLUGIN_DATA_DIR_NAME}/index/segment-0001.bin`, Buffer.from([0, 255, 127, 128, 1, 2, 3, 4, 250, 251, 252, 253])],
  [`${PLUGIN_HOST_STORAGE_DIR_NAME}/session-snapshot.json`, Buffer.from(`${JSON.stringify({ signedIn: true })}\n`)],
  [`${PLUGIN_HOST_STORAGE_DIR_NAME}/auth/token-default.json`, Buffer.from("ENC(token)")],
]);

/** Write {@link PLUGIN_DATA_FIXTURE} under `<pluginRoot>`. */
export async function seedPluginDataFixture(pluginRoot: string): Promise<void> {
  for (const [relPath, bytes] of PLUGIN_DATA_FIXTURE) {
    const target = join(pluginRoot, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

/** Compare file sets and bytes together; absent directories read as empty so state loss fails the assertion. */
export async function readPluginDataFixture(pluginRoot: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.set(relative(pluginRoot, abs).split("\\").join("/"), await readFile(abs));
    }
  }
  await walk(join(pluginRoot, PLUGIN_DATA_DIR_NAME));
  await walk(join(pluginRoot, PLUGIN_HOST_STORAGE_DIR_NAME));
  return out;
}
