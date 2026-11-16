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
import { LOCAL_NAMESPACE } from '../../main/memory-map/graph.js';
import { defaultWorkspaceProject } from '../../main/project-root-authorization.js';
import { sendToWebContents } from '../safe-send.js';
import type { ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
type ScopeResolver = (raw: unknown) => { ok: true; options: ProjectScopedMemoryOptions } | { ok: false; error: string };
export function registerMemoryMapHandlers(deps: IpcDeps, resolveScope: ScopeResolver): void {
  let buildEvent: IpcMainInvokeEvent | undefined; let modelEvent: IpcMainInvokeEvent | undefined;
  const model = new LocalModelManager({
    readPath: () => deps.settingsService.get('memoryEmbedding')?.localModelPath,
    savePath: path => deps.settingsService.set('memoryEmbedding', { localModelPath: path }),
    onProgress: status => { if (modelEvent && validateHostRendererSender(modelEvent)) sendToWebContents(modelEvent.sender, CHANNELS.memoryMap.modelProgress, status); },
  });
  const host = new MemoryMapHost({ validatedModelPath: () => { if (!deps.settingsService.get('memoryEmbedding')?.localModelPath) throw new MemoryMapHostError('model-unconfigured'); return model.validatedPath(); }, onProgress: progress => {
    if (buildEvent && validateHostRendererSender(buildEvent)) sendToWebContents(buildEvent.sender, CHANNELS.memoryMap.progress, progress);
  } });
  const catalog = (scope?: MemoryMapScope) => () => {
    const result = resolveScope(scope);
    if (!result.ok) { host.cancel(); throw new MemoryMapHostError('project-not-allowed'); }
    return readGraphCatalog(deps.memoryManager, result.options, defaultWorkspaceProject().projectRoot);
  };
  const settings = (): MemoryEmbeddingSettings => ({ source: 'local', namespace: LOCAL_NAMESPACE, providerAvailable: false });
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
        const filesystem = error as NodeJS.ErrnoException;
        if (filesystem.code || (error instanceof Error && /Memory worker/.test(error.message))) return { ok: false, error: 'graph-build-failed' satisfies MemoryMapError };
        throw error;
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
  handle(CHANNELS.memoryMap.settingsSet, MemoryEmbeddingSettingsSchema, input => {
    if (input.source !== 'local') throw new MemoryMapHostError('provider-unavailable');
    host.cancel(); return settings();
  });
}
