/**
 * Plugin module-loading pure slices.
 *
 * These helpers consolidate the structural patterns plugin instantiation
 * shares:
 *   - `importPluginFactory` — dynamic-import the entry module and pick the
 *     `default` / `createPlugin` export. The plugin child does this; main does
 *     not import plugin code (decision 50).
 *   - `buildMethodMap` — collect declared tool handlers off an instance,
 *     skipping (and reporting) missing handlers. Every instantiation path
 *     (load / addPlugin / restartPlugin / reloadPlugin) uses it.
 *   - `importInProcessPluginFactory` — the retained, deprecated in-process
 *     arm, with no production caller.
 *
 * They are intentionally free of runtime state and side effects beyond the
 * import itself so each call site keeps its own error handling / audit /
 * logging exactly as before.
 */
import type {
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { isAppVisible } from "./tool-visibility.js";
import { pathToFileURL } from "node:url";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/**
 * #885 v6 — the app-visible method names a manifest declares: the normalized
 * `Tool[]` whose `_meta.ui.visibility` includes "app". This is the app-visible
 * tool allowlist that feeds the renderer IPC bridge (`assertAppVisibleToolInvokable`) —
 * the {app-only ∪ dual} set.
 */
export function declaredAppVisibleToolMethods(
  manifest: Pick<PluginManifest, "tools">,
): string[] {
  return (manifest.tools ?? []).filter(isAppVisible).map((t) => t.name);
}

/**
 * #885 v6 — every runtime-invokable method name (model / app / dual is now one
 * `Tool` object). De-duped defensively though `parsePluginJson` already rejects
 * duplicate names at load. This is the full declared-tool set (the model-visible
 * ∪ app-visible tool union).
 */
/**
 * Module-private: `buildMethodMap` is the only derivation of the declared
 * runtime methods. Every instantiation path goes through it.
 */
function declaredRuntimeMethods(manifest: Pick<PluginManifest, "tools">,
): string[] {
  return [...new Set((manifest.tools ?? []).map((t) => t.name))];
}

/**
 * Build a file:// import URL from an entry path.
 *
 * It lives HERE rather than in `sandbox.ts` because it is the one line of that
 * module an isolated plugin child needs, and `sandbox.ts` reaches Electron
 * through `plugins/storage.ts` (`safeStorage`). A child is a plain Node process
 * where that import does not resolve, so leaving this function there would have
 * forced the child to either carry a second copy of it or drag Electron in —
 * and it is `import()`'s own argument, so the module that performs the import
 * is where it belongs. Nothing else in `sandbox.ts` used it.
 */
export function buildImportUrl(entryPath: string, bustCache = false): string {
  const url = pathToFileURL(entryPath).href;
  return bustCache ? `${url}?reload=${Date.now()}` : url;
}

/**
 * Dynamically import a plugin's resolved entry path and return its factory
 * (`default` preferred, else `createPlugin`), or `undefined` when neither is
 * exported. Import failures propagate to the caller so each site can log /
 * audit them in its own phase.
 *
 * ELECTRON-FREE, and that is load-bearing: the out-of-process plugin child
 * (`plugin-child-main.ts`) calls this to obtain its plugin's factory, and the
 * retained in-process path ({@link importInProcessPluginFactory}) calls the
 * same function, so the two arms cannot disagree about which export is the
 * plugin. Those two are its only importers (`host-api-boundary-contract.test.ts`
 * holds the boundary).
 */
export async function importPluginFactory(
  resolvedEntryPath: string,
  bustCache?: boolean,
): Promise<RuntimePluginFactory | undefined> {
  const module = (await import(buildImportUrl(resolvedEntryPath, bustCache))) as {
    default?: RuntimePluginFactory;
    createPlugin?: RuntimePluginFactory;
  };
  return module.default ?? module.createPlugin;
}

export class PluginImportTimeoutError extends Error {
  readonly code = "plugin-import-timeout";

  constructor(timeoutMs: number) {
    super(`plugin import timeout (>${timeoutMs}ms)`);
  }
}

/**
 * Bound the host's wait for ESM evaluation. Dynamic import cannot be aborted
 * in the main process, so callers must quarantine the affected plugin id when
 * this error is observed. The late operation is always observed to avoid an
 * unhandled rejection.
 */
export async function runPluginImportWithTimeout<T>(
  importer: () => Promise<T>,
  timeoutMs: number = TOOL_TIMEOUT_POLICY.pluginImportMs,
): Promise<T> {
  const operation = Promise.resolve().then(importer);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginImportTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

/**
 * The in-process arm, retained and deprecated: import a plugin's entry module
 * into the calling process under the import timeout.
 *
 * NO PRODUCTION CALLER. Since Admission (`docs/design/plugin-hostapi-protocol.md`
 * §9.8 A1, decision 50) the runtime routes every `entry` manifest to the
 * out-of-process factory, and `host-api-boundary-contract.test.ts` fails if a
 * production module imports this function. It stays, with its tests, so a
 * routing reversal is a reviewed code change rather than a rewrite — never a
 * runtime fallback.
 *
 * Deprecation owner: the owner role of `ken-jo`
 * (decision 5). Removal condition (§9.8, "Loader removal, restated after
 * Admission"): the registry-fed `allPluginsAreOutOfProcess` true on every
 * Doctor report since Admission; the routing matrix, the official-index test
 * and the §10.1 conformance suite green on the release tags of two
 * consecutive app releases (0.14.0, 0.15.0); and no change to this function or
 * its tests in those releases. Boundary: 0.16.0 at the latest. Removal deletes
 * this function, {@link runPluginImportWithTimeout},
 * {@link PluginImportTimeoutError}, their tests and the `"in-process"` member
 * of `PluginLoadArm`; {@link importPluginFactory} stays, as the child's.
 */
export async function importInProcessPluginFactory(
  resolvedEntryPath: string,
): Promise<RuntimePluginFactory | undefined> {
  return runPluginImportWithTimeout(() => importPluginFactory(resolvedEntryPath));
}

/**
 * Build the `toolName → handler` map for a plugin instance from its declared
 * runtime methods. Methods without a matching handler are skipped and passed
 * to `onMissingHandler` so the caller can emit its site-specific warning.
 */
export function buildMethodMap(
  manifest: Pick<PluginManifest, "tools">,
  instance: RuntimePlugin,
  onMissingHandler: (toolName: string) => void,
): Map<string, PluginToolHandler> {
  const methods = new Map<string, PluginToolHandler>();
  for (const toolName of declaredRuntimeMethods(manifest)) {
    const handler = instance.handlers[toolName];
    if (!handler) {
      onMissingHandler(toolName);
      continue;
    }
    methods.set(toolName, handler);
  }
  return methods;
}
