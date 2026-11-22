import { ipcMain, dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { permissionSettingsPath } from '../../permissions/permission-settings-store.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender, auditUnauthorized, UNAUTHORIZED_FRAME } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryEmbeddingSettings, MemoryMapError } from '../../shared/memory-map.js';
import { MemoryMapScopeSchema, MemoryRetrievalSchema, MemoryEmbeddingSettingsSchema } from '../../shared/memory-map-validation.js';
import { LocalModelManager, MemoryModelError } from '../../main/memory-map/model-manager.js';
import { MemoryMapHost, MemoryMapHostError } from '../../main/memory-map/host.js';
import { readGraphCatalog, memoryFacets, matchesGraphRecord, memoryMapScopeId, type ReadMemoryMapCatalog } from '../../main/memory-map/catalog.js';
import { ProviderEmbeddings } from '../../main/memory-map/provider-embeddings.js';
import { createMemoryProviderEgress } from '../../main/memory-map/provider-egress.js';
import { getLlmVendorSettings, LLM_VENDORS } from '../../shared/llm-vendor-defaults.js';
import { defaultWorkspaceProject } from '../../main/project-root-authorization.js';
import { sendToWebContents } from '../safe-send.js';
import type { ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
const MEMORY_EMBEDDING_ALLOWED_DOMAINS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  ...LLM_VENDORS.flatMap(vendor => {
    const url = getLlmVendorSettings(undefined, vendor).baseUrl;
    return url?.startsWith('https:') ? [new URL(url).hostname] : [];
  }),
];
type ScopeResolver = (raw: unknown) => { ok: true; options: ProjectScopedMemoryOptions } | { ok: false; error: string };
export function registerMemoryMapHandlers(deps: IpcDeps, resolveScope: ScopeResolver): void {
  const send = createMemoryProviderEgress(deps.singleHopNetworkFetch, MEMORY_EMBEDDING_ALLOWED_DOMAINS, entry => {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: 'memory-embeddings',
      type: 'tool_call',
      input: entry.allowed ? `host_fetch ${entry.origin} method=${entry.method}` : `host_fetch denied: ${entry.reason}`,
    });
  });
  const provider = new ProviderEmbeddings(deps.settingsService, send);
  let settingsGeneration = 0;
  let settingsWrite: Promise<unknown> = Promise.resolve();
  let buildEvent: IpcMainInvokeEvent | undefined; let modelEvent: IpcMainInvokeEvent | undefined;
  const model = new LocalModelManager({
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
  const host = new MemoryMapHost({ provider, watchAuthority, validatedModelPath: () => { if (!deps.settingsService.get('memoryEmbedding')?.localModelPath) throw new MemoryMapHostError('model-unconfigured'); return model.validatedPath(); }, onProgress: progress => {
    if (buildEvent && validateHostRendererSender(buildEvent)) sendToWebContents(buildEvent.sender, CHANNELS.memoryMap.progress, progress);
  } });
  const catalog = (scope?: MemoryMapScope): ReadMemoryMapCatalog => {
    const filenames = new Map<string, string>();
    const read: ReadMemoryMapCatalog = () => {
      const result = resolveScope(scope);
      if (!result.ok) { host.cancel(); throw new MemoryMapHostError('project-not-allowed'); }
      filenames.clear();
      return readGraphCatalog(deps.memoryManager, result.options, defaultWorkspaceProject().projectRoot, filenames);
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
    const consent = provider.currentConsent();
    const providers = await provider.providers();
    const namespace = provider.namespace();
    return { source: namespace.source, namespace, providers, providerAvailable: providers.some(value => value.models.length > 0), ...(consent ? { consent } : {}) };
  };
  function handle<T>(channel: string, schema: z.ZodType<T>, action: (value: T, event: IpcMainInvokeEvent) => unknown) {
    ipcMain.handle(channel, async (event, raw: unknown, ...extra: unknown[]) => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return UNAUTHORIZED_FRAME; }
      const parsed = schema.safeParse(raw);
      if (!parsed.success || extra.length) return { ok: false, error: 'invalid-input' };
      const scope = channel === CHANNELS.memoryMap.retrieve ? (parsed.data as { scope?: MemoryMapScope }).scope : parsed.data;
      if ([CHANNELS.memoryMap.get, CHANNELS.memoryMap.build, CHANNELS.memoryMap.facets, CHANNELS.memoryMap.retrieve].includes(channel as never) && !resolveScope(scope).ok) return { ok: false, error: 'project-not-allowed' };
      try { return { ok: true, value: await action(parsed.data, event) }; }
      catch (error) {
        if (error instanceof MemoryModelError || error instanceof MemoryMapHostError) return { ok: false, error: error.code };
        return { ok: false, error: 'graph-build-failed' satisfies MemoryMapError };
      }
    });
  }
  handle(CHANNELS.memoryMap.get, MemoryMapScopeSchema.optional(), scope => host.get(catalog(scope)));
  handle(CHANNELS.memoryMap.build, MemoryMapScopeSchema.optional(), (scope, event) => { buildEvent = event; return host.build(catalog(scope)); });
  handle(CHANNELS.memoryMap.cancel, z.undefined(), () => { host.cancel(); return null; });
  handle(CHANNELS.memoryMap.facets, MemoryMapScopeSchema.optional(), async scope => { await host.get(catalog(scope)); return memoryFacets(catalog(scope)().records); });
  handle(CHANNELS.memoryMap.retrieve, MemoryRetrievalSchema, request => host.retrieve(catalog(request.scope), request));
  handle(CHANNELS.memoryMap.modelStatus, z.undefined(), () => model.status());
  handle(CHANNELS.memoryMap.modelDownload, z.undefined(), (_value, event) => { host.cancel(); modelEvent = event; return model.download(); });
  handle(CHANNELS.memoryMap.modelCancel, z.undefined(), () => { model.cancel(); return null; });
  handle(CHANNELS.memoryMap.modelUseExisting, z.undefined(), async (_value, event) => {
    const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    host.cancel(); modelEvent = event; return model.useExisting(selection.filePaths[0]);
  });
  handle(CHANNELS.memoryMap.settingsGet, z.undefined(), settings);
  handle(CHANNELS.memoryMap.settingsSet, MemoryEmbeddingSettingsSchema, async input => {
    const generation = ++settingsGeneration;
    provider.suspend(); host.cancel();
    const pending = settingsWrite.catch(() => {}).then(async () => {
      if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
      if (input.source === 'provider' && !input.consent) throw new MemoryMapHostError('provider-consent-required');
      const consent = input.source === 'provider' ? await provider.issueConsent(input.providerId, input.modelId) : undefined;
      if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
      const previous = deps.settingsService.get('memoryEmbedding');
      await deps.settingsService.set('memoryEmbedding', {
        ...(previous?.localModelPath ? { localModelPath: previous.localModelPath } : {}),
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
  });
}
