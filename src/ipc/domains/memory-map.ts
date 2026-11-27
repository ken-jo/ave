import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender, auditUnauthorized, UNAUTHORIZED_FRAME } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryMapError } from '../../shared/memory-map.js';
import { MemoryMapScopeSchema, MemoryRetrievalSchema, MemoryEmbeddingSettingsSchema } from '../../shared/memory-map-validation.js';
import type { NoteEntry, ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
import type { MemoryMapRuntime } from './memory-map-runtime.js';

export type MemoryMapScopeResolver = (raw: unknown) => { ok: true; options: ProjectScopedMemoryOptions } | { ok: false; error: string };

// Registers the channels at startup; the host, model manager and provider load behind a dynamic import on the first request.
export function registerMemoryMapHandlers(deps: IpcDeps, resolveScope: MemoryMapScopeResolver) {
  let runtime: MemoryMapRuntime | undefined;
  let loading: Promise<MemoryMapRuntime> | undefined;
  const loadRuntime = (): Promise<MemoryMapRuntime> => {
    if (runtime) return Promise.resolve(runtime);
    loading ??= import('./memory-map-runtime.js').then(
      module => { runtime = module.createMemoryMapRuntime(deps, resolveScope); return runtime; },
      error => { loading = undefined; throw error; },
    );
    return loading;
  };
  function handle<T>(channel: string, schema: z.ZodType<T>, action: (current: MemoryMapRuntime, value: T, event: IpcMainInvokeEvent) => unknown) {
    ipcMain.handle(channel, async (event, raw: unknown, ...extra: unknown[]) => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return UNAUTHORIZED_FRAME; }
      const parsed = schema.safeParse(raw);
      if (!parsed.success || extra.length) return { ok: false, error: 'invalid-input' };
      const scope = channel === CHANNELS.memoryMap.retrieve ? (parsed.data as { scope?: MemoryMapScope }).scope : parsed.data;
      if ([CHANNELS.memoryMap.get, CHANNELS.memoryMap.build, CHANNELS.memoryMap.facets, CHANNELS.memoryMap.retrieve].includes(channel as never) && !resolveScope(scope).ok) return { ok: false, error: 'project-not-allowed' };
      let current: MemoryMapRuntime | undefined;
      try {
        current = await loadRuntime();
        return { ok: true, value: await action(current, parsed.data, event) };
      } catch (error) {
        return { ok: false, error: current?.errorCode(error) ?? ('graph-build-failed' satisfies MemoryMapError) };
      }
    });
  }
  handle(CHANNELS.memoryMap.get, MemoryMapScopeSchema.optional(), (current, scope) => current.get(scope));
  handle(CHANNELS.memoryMap.build, MemoryMapScopeSchema.optional(), (current, scope, event) => current.build(scope, event));
  handle(CHANNELS.memoryMap.cancel, z.undefined(), current => current.cancel());
  handle(CHANNELS.memoryMap.facets, MemoryMapScopeSchema.optional(), (current, scope) => current.facets(scope));
  handle(CHANNELS.memoryMap.retrieve, MemoryRetrievalSchema, (current, request) => current.retrieve(request));
  handle(CHANNELS.memoryMap.modelStatus, z.undefined(), current => current.modelStatus());
  handle(CHANNELS.memoryMap.modelDownload, z.undefined(), (current, _value, event) => current.modelDownload(event));
  handle(CHANNELS.memoryMap.modelCancel, z.undefined(), current => current.modelCancel());
  handle(CHANNELS.memoryMap.modelUseExisting, z.undefined(), (current, _value, event) => current.modelUseExisting(event));
  handle(CHANNELS.memoryMap.settingsGet, z.undefined(), current => current.settingsGet());
  handle(CHANNELS.memoryMap.settingsSet, MemoryEmbeddingSettingsSchema, (current, input) => current.settingsSet(input));
  // Before the first request no catalog has been read, so there is no source to locate.
  return (id: string, rawScope: unknown, contentRevision: string): NoteEntry | undefined =>
    runtime?.readSource(id, rawScope, contentRevision);
}
