import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { renameDirectoryOnce } from '../../lib/transient-fs-lock-retry.js';
import { openFeatureNamespace, type FeatureNamespaceHandle } from '../storage/feature-namespace.js';
import { MODEL_FILES, LOCAL_MODEL_REVISION, modelFileUrl, type ModelFile } from './model-manifest.js';
import type { MemoryModelStatus, MemoryModelError as ModelErrorCode } from '../../shared/memory-model.js';

const MODEL_SLOT_PARENT = 'multilingual-e5-small';
const SLOT_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RECOVERY_SLOT_NAME = new RegExp(`^${LOCAL_MODEL_REVISION}-${SLOT_ID_PATTERN}$`, 'iu');
const STAGING_SLOT_NAME = new RegExp(`^${LOCAL_MODEL_REVISION}\\.tmp-${SLOT_ID_PATTERN}$`, 'iu');
const buildsByModelPath = new Map<string, number>();

export function registerModelBuild(folder: string): () => void {
  buildsByModelPath.set(folder, (buildsByModelPath.get(folder) ?? 0) + 1);
  return () => {
    const count = buildsByModelPath.get(folder) ?? 0;
    if (count > 1) buildsByModelPath.set(folder, count - 1);
    else buildsByModelPath.delete(folder);
  };
}

function isWithinDirectory(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return !isAbsolute(fromDirectory) && fromDirectory !== '..' && !fromDirectory.startsWith(`..${sep}`);
}

function recoverySlotName(parent: string, path: string | undefined): string | undefined {
  const name = path && relative(parent, path).split(sep)[0];
  return name && RECOVERY_SLOT_NAME.test(name) ? name : undefined;
}

function logModelCleanupError(error: unknown): void {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown';
  console.warn('[memory-map] Could not clean up a model slot', code);
}

export class MemoryModelError extends Error {
  constructor(readonly code: ModelErrorCode) { super(code); this.name = 'MemoryModelError'; }
}
export async function verifyModelFolder(folder: string, files: readonly ModelFile[] = MODEL_FILES, signal?: AbortSignal): Promise<string> {
  for (const root of [join(folder, 'onnx'), folder]) {
    let valid = true;
    for (const file of files) {
      signal?.throwIfAborted();
      try {
        const info = await lstat(join(root, file.name));
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) { valid = false; break; }
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(join(root, file.name), { signal })) hash.update(chunk);
        if (hash.digest('hex') !== file.sha256) { valid = false; break; }
      } catch (error) { if (signal?.aborted) throw error; valid = false; break; }
    }
    if (valid) return realpath(root);
  }
  throw new MemoryModelError('model-integrity-failed');
}
interface ModelManagerOptions {
  namespace?: FeatureNamespaceHandle;
  files?: readonly ModelFile[];
  downloadFile?: (name: string, signal: AbortSignal) => Promise<Response>;
  readPath: () => string | undefined;
  savePath: (path: string) => void | Promise<void>;
  onProgress?: (status: MemoryModelStatus) => void;
}
export class LocalModelManager {
  private readonly namespace: FeatureNamespaceHandle;
  private readonly files: readonly ModelFile[];
  private controller?: AbortController;
  private task: Promise<MemoryModelStatus> = Promise.resolve(this.empty());
  private generation = 0;
  private state: MemoryModelStatus = this.empty();
  constructor(private readonly options: ModelManagerOptions) {
    this.namespace = options.namespace ?? openFeatureNamespace('models');
    this.files = options.files ?? MODEL_FILES;
  }
  private empty(): MemoryModelStatus {
    return { status: 'unconfigured', receivedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 4 };
  }
  private publish(state: MemoryModelStatus): MemoryModelStatus { this.state = state; this.options.onProgress?.({ ...state }); return { ...state }; }
  cancel(): void { this.generation++; this.controller?.abort(); }
  private async checkedDirectory(path: string): Promise<string | undefined> {
    try {
      if (!(await lstat(path)).isDirectory()) throw new MemoryModelError('model-integrity-failed');
      const expected = join(await realpath(dirname(path)), basename(path));
      const actual = await realpath(path);
      if (relative(expected, actual) !== '') throw new MemoryModelError('model-integrity-failed');
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async isManagedPath(folder: string): Promise<boolean> {
    const root = await this.checkedDirectory(this.namespace.dir);
    return root !== undefined && isWithinDirectory(root, folder);
  }
  async validatedPath(): Promise<string> {
    const path = this.options.readPath();
    if (!path) throw new MemoryModelError('model-folder-invalid');
    const folder = await verifyModelFolder(path, this.files);
    // A save during validation may have retired this slot.
    if (!(await this.isManagedPath(folder)) || this.options.readPath() !== path) throw new MemoryModelError('model-integrity-failed');
    return folder;
  }
  async status(): Promise<MemoryModelStatus> {
    if (this.state.status === 'downloading' || this.state.status === 'failed') return { ...this.state };
    const path = this.options.readPath();
    if (!path) return { ...this.state };
    try {
      const folder = await verifyModelFolder(path, this.files);
      const status = await this.isManagedPath(folder) ? 'ready' : 'legacy-location';
      return this.publish({ ...this.state, status, error: undefined });
    }
    catch { return this.publish({ ...this.state, status: 'failed', error: 'model-integrity-failed' }); }
  }
  private run(action: (signal: AbortSignal) => Promise<void>, sourceFolder?: string): Promise<MemoryModelStatus> {
    this.cancel();
    const generation = this.generation;
    const previous = this.task;
    const controller = new AbortController();
    this.controller = controller;
    this.task = (async () => {
      await previous;
      if (generation !== this.generation) return { ...this.state };
      try {
        await this.sweepModelSlots([RECOVERY_SLOT_NAME, STAGING_SLOT_NAME], sourceFolder);
        controller.signal.throwIfAborted();
        await action(controller.signal);
        controller.signal.throwIfAborted();
        return this.publish({ ...this.state, status: 'ready', error: undefined });
      } catch (error) {
        const code = controller.signal.aborted ? 'model-cancelled' : error instanceof MemoryModelError ? error.code : 'model-download-failed';
        return this.publish({ ...this.state, status: 'failed', error: code });
      }
    })();
    return this.task;
  }
  adoptExistingFolder(folder: string): Promise<MemoryModelStatus> {
    return this.run(async signal => {
      if (!folder) throw new MemoryModelError('model-folder-invalid');
      const path = await verifyModelFolder(folder, this.files, signal);
      if (await this.isManagedPath(path)) {
        signal.throwIfAborted();
        await this.saveManagedPath(path);
        return;
      }
      await this.install(signal, async (name, staging) => {
        for (const file of this.files) {
          signal.throwIfAborted();
          const handle = await this.namespace.createFile(`${name}/${file.name}`);
          try {
            let received = 0;
            for await (const chunk of createReadStream(join(path, file.name), { signal })) {
              const bytes = chunk as Buffer;
              received += bytes.length;
              if (received > file.bytes) throw new MemoryModelError('model-integrity-failed');
              await handle.writeFile(bytes);
            }
            await handle.sync();
          } finally { await handle.close(); }
        }
        await verifyModelFolder(staging, this.files, signal);
      });
    }, folder);
  }
  download(): Promise<MemoryModelStatus> {
    return this.run(signal => this.install(signal, async name => {
      this.publish({ status: 'downloading', receivedBytes: 0, totalBytes: this.files.reduce((n, f) => n + f.bytes, 0), completedFiles: 0, totalFiles: this.files.length });
      for (const file of this.files) {
        signal.throwIfAborted();
        const response = await (this.options.downloadFile
          ? this.options.downloadFile(file.name, signal)
          : fetch(modelFileUrl(file.name), { signal, redirect: 'follow' }));
        if (!response.ok || !response.body) throw new MemoryModelError('model-download-failed');
        const handle = await this.namespace.createFile(`${name}/${file.name}`);
        const hash = createHash('sha256');
        let received = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > file.bytes) throw new MemoryModelError('model-integrity-failed');
            hash.update(chunk.value);
            await handle.writeFile(chunk.value);
            this.publish({ ...this.state, receivedBytes: this.state.receivedBytes + chunk.value.byteLength });
          }
          if (received !== file.bytes || hash.digest('hex') !== file.sha256) throw new MemoryModelError('model-integrity-failed');
          await handle.sync();
        } finally { await reader.cancel().catch(() => {}); await handle.close(); }
        this.publish({ ...this.state, completedFiles: this.state.completedFiles + 1 });
      }
    }));
  }
  private async verifyManagedSlot(path: string, signal: AbortSignal): Promise<string> {
    const directory = await this.checkedDirectory(path);
    if (directory === undefined) throw new MemoryModelError('model-integrity-failed');
    await this.checkedDirectory(join(directory, 'onnx'));
    const folder = await verifyModelFolder(directory, this.files, signal);
    if (!(await this.isManagedPath(folder))) throw new MemoryModelError('model-integrity-failed');
    return folder;
  }

  private async removeModelSlot(parent: string, name: string): Promise<void> {
    if (!RECOVERY_SLOT_NAME.test(name) && !STAGING_SLOT_NAME.test(name)) return;
    try {
      const managedParent = await this.recoveryParent();
      if (managedParent === undefined || relative(managedParent, parent) !== '') return;
      const path = join(parent, name);
      if (!(await lstat(path)).isDirectory()) return;
      for (const folder of buildsByModelPath.keys()) {
        if (isWithinDirectory(path, folder)) return;
      }
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') logModelCleanupError(error);
    }
  }

  private async recoveryParent(): Promise<string | undefined> {
    const root = await this.checkedDirectory(this.namespace.dir);
    return root === undefined ? undefined : this.checkedDirectory(join(root, MODEL_SLOT_PARENT));
  }

  private async sweepModelSlots(patterns: readonly RegExp[], preservePath?: string): Promise<void> {
    try {
      const parent = await this.recoveryParent();
      if (parent === undefined) return;
      const namespaceParent = join(this.namespace.dir, MODEL_SLOT_PARENT);
      const protectedPaths: string[] = [];
      for (const path of [this.options.readPath(), preservePath]) {
        if (!path) continue;
        protectedPaths.push(path);
        // A non-ENOENT realpath failure skips the sweep before any deletion.
        try { protectedPaths.push(await realpath(path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      for (const name of await readdir(parent)) {
        if (!patterns.some(pattern => pattern.test(name))) continue;
        const slot = join(parent, name);
        const namespaceSlot = join(namespaceParent, name);
        if (protectedPaths.some(path => isWithinDirectory(slot, path) || isWithinDirectory(namespaceSlot, path))) continue;
        await this.removeModelSlot(parent, name);
      }
    } catch (error) { logModelCleanupError(error); }
  }

  private async saveManagedPath(path: string): Promise<void> {
    try { await this.options.savePath(path); }
    finally {
      try {
        const saved = this.options.readPath();
        if (saved && relative(path, saved) === '') {
          await this.sweepModelSlots([RECOVERY_SLOT_NAME], path);
        }
      } catch (error) { logModelCleanupError(error); }
    }
  }

  private async install(signal: AbortSignal, stage: (name: string, folder: string) => Promise<void>): Promise<void> {
    await this.checkedDirectory(this.namespace.dir);
    await this.checkedDirectory(join(this.namespace.dir, MODEL_SLOT_PARENT));
    await this.namespace.childDir(MODEL_SLOT_PARENT);
    const parent = await this.recoveryParent();
    if (parent === undefined) throw new MemoryModelError('model-integrity-failed');
    const previousRecovery = recoverySlotName(parent, this.options.readPath());
    if (previousRecovery !== undefined) {
      let validated: string | undefined;
      try { validated = await this.verifyManagedSlot(join(parent, previousRecovery), signal); }
      catch (error) { if (!(error instanceof MemoryModelError)) throw error; }
      signal.throwIfAborted();
      if (validated !== undefined) {
        await this.saveManagedPath(validated);
        return;
      }
    }
    const id = randomUUID();
    const name = `${MODEL_SLOT_PARENT}/${LOCAL_MODEL_REVISION}.tmp-${id}`;
    const staging = await this.namespace.childDir(name, { exclusive: true });
    let final = join(parent, LOCAL_MODEL_REVISION);
    let createdRecovery: string | undefined;
    try {
      await stage(name, staging);
      signal.throwIfAborted();
      let validated: string | undefined;
      try { await renameDirectoryOnce(staging, final); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        try { validated = await this.verifyManagedSlot(final, signal); }
        catch (validationError) {
          signal.throwIfAborted();
          if (!(validationError instanceof MemoryModelError)) throw validationError;
          const recovery = `${LOCAL_MODEL_REVISION}-${id}`;
          final = join(parent, recovery);
          await renameDirectoryOnce(staging, final);
          createdRecovery = recovery;
        }
      }
      validated ??= await this.verifyManagedSlot(final, signal);
      signal.throwIfAborted();
      await this.saveManagedPath(validated);
    } finally {
      await this.removeModelSlot(parent, basename(name));
      try {
        if (createdRecovery !== undefined && recoverySlotName(parent, this.options.readPath()) !== createdRecovery) {
          await this.removeModelSlot(parent, createdRecovery);
        }
      } catch (error) { logModelCleanupError(error); }
    }
  }
}
