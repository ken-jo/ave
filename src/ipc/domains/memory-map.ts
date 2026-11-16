import { ipcMain, dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender, auditUnauthorized, UNAUTHORIZED_FRAME } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryEmbeddingSettings, MemoryMapError } from '../../shared/memory-map.js';
import { MemoryMapScopeSchema, MemoryRetrievalSchema, MemoryEmbeddingSettingsSchema } from '../../shared/memory-map-validation.js';
import { LocalModelManager, MemoryModelError } from '../../main/memory-map/model-manager.js';
import { MemoryMapHost, MemoryMapHostError } from '../../main/memory-map/host.js';
import { readGraphCatalog, memoryFacets } from '../../main/memory-map/catalog.js';
import { MEMORY_EMBEDDING_CONSENT_VERSION } from '../../shared/memory-embedding-config.js';
import { ProviderEmbeddings } from '../../main/memory-map/provider-embeddings.js';
import { defaultWorkspaceProject } from '../../main/project-root-authorization.js';
import { sendToWebContents } from '../safe-send.js';
import type { ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
type ScopeResolver = (raw: unknown) => { ok: true; options: ProjectScopedMemoryOptions } | { ok: false; error: string };
export function registerMemoryMapHandlers(deps: IpcDeps, resolveScope: ScopeResolver): void {
  const provider = new ProviderEmbeddings(deps.settingsService, deps.singleHopNetworkFetch);
  let settingsGeneration = 0;
  let settingsWrite: Promise<unknown> = Promise.resolve();
  let buildEvent: IpcMainInvokeEvent | undefined; let modelEvent: IpcMainInvokeEvent | undefined;
  const model = new LocalModelManager({
    readPath: () => deps.settingsService.get('memoryEmbedding')?.localModelPath,
    savePath: path => deps.settingsService.set('memoryEmbedding', { ...deps.settingsService.get('memoryEmbedding'), localModelPath: path }),
    onProgress: status => { if (modelEvent && validateHostRendererSender(modelEvent)) sendToWebContents(modelEvent.sender, CHANNELS.memoryMap.modelProgress, status); },
  });
  const host = new MemoryMapHost({ provider, validatedModelPath: () => { if (!deps.settingsService.get('memoryEmbedding')?.localModelPath) throw new MemoryMapHostError('model-unconfigured'); return model.validatedPath(); }, onProgress: progress => {
    if (buildEvent && validateHostRendererSender(buildEvent)) sendToWebContents(buildEvent.sender, CHANNELS.memoryMap.progress, progress);
  } });
  const catalog = (scope?: MemoryMapScope) => () => {
    const result = resolveScope(scope);
    if (!result.ok) { host.cancel(); throw new MemoryMapHostError('project-not-allowed'); }
    return readGraphCatalog(deps.memoryManager, result.options, defaultWorkspaceProject().projectRoot);
  };
  const settings = async (): Promise<MemoryEmbeddingSettings> => {
    const config = deps.settingsService.get('memoryEmbedding');
    const providers = await provider.providers();
    const namespace = provider.namespace();
    return { source: namespace.source, namespace, providers, providerAvailable: providers.some(value => value.models.length > 0), ...(config?.consent ? { consent: config.consent } : {}) };
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
      if (input.source === 'provider') {
        if (!input.consent) throw new MemoryMapHostError('provider-consent-required');
        await provider.validate(input.providerId, input.modelId);
      }
      if (generation !== settingsGeneration) throw new MemoryMapHostError('request-stale');
      const previous = deps.settingsService.get('memoryEmbedding');
      await deps.settingsService.set('memoryEmbedding', {
        ...(previous?.localModelPath ? { localModelPath: previous.localModelPath } : {}),
        ...input.source === 'local' ? { source: 'local' as const } : {
          source: 'provider' as const, providerId: input.providerId, modelId: input.modelId,
          consent: { version: MEMORY_EMBEDDING_CONSENT_VERSION, providerId: input.providerId, modelId: input.modelId, timestamp: new Date().toISOString() },
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
