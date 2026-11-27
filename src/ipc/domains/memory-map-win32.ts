import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CHANNELS } from '../../contract/app-contract.js';
import { validateHostRendererSender, auditUnauthorized, UNAUTHORIZED_FRAME } from '../gated.js';
import type { IpcDeps } from '../types.js';
import type { MemoryMapScope, MemoryMapError } from '../../shared/memory-map.js';
import { MemoryMapScopeSchema, MemoryRetrievalSchema, WindowsMemoryEmbeddingSettingsSchema } from '../../shared/memory-map-validation.js';
import type { NoteEntry, ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
import type { MemoryMapRuntime } from './memory-map-runtime-win32.js';
import { commitUnderAdmission } from '../../shared/admission-commit.js';
import { MemoryMapHostError } from '../../main/memory-map/errors.js';

export type MemoryMapScopeResolver = (raw: unknown) => { ok: true; options: ProjectScopedMemoryOptions } | { ok: false; error: string };
interface RequestAdmission { options?: ProjectScopedMemoryOptions; assert(): void }

const MemoryBuildIdSchema = z.uuidv4();
const MemoryBuildRequestSchema = z.strictObject({ scope: MemoryMapScopeSchema.optional(), buildId: MemoryBuildIdSchema });

// Registers the channels at startup; the host, model manager and provider load behind a dynamic import on the first request.
export function registerWindowsMemoryMapHandlers(deps: IpcDeps, resolveScope: MemoryMapScopeResolver) {
  let runtime: MemoryMapRuntime | undefined;
  let loading: Promise<MemoryMapRuntime> | undefined;
  const loadRuntime = (): Promise<MemoryMapRuntime> => {
    if (runtime) return Promise.resolve(runtime);
    loading ??= import('./memory-map-runtime-win32.js').then(
      module => { runtime = module.createMemoryMapRuntime(deps, resolveScope); return runtime; },
      error => { loading = undefined; throw error; },
    );
    return loading;
  };
  function handle<T>(channel: string, schema: z.ZodType<T>, action: (current: MemoryMapRuntime, value: T, event: IpcMainInvokeEvent,
    onAdmission: (assertLive: () => void) => void, admission: RequestAdmission) => unknown) {
    ipcMain.handle(channel, async (event, raw: unknown, ...extra: unknown[]) => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return UNAUTHORIZED_FRAME; }
      const parsed = schema.safeParse(raw);
      if (!parsed.success || extra.length) return { ok: false, error: 'invalid-input' };
      const scope = channel === CHANNELS.memoryMap.retrieve || channel === CHANNELS.memoryMap.build
        ? (parsed.data as { scope?: MemoryMapScope }).scope : parsed.data;
      const scoped = [CHANNELS.memoryMap.get, CHANNELS.memoryMap.build, CHANNELS.memoryMap.buildView, CHANNELS.memoryMap.facets, CHANNELS.memoryMap.retrieve].includes(channel as never);
      const original = scoped ? resolveScope(scope) : undefined;
      const projectDenied = { ok: false, error: 'project-not-allowed' } as const;
      if (original?.ok === false) return projectDenied;
      const assertRequestAdmitted = () => {
        if (!validateHostRendererSender(event)) {
          auditUnauthorized(deps.auditLogger, channel, event);
          throw new MemoryMapHostError('unauthorized-frame');
        }
        if (original?.ok) {
          const latest = resolveScope(scope);
          if (!latest.ok || !isDeepStrictEqual(latest.options, original.options)) throw new MemoryMapHostError('project-not-allowed');
        }
      };
      let current: MemoryMapRuntime | undefined;
      try {
        current = await loadRuntime();
        assertRequestAdmitted();
        let assertReply: (() => void) | undefined;
        const value = await action(current, parsed.data, event, assertLive => { assertReply = assertLive; },
          { options: original?.options, assert: assertRequestAdmitted });
        return commitUnderAdmission(() => { assertRequestAdmitted(); assertReply?.(); }, () => ({ ok: true, value }));
      } catch (error) {
        if (error instanceof MemoryMapHostError && error.code === 'unauthorized-frame') return UNAUTHORIZED_FRAME;
        try { assertRequestAdmitted(); } catch (denial) {
          if (denial instanceof MemoryMapHostError) return { ok: false, error: denial.code };
          throw denial;
        }
        return { ok: false, error: error instanceof MemoryMapHostError ? error.code : current?.errorCode(error) ?? ('graph-build-failed' satisfies MemoryMapError) };
      }
    });
  }
  handle(CHANNELS.memoryMap.get, MemoryMapScopeSchema.optional(), (current, scope) => current.get(scope));
  handle(CHANNELS.memoryMap.buildView, MemoryMapScopeSchema.optional(), (current, scope) => current.buildView(scope));
  handle(CHANNELS.memoryMap.build, MemoryBuildRequestSchema, (current, { scope, buildId }, event, onAdmission, { options, assert }) => {
    if (!options) throw new MemoryMapHostError('project-not-allowed');
    return current.build(scope, buildId, event, onAdmission, options, assert);
  });
  handle(CHANNELS.memoryMap.cancel, MemoryBuildIdSchema, (current, buildId) => current.cancel(buildId));
  handle(CHANNELS.memoryMap.facets, MemoryMapScopeSchema.optional(), (current, scope) => current.facets(scope));
  handle(CHANNELS.memoryMap.retrieve, MemoryRetrievalSchema, (current, request, _event, onAdmission) => current.retrieve(request, onAdmission));
  handle(CHANNELS.memoryMap.modelStatus, z.undefined(), (current, _value, _event, onAdmission) => current.modelStatus(onAdmission));
  handle(CHANNELS.memoryMap.modelDownload, z.undefined(), (current, _value, event, onAdmission) => current.modelDownload(event, onAdmission));
  handle(CHANNELS.memoryMap.modelCancel, z.undefined(), current => current.modelCancel());
  handle(CHANNELS.memoryMap.modelUseExisting, z.undefined(), (current, _value, event, onAdmission) => current.modelUseExisting(event, onAdmission));
  handle(CHANNELS.memoryMap.settingsGet, z.undefined(), current => current.settingsGet());
  handle(CHANNELS.memoryMap.settingsSet, WindowsMemoryEmbeddingSettingsSchema, (current, input) => current.settingsSet(input));
  // Before the first request no catalog has been read, so there is no source to locate.
  return (id: string, rawScope: unknown, contentRevision: string): NoteEntry | undefined =>
    runtime?.readSource(id, rawScope, contentRevision);
}
