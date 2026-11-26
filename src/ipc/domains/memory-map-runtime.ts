import { dialog, type IpcMainInvokeEvent } from 'electron';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { permissionSettingsPath } from '../../permissions/permission-settings-store.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryEmbeddingSettings } from '../../shared/memory-map.js';
import type { z } from 'zod';
import type { MemoryEmbeddingSettingsSchema, MemoryRetrievalSchema } from '../../shared/memory-map-validation.js';
import { assertLocalEmbeddingRuntime, refreshLocalInferenceAdmission } from '../../main/memory-map/local-runtime.js';
import type { WindowsBackgroundAdmission } from '../../permissions/windows-background-features.js';
import { runMemoryWorker } from '../../main/memory-map/worker-client.js';
import { LocalModelManager, MemoryModelError } from '../../main/memory-map/model-manager.js';
import { MemoryMapHost, MemoryMapHostError } from '../../main/memory-map/host.js';
import { readGraphCatalog, memoryFacets, graphMemoryRevision, isGraphMemory, matchesGraphRecord, memoryMapScopeId, type ReadMemoryMapCatalog } from '../../main/memory-map/catalog.js';
import { ProviderEmbeddings } from '../../main/memory-map/provider-embeddings.js';
import { createMemoryProviderEgress } from '../../main/memory-map/provider-egress.js';
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from '../../shared/memory-embedding-config.js';
import { getLlmVendorSettings, LLM_VENDORS } from '../../shared/llm-vendor-defaults.js';
import { defaultWorkspaceProject } from '../../main/project-root-authorization.js';
import { sendToWebContents } from '../safe-send.js';
import type { NoteEntry } from '../../memory/memory-manager.js';
import type { MemoryMapScopeResolver } from './memory-map.js';

// Loaded on the first memory-map request so the host, model manager and provider stay out of the main entry.
const MEMORY_EMBEDDING_ALLOWED_DOMAINS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  ...LLM_VENDORS.flatMap(vendor => {
    const url = getLlmVendorSettings(undefined, vendor).baseUrl;
    return url?.startsWith('https:') ? [new URL(url).hostname] : [];
  }),
];

type MemoryRetrievalRequest = z.infer<typeof MemoryRetrievalSchema>;
type MemoryEmbeddingSettingsInput = z.infer<typeof MemoryEmbeddingSettingsSchema>;

export interface MemoryMapRuntime {
  get(scope: MemoryMapScope | undefined): unknown;
  build(scope: MemoryMapScope | undefined, event: IpcMainInvokeEvent): unknown;
  cancel(): null;
  facets(scope: MemoryMapScope | undefined): unknown;
  retrieve(request: MemoryRetrievalRequest): unknown;
  modelStatus(): unknown;
  modelDownload(event: IpcMainInvokeEvent): unknown;
  modelCancel(): null;
  modelUseExisting(event: IpcMainInvokeEvent): unknown;
  settingsGet(): Promise<MemoryEmbeddingSettings>;
  settingsSet(input: MemoryEmbeddingSettingsInput): unknown;
  errorCode(error: unknown): string | undefined;
  readSource(id: string, rawScope: unknown, contentRevision: string): NoteEntry | undefined;
}

export function createMemoryMapRuntime(deps: IpcDeps, resolveScope: MemoryMapScopeResolver): MemoryMapRuntime {
  const send = createMemoryProviderEgress(deps.singleHopNetworkFetch, MEMORY_EMBEDDING_ALLOWED_DOMAINS, entry => {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: 'memory-embeddings',
      type: 'tool_call',
      input: entry.allowed ? `host_fetch ${entry.origin} method=${entry.method}` : `host_fetch denied: ${entry.reason}`,
    });
  });
  const provider = new ProviderEmbeddings(deps.settingsService, send);
  const storedLocalInferencePreference = () => deps.settingsService.get('memoryEmbedding')?.localInferenceWithoutSandbox
    ?? DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX;
  let pendingInferenceDisables = 0;
  const localInferencePreference = () => pendingInferenceDisables === 0 && storedLocalInferencePreference();
  const localRuntime = (admission: WindowsBackgroundAdmission) => assertLocalEmbeddingRuntime(localInferencePreference(), admission);
  const refreshLocalPreparation = () => refreshLocalInferenceAdmission("switches");
  let buildGeneration = 0;
  let modelGeneration = 0;
  let settingsGeneration = 0;
  let settingsWrite: Promise<unknown> = Promise.resolve();
  let buildEvent: IpcMainInvokeEvent | undefined; let modelEvent: IpcMainInvokeEvent | undefined;
  const model = new LocalModelManager({
    refreshAdmission: async () => {
      const admission = await refreshLocalPreparation();
      return () => { localRuntime(admission); };
    },
    readPath: () => deps.settingsService.get('memoryEmbedding')?.localModelPath,
    savePath: path => deps.settingsService.set('memoryEmbedding', { ...deps.settingsService.get('memoryEmbedding'), localModelPath: path }),
    onProgress: status => { if (modelEvent && validateHostRendererSender(modelEvent)) sendToWebContents(modelEvent.sender, CHANNELS.memoryMap.modelProgress, status); },
  });
  const watchAuthority = (cancel: () => void) => {
    const stopNotes = deps.memoryManager.watchMemoryNotes(cancel);
    const policyPath = permissionSettingsPath();
    try {
      const policyName = basename(policyPath);
      const policyWatcher = watch(dirname(policyPath), { persistent: false }, (_eventType, filename) => {
        if (filename === null || filename === policyName) cancel();
      });
      policyWatcher.on('error', cancel);
      return () => { stopNotes(); policyWatcher.close(); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return stopNotes;
      stopNotes();
      throw error;
    }
  };
  const host = new MemoryMapHost({
    provider,
    watchAuthority,
    runWorker: (folder, task, signal, onProgress) => runMemoryWorker(folder, task, signal, onProgress, localInferencePreference),
    validatedModelPath: async (signal) => {
      const admission = await refreshLocalPreparation();
      signal.throwIfAborted();
      localRuntime(admission);
      if (!deps.settingsService.get('memoryEmbedding')?.localModelPath) throw new MemoryMapHostError('model-unconfigured');
      return model.validatedPath();
    },
    onProgress: progress => {
      if (buildEvent && validateHostRendererSender(buildEvent)) sendToWebContents(buildEvent.sender, CHANNELS.memoryMap.progress, progress);
    },
  });
  const cancelBuild = () => { buildGeneration += 1; host.cancel(); };
  const cancelModel = () => { modelGeneration += 1; model.cancel(); };
  const assertCurrentModelRequest = (generation: number) => {
    if (generation !== modelGeneration) throw new MemoryModelError('model-cancelled');
  };
  const startModelOperation = async (generation: number, event: IpcMainInvokeEvent, start: () => unknown) => {
    const admission = await refreshLocalPreparation();
    assertCurrentModelRequest(generation);
    localRuntime(admission);
    cancelBuild();
    modelEvent = event;
    return start();
  };
  let sourceIndex: { scopeId: string; filenames: Map<string, string> } | undefined;
  const catalog = (scope?: MemoryMapScope): ReadMemoryMapCatalog => {
    const filenames = new Map<string, string>();
    const read: ReadMemoryMapCatalog = () => {
      const result = resolveScope(scope);
      if (!result.ok) { host.cancel(); throw new MemoryMapHostError('project-not-allowed'); }
      filenames.clear();
      const current = readGraphCatalog(deps.memoryManager, result.options, defaultWorkspaceProject().projectRoot, filenames);
      sourceIndex = { scopeId: current.authorizationScopeId, filenames };
      return current;
    };
    read.recordsAreCurrent = (scopeId, records) => {
      const result = resolveScope(scope);
      if (!result.ok || memoryMapScopeId(result.options) !== scopeId) return false;
      return records.every(record => {
        const filename = filenames.get(record.memoryId);
        return filename !== undefined && matchesGraphRecord(deps.memoryManager.readManagedMemoryAt(filename, record.memoryId, result.options), record);
      });
    };
    return read;
  };
  const settings = async (): Promise<MemoryEmbeddingSettings> => {
    const providers = await provider.providers();
    const namespace = provider.namespace();
    const consent = provider.currentConsent();
    return {
      source: namespace.source, namespace, providers, providerAvailable: providers.some(value => value.models.length > 0),
      ...(consent ? { consent } : {}),
      ...((await refreshLocalInferenceAdmission("switches")).areSwitchesAvailable() ? { localInferenceWithoutSandbox: storedLocalInferencePreference() } : {}),
    };
  };
  return {
    get: scope => host.get(catalog(scope)),
    build: async (scope, event) => {
      const generation = ++buildGeneration;
      if (deps.settingsService.get('memoryEmbedding')?.source !== 'provider') {
        const admission = await refreshLocalPreparation();
        if (generation !== buildGeneration) throw new MemoryMapHostError('request-stale');
        localRuntime(admission);
      }
      buildEvent = event;
      return host.build(catalog(scope));
    },
    cancel: () => { cancelBuild(); return null; },
    facets: async scope => { await host.get(catalog(scope)); return memoryFacets(catalog(scope)().records); },
    retrieve: request => host.retrieve(catalog(request.scope), request),
    modelStatus: async () => {
      localRuntime(await refreshLocalPreparation());
      return model.status();
    },
    modelDownload: event => startModelOperation(++modelGeneration, event, () => model.download()),
    modelCancel: () => { cancelModel(); return null; },
    modelUseExisting: async event => {
      const generation = ++modelGeneration;
      const admission = await refreshLocalPreparation();
      assertCurrentModelRequest(generation);
      localRuntime(admission);
      const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      const folder = selection.filePaths[0];
      if (selection.canceled || !folder) return null;
      return startModelOperation(generation, event, () => model.adoptExistingFolder(folder));
    },
    settingsGet: settings,
    settingsSet: async input => {
      if ('localInferenceWithoutSandbox' in input) {
        const enabled = input.localInferenceWithoutSandbox;
        // Host work can share the very probe this settings write is waiting for.
        if (!enabled) pendingInferenceDisables += 1;
        const pending = settingsWrite.catch(() => {}).then(async () => {
          const admission = await refreshLocalInferenceAdmission();
          if (!admission.areSwitchesAvailable()) throw new MemoryMapHostError('local-runtime-unavailable');
          const previous = deps.settingsService.get('memoryEmbedding');
          if (!enabled && previous?.localInferenceWithoutSandbox !== false) {
            let usingHostChild = false;
            try { usingHostChild = assertLocalEmbeddingRuntime(storedLocalInferencePreference(), admission) === 'unconfined'; } catch (error) {
              if (!(error instanceof MemoryMapHostError)) throw error;
            }
            if (usingHostChild) {
              if (previous?.source !== 'provider') cancelBuild();
              cancelModel();
            }
          }
          await deps.settingsService.set('memoryEmbedding', { ...previous, localInferenceWithoutSandbox: enabled });
          return settings();
        }).finally(() => {
          if (!enabled) pendingInferenceDisables -= 1;
        });
        settingsWrite = pending;
        return pending;
      }
      if (input.source === 'provider') {
        if (!input.consent) throw new MemoryMapHostError('provider-consent-required');
        provider.assertCurrentEndpoint(input.providerId, input.endpointId);
      }
      const generation = ++settingsGeneration;
      provider.suspend(); cancelBuild();
      const pending = settingsWrite.catch(() => {}).then(async () => {
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        const consent = input.source === 'provider' ? await provider.issueConsent(input.providerId, input.modelId, input.endpointId) : undefined;
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        if (input.source === 'provider') provider.assertCurrentEndpoint(input.providerId, input.endpointId);
        const previous = deps.settingsService.get('memoryEmbedding');
        await deps.settingsService.set('memoryEmbedding', {
          ...(previous?.localModelPath ? { localModelPath: previous.localModelPath } : {}),
          ...(previous?.localInferenceWithoutSandbox !== undefined ? { localInferenceWithoutSandbox: previous.localInferenceWithoutSandbox } : {}),
          ...input.source === 'local' ? { source: 'local' as const } : {
            source: 'provider' as const, providerId: input.providerId, modelId: input.modelId,
            consent,
          },
        });
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        await host.invalidate();
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        provider.resume(); return settings();
      });
      settingsWrite = pending;
      return pending;
    },
    errorCode: error => error instanceof MemoryModelError || error instanceof MemoryMapHostError ? error.code : undefined,
    readSource: (id, rawScope, contentRevision) => {
      const result = resolveScope(rawScope);
      if (!result.ok || sourceIndex?.scopeId !== memoryMapScopeId(result.options)) return undefined;
      const filename = sourceIndex.filenames.get(id);
      if (!filename) return undefined;
      const note = deps.memoryManager.readManagedMemoryAt(filename, id, result.options);
      return isGraphMemory(note) && graphMemoryRevision(note) === contentRevision ? note : undefined;
    },
  };
}
