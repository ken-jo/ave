import { pickNativeFiles } from "../../main/desktop-approval-presentation.js";
import type { IpcMainInvokeEvent } from 'electron';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { permissionSettingsPath } from '../../permissions/permission-settings-store.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryEmbeddingSettings } from '../../shared/memory-map.js';
import type { MemoryModelStatus } from '../../shared/memory-model.js';
import type { z } from 'zod';
import type { WindowsMemoryEmbeddingSettingsSchema, MemoryRetrievalSchema } from '../../shared/memory-map-validation.js';
import { assertLocalEmbeddingRuntime, bindLocalEmbeddingRuntime, refreshLocalInferenceAdmission } from '../../main/memory-map/local-runtime-win32.js';
import type { WindowsBackgroundAdmission } from '../../permissions/windows-background-features.js';
import { runMemoryWorker } from '../../main/memory-map/worker-client-win32.js';
import { LocalModelManager, MemoryModelError } from '../../main/memory-map/model-manager-win32.js';
import { downloadModelFile } from '../../main/memory-map/model-download-win32.js';
import { MemoryMapHost, MemoryMapHostError } from '../../main/memory-map/host-win32.js';
import { readGraphCatalog, memoryFacets, graphMemoryRevision, isGraphMemory, matchesGraphRecord, memoryMapScopeId, type ReadMemoryMapCatalog } from '../../main/memory-map/catalog.js';
import { ProviderEmbeddings } from '../../main/memory-map/provider-embeddings-win32.js';
import { createMemoryProviderEgress } from '../../main/memory-map/provider-egress.js';
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from '../../shared/memory-embedding-config.js';
import { SettingsWriteRefusedError } from '../../data/settings-store.js';
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
type MemoryEmbeddingSettingsInput = z.infer<typeof WindowsMemoryEmbeddingSettingsSchema>;
type OnReplyAdmission = (assertLive: () => void) => void;

export interface MemoryMapRuntime {
  get(scope: MemoryMapScope | undefined): unknown;
  build(scope: MemoryMapScope | undefined, event: IpcMainInvokeEvent, onAdmission: OnReplyAdmission): unknown;
  cancel(): null;
  facets(scope: MemoryMapScope | undefined): unknown;
  retrieve(request: MemoryRetrievalRequest, onAdmission: OnReplyAdmission): unknown;
  modelStatus(onAdmission: OnReplyAdmission): unknown;
  modelDownload(event: IpcMainInvokeEvent, onAdmission: OnReplyAdmission): unknown;
  modelCancel(): null;
  modelUseExisting(event: IpcMainInvokeEvent, onAdmission: OnReplyAdmission): unknown;
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
  const refreshLocalAdmission = async () => {
    const admission = await refreshLocalInferenceAdmission();
    return bindLocalEmbeddingRuntime(() => localRuntime(admission)).assertStillValid;
  };
  let buildGeneration = 0;
  let modelGeneration = 0;
  let settingsGeneration = 0;
  let settingsWrite: Promise<unknown> = Promise.resolve();
  let buildEvent: IpcMainInvokeEvent | undefined;
  const model = new LocalModelManager({
    refreshAdmission: refreshLocalAdmission,
    downloadFile: downloadModelFile,
    readPath: () => deps.settingsService.get('memoryEmbedding')?.localModelPath,
    savePath: async (path, assertStillValid) => {
      try {
        await deps.settingsService.set('memoryEmbedding', { ...deps.settingsService.get('memoryEmbedding'), localModelPath: path },
          { field: ['memoryEmbedding', 'localModelPath'], canCommit: () => { assertStillValid(); return true; } });
      } catch (error) {
        if (!(error instanceof SettingsWriteRefusedError)) throw error;
        assertStillValid();
        throw new MemoryMapHostError('local-runtime-unavailable');
      }
    },
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
    refreshLocalAdmission,
    runWorker: (folder, task, signal, onProgress, onAdmission) => runMemoryWorker(folder, task, signal, onProgress, onAdmission, localInferencePreference),
    validatedModelPath: async (signal, onAdmission) => {
      const admission = await refreshLocalInferenceAdmission();
      signal.throwIfAborted();
      const { assertStillValid } = bindLocalEmbeddingRuntime(() => localRuntime(admission));
      if (!deps.settingsService.get('memoryEmbedding')?.localModelPath) throw new MemoryMapHostError('model-unconfigured');
      const folder = await model.validatedPath();
      signal.throwIfAborted();
      assertStillValid();
      onAdmission?.(assertStillValid);
      return folder;
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
  const startModelOperation = async (
    generation: number,
    event: IpcMainInvokeEvent,
    start: (onProgress: (status: MemoryModelStatus) => void) => Promise<MemoryModelStatus>,
  ) => {
    const admission = await refreshLocalInferenceAdmission();
    assertCurrentModelRequest(generation);
    localRuntime(admission);
    cancelBuild();
    return start(status => {
      if (validateHostRendererSender(event)) sendToWebContents(event.sender, CHANNELS.memoryMap.modelProgress, status);
    });
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
    build: async (scope, event, onAdmission) => {
      const generation = ++buildGeneration;
      if (deps.settingsService.get('memoryEmbedding')?.source !== 'provider') {
        const admission = await refreshLocalInferenceAdmission();
        if (generation !== buildGeneration) throw new MemoryMapHostError('request-stale');
        localRuntime(admission);
      }
      buildEvent = event;
      return host.build(catalog(scope), assertLive => onAdmission(() => {
        if (generation !== buildGeneration) throw new MemoryMapHostError('request-stale');
        assertLive();
      }));
    },
    cancel: () => { cancelBuild(); return null; },
    facets: async scope => { await host.get(catalog(scope)); return memoryFacets(catalog(scope)().records); },
    retrieve: (request, onAdmission) => host.retrieve(catalog(request.scope), request, onAdmission),
    modelStatus: async onAdmission => {
      const assertStillValid = await refreshLocalAdmission();
      return model.status(assertStillValid, onAdmission);
    },
    modelDownload: (event, onAdmission) => startModelOperation(++modelGeneration, event, onProgress => model.download(onProgress, onAdmission)),
    modelCancel: () => { cancelModel(); return null; },
    modelUseExisting: async (event, onAdmission) => {
      const generation = ++modelGeneration;
      const admission = await refreshLocalInferenceAdmission();
      assertCurrentModelRequest(generation);
      localRuntime(admission);
      const selection = await pickNativeFiles({ properties: ['openDirectory'] });
      const folder = selection.filePaths[0];
      if (selection.canceled || !folder) return null;
      return startModelOperation(generation, event, onProgress => model.adoptExistingFolder(folder, onProgress, onAdmission));
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
          try {
            await deps.settingsService.set('memoryEmbedding', { ...previous, localInferenceWithoutSandbox: enabled },
              { field: ['memoryEmbedding', 'localInferenceWithoutSandbox'], canCommit: () => admission.areSwitchesAvailable() });
          } catch (error) {
            if (error instanceof SettingsWriteRefusedError) throw new MemoryMapHostError('local-runtime-unavailable');
            throw error;
          }
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
        try {
          await deps.settingsService.set('memoryEmbedding', {
            localModelPath: previous?.localModelPath,
            localInferenceWithoutSandbox: previous?.localInferenceWithoutSandbox,
            ...(input.source === 'local' ? { source: 'local' as const } : { source: 'provider' as const, providerId: input.providerId, modelId: input.modelId, consent }),
          }, { field: ['memoryEmbedding', 'source', 'providerId', 'modelId', 'consent'], canCommit: () => {
            if (generation !== settingsGeneration) return false;
            if (input.source === 'provider') provider.assertCurrentEndpoint(input.providerId, input.endpointId);
            return true;
          } });
        } catch (error) {
          if (error instanceof SettingsWriteRefusedError) throw new MemoryMapHostError('request-stale');
          throw error;
        }
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        await host.invalidate();
        if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
        provider.resume(); return settings();
      }).finally(() => { if (generation === settingsGeneration) provider.resume(); });
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
