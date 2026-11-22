import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, writeFile, open, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModelManager, verifyModelFolder } from '../model-manager.js';
import { LOCAL_MODEL_REVISION } from '../model-manifest.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body = 'model', namespaceName = '', beforeSave?: () => void) {
  const root = await mkdtemp(join(tmpdir(), 'memory-model-')); roots.push(root);
  const files = [{ name: 'weights.bin', bytes: 5, sha256: createHash('sha256').update('model').digest('hex') }];
  const namespaceDir = join(root, namespaceName);
  let saved: string | undefined;
  const namespace: FeatureNamespaceHandle = {
    dir: namespaceDir, readJson: async (_, fallback) => fallback, writeJson: async () => {},
    childDir: async name => { const path = join(namespaceDir, name); await mkdir(path, { recursive: true }); return path; },
    createFile: name => open(join(namespaceDir, name), 'wx'),
  };
  const server = createServer((_, response) => { response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const manager = new LocalModelManager({ namespace, files, readPath: () => saved, savePath: path => { beforeSave?.(); saved = path; }, downloadFile: (_, signal) => fetch(`http://127.0.0.1:${port}`, { signal }) });
  return { manager, root, files, saved: () => saved, setSaved: (path: string) => { saved = path; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function linkedFixture(beforeSave?: () => void) {
  const f = await fixture('model', 'via-link/ave/models', beforeSave);
  try {
    const realRoot = join(f.root, 'real-root');
    const parent = join(realRoot, 'ave', 'models', 'multilingual-e5-small');
    const canonical = join(parent, LOCAL_MODEL_REVISION);
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, 'weights.bin'), 'wrong');
    await symlink(realRoot, join(f.root, 'via-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const external = join(f.root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'weights.bin'), 'model');
    return { ...f, parent, external };
  } catch (error) {
    await f.close();
    throw error;
  }
}
describe('local model lifecycle', () => {
  it('reuses a verified recovery slot when the Ave home has a linked ancestor', async () => {
    const f = await linkedFixture();
    try {
      expect(await f.manager.adoptExistingFolder(f.external)).toMatchObject({ status: 'ready' });
      const recovery = await f.manager.validatedPath();
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      expect(await f.manager.adoptExistingFolder(f.external)).toMatchObject({ status: 'ready' });
      expect(f.saved()).toBe(recovery);
      expect((await readdir(f.parent)).sort()).toEqual([LOCAL_MODEL_REVISION, basename(recovery)].sort());
    } finally { await f.close(); }
  });

  it('removes an unpublished slot after a save failure under a linked Ave home ancestor', async () => {
    const f = await linkedFixture(() => { throw new Error('Save failed'); });
    try {
      f.setSaved(f.external);
      expect(await f.manager.adoptExistingFolder(f.external)).toMatchObject({ status: 'failed', error: 'model-download-failed' });
      expect(f.saved()).toBe(f.external);
      expect(await readdir(f.parent)).toEqual([LOCAL_MODEL_REVISION]);
    } finally { await f.close(); }
  });

  it('keeps the saved model ready when a superseded slot cannot be removed', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const canonical = await f.manager.validatedPath();
      const parent = dirname(canonical);
      const busy = join(parent, `${LOCAL_MODEL_REVISION}-11111111-1111-4111-8111-111111111111`);
      const stale = join(parent, `${LOCAL_MODEL_REVISION}-22222222-2222-4222-8222-222222222222`);
      await mkdir(busy);
      await mkdir(stale);
      f.setSaved(busy);

      const { rm: remove } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await vi.mocked(rm).withImplementation(async (path, options) => {
        if (path === busy) throw Object.assign(new Error('Slot is busy'), { code: 'EBUSY' });
        await remove(path, options);
      }, async () => {
        expect(await f.manager.adoptExistingFolder(canonical)).toMatchObject({ status: 'ready', error: undefined });
      });
      expect(f.saved()).toBe(canonical);
      expect(await f.manager.status()).toMatchObject({ status: 'ready', error: undefined });
      expect(await f.manager.validatedPath()).toBe(canonical);
      expect((await readdir(parent)).sort()).toEqual([LOCAL_MODEL_REVISION, basename(busy)].sort());
      expect(log).toHaveBeenCalledWith('[memory-map] Could not clean up a model slot', 'EBUSY');
    } finally { log.mockRestore(); await f.close(); }
  });

  it.each(['staging', 'unpublished'] as const)('sweeps the %s folder left by failed cleanup on the next setup', async leftover => {
    const f = await linkedFixture(() => { throw new Error('Save failed'); });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const canonical = join(f.parent, LOCAL_MODEL_REVISION);
      const published = join(f.parent, `${LOCAL_MODEL_REVISION}-11111111-1111-4111-8111-111111111111`);
      const linked = join(f.parent, `${LOCAL_MODEL_REVISION}-22222222-2222-4222-8222-222222222222`);
      await mkdir(published);
      await writeFile(join(published, 'weights.bin'), 'wrong');
      await symlink(f.external, linked, process.platform === 'win32' ? 'junction' : 'dir');
      f.setSaved(published);
      if (leftover === 'staging') await writeFile(join(canonical, 'weights.bin'), 'model');
      const originalEntries = (await readdir(f.parent)).sort();
      const prefix = leftover === 'staging' ? `${LOCAL_MODEL_REVISION}.tmp-` : `${LOCAL_MODEL_REVISION}-`;
      const { rm: remove } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await vi.mocked(rm).withImplementation(async (path, options) => {
        const name = basename(String(path));
        if (name.startsWith(prefix) && !originalEntries.includes(name)) {
          throw Object.assign(new Error(`Busy path ${path}`), { code: 'EBUSY' });
        }
        await remove(path, options);
      }, async () => {
        expect(await f.manager.adoptExistingFolder(f.external)).toMatchObject({ status: 'failed', error: 'model-download-failed' });
      });
      const abandoned = (await readdir(f.parent)).filter(name => !originalEntries.includes(name));
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0].startsWith(prefix)).toBe(true);
      expect(log).toHaveBeenCalledWith('[memory-map] Could not clean up a model slot', 'EBUSY');

      const nextSource = join(f.root, 'missing-model');
      expect(await f.manager.adoptExistingFolder(nextSource)).toMatchObject({ status: 'failed', error: 'model-integrity-failed' });
      expect((await readdir(f.parent)).sort()).toEqual(originalEntries);
      expect(f.saved()).toBe(published);
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(f.external, 'weights.bin'), 'utf8')).toBe('model');
    } finally { log.mockRestore(); await f.close(); }
  });

  it('preserves an unpublished managed folder selected for adoption', async () => {
    const f = await linkedFixture();
    try {
      const name = `${LOCAL_MODEL_REVISION}-11111111-1111-4111-8111-111111111111`;
      const selected = join(f.parent, name);
      await mkdir(selected);
      await writeFile(join(selected, 'weights.bin'), 'model');
      const alias = join(f.root, 'via-link', 'ave', 'models', 'multilingual-e5-small', name);
      expect(await f.manager.adoptExistingFolder(alias)).toMatchObject({ status: 'ready' });
      expect(f.saved()).toBe(selected);
    } finally { await f.close(); }
  });

  it('does not request files on status, and commits only a complete verified download', async () => {
    const f = await fixture();
    try {
      expect((await f.manager.status()).status).toBe('unconfigured');
      expect(f.saved()).toBeUndefined();
      expect(await f.manager.download()).toMatchObject({ status: 'ready', completedFiles: 1, receivedBytes: 5 });
      const saved = f.saved();
      assert.ok(saved);
      expect(await readFile(join(saved, 'weights.bin'), 'utf8')).toBe('model');
      expect((await f.manager.status()).status).toBe('ready');
    } finally { await f.close(); }
  });
  it.each(['wrong', 'mod'])('refuses corrupt and partial bytes without saving a path (%s)', async body => {
    const f = await fixture(body);
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'failed', error: 'model-integrity-failed' });
      expect(f.saved()).toBeUndefined();
      expect(await readdir(join(f.root, 'multilingual-e5-small'))).toEqual([]);
    } finally { await f.close(); }
  });
  it('accepts direct and nested files and refuses a bad existing folder', async () => {
    const f = await fixture();
    try {
      const external = await mkdtemp(join(tmpdir(), 'existing-model-')); roots.push(external);
      const nested = join(external, 'onnx'); await mkdir(nested); await writeFile(join(nested, 'weights.bin'), 'model');
      expect(await verifyModelFolder(external, f.files)).toBe(await verifyModelFolder(nested, f.files));
      expect((await f.manager.adoptExistingFolder(external)).status).toBe('ready');
      const active = await f.manager.validatedPath();
      expect(isAbsolute(relative(f.root, active))).toBe(false);
      expect(relative(f.root, active)).not.toMatch(/^\.\./u);
      expect(active).toBe(f.saved());
      await writeFile(join(nested, 'weights.bin'), 'wrong');
      expect(await f.manager.adoptExistingFolder(nested)).toMatchObject({ status: 'failed', error: 'model-integrity-failed' });
      expect(await readFile(join(active, 'weights.bin'), 'utf8')).toBe('model');
    } finally { await f.close(); }
  });
  it.each(['adoption', 'download'] as const)('recovers a corrupt managed slot through %s', async action => {
    const f = await fixture();
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const corrupt = f.saved();
      assert.ok(corrupt);
      await writeFile(join(corrupt, 'weights.bin'), 'wrong');
      const external = await mkdtemp(join(tmpdir(), 'legacy-model-'));
      roots.push(external);
      await writeFile(join(external, 'weights.bin'), 'model');
      f.setSaved(external);

      const result = await (action === 'adoption' ? f.manager.adoptExistingFolder(external) : f.manager.download());
      expect(result).toMatchObject({ status: 'ready' });
      const active = await f.manager.validatedPath();
      expect(active).toBe(f.saved());
      expect(active).not.toBe(external);
      expect(active).not.toBe(corrupt);
      expect(await readFile(join(active, 'weights.bin'), 'utf8')).toBe('model');
      expect(await readFile(join(corrupt, 'weights.bin'), 'utf8')).toBe('wrong');
    } finally { await f.close(); }
  });
  it('reuses a valid revision slot', async () => {
    const f = await fixture();
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const installed = f.saved();
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      expect(await f.manager.validatedPath()).toBe(installed);
      expect(await readdir(join(f.root, 'multilingual-e5-small'))).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('reuses the verified recovery slot across adoption, download and adoption', async () => {
    const f = await fixture();
    try {
      const parent = join(f.root, 'multilingual-e5-small');
      const canonical = join(parent, LOCAL_MODEL_REVISION);
      await mkdir(canonical, { recursive: true });
      await writeFile(join(canonical, 'weights.bin'), 'wrong');
      const orphan = join(parent, `${LOCAL_MODEL_REVISION}-11111111-1111-4111-8111-111111111111`);
      await mkdir(orphan);
      await writeFile(join(orphan, 'weights.bin'), 'model');
      const external = await mkdtemp(join(tmpdir(), 'legacy-model-')); roots.push(external);
      await writeFile(join(external, 'weights.bin'), 'model');

      expect(await f.manager.adoptExistingFolder(external)).toMatchObject({ status: 'ready' });
      const recovery = await f.manager.validatedPath();
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      expect(await f.manager.adoptExistingFolder(external)).toMatchObject({ status: 'ready' });
      expect(await f.manager.validatedPath()).toBe(recovery);
      expect((await readdir(parent)).sort()).toEqual([LOCAL_MODEL_REVISION, basename(recovery)].sort());
      expect(await readFile(join(canonical, 'weights.bin'), 'utf8')).toBe('wrong');
    } finally { await f.close(); }
  });
  it('removes a superseded corrupt recovery slot and preserves external paths and junction targets', async () => {
    const f = await fixture();
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const canonical = await f.manager.validatedPath();
      await writeFile(join(canonical, 'weights.bin'), 'wrong');
      const outside = await mkdtemp(join(tmpdir(), 'outside-model-')); roots.push(outside);
      const name = `${LOCAL_MODEL_REVISION}-22222222-2222-4222-8222-222222222222`;
      const external = join(outside, name);
      await mkdir(external);
      await writeFile(join(external, 'weights.bin'), 'model');
      const parent = dirname(canonical);
      await symlink(external, join(parent, name), process.platform === 'win32' ? 'junction' : 'dir');
      f.setSaved(external);
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const recovery = await f.manager.validatedPath();
      await writeFile(join(recovery, 'weights.bin'), 'wrong');

      expect(await f.manager.adoptExistingFolder(external)).toMatchObject({ status: 'ready' });
      const replacement = await f.manager.validatedPath();
      expect(replacement).not.toBe(recovery);
      expect((await readdir(parent)).sort()).toEqual([LOCAL_MODEL_REVISION, name, basename(replacement)].sort());
      expect(await readFile(join(external, 'weights.bin'), 'utf8')).toBe('model');
      expect(await readFile(join(parent, name, 'weights.bin'), 'utf8')).toBe('model');
    } finally { await f.close(); }
  });
  it('removes an unpublished recovery slot when saving the replacement fails', async () => {
    let failSave = false;
    const f = await fixture('model', '', () => { if (failSave) throw new Error('Save failed'); });
    try {
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const canonical = await f.manager.validatedPath();
      await writeFile(join(canonical, 'weights.bin'), 'wrong');
      expect(await f.manager.download()).toMatchObject({ status: 'ready' });
      const recovery = await f.manager.validatedPath();
      await writeFile(join(recovery, 'weights.bin'), 'wrong');
      failSave = true;

      expect(await f.manager.download()).toMatchObject({ status: 'failed', error: 'model-download-failed' });
      expect(f.saved()).toBe(recovery);
      expect((await readdir(dirname(canonical))).sort()).toEqual([LOCAL_MODEL_REVISION, basename(recovery)].sort());
    } finally { await f.close(); }
  });
  it('reports a valid legacy model location in settings and refuses it for inference', async () => {
    const f = await fixture();
    try {
      const external = await mkdtemp(join(tmpdir(), 'previous-model-')); roots.push(external);
      await writeFile(join(external, 'weights.bin'), 'model');
      f.setSaved(external);
      await expect(f.manager.status()).resolves.toMatchObject({ status: 'legacy-location', error: undefined });
      await expect(f.manager.validatedPath()).rejects.toMatchObject({ code: 'model-integrity-failed' });
      expect(f.saved()).toBe(external);
    } finally { await f.close(); }
  });
  it('refuses a linked models namespace before adopting a model', async () => {
    const f = await fixture('model', 'models');
    try {
      const external = await mkdtemp(join(tmpdir(), 'linked-model-')); roots.push(external);
      const namespace = join(f.root, 'models');
      await writeFile(join(external, 'weights.bin'), 'model');
      await symlink(external, namespace, process.platform === 'win32' ? 'junction' : 'dir');
      f.setSaved(external);
      await expect(f.manager.validatedPath()).rejects.toMatchObject({ code: 'model-integrity-failed' });
      expect(await f.manager.adoptExistingFolder(external)).toMatchObject({ status: 'failed', error: 'model-integrity-failed' });
      expect(await readdir(external)).toEqual(['weights.bin']);
    } finally { await f.close(); }
  });
  it('cancels in-flight streaming and cannot commit the partial folder', async () => {
    const f = await fixture();
    const manager = new LocalModelManager({ files: f.files, namespace: {
      dir: f.root, readJson: async (_, v) => v, writeJson: async () => {},
      childDir: async name => { const p = join(f.root, name); await mkdir(p, { recursive: true }); return p; }, createFile: name => open(join(f.root, name), 'wx'),
    }, readPath: () => undefined, savePath: () => { throw new Error('Unexpected save'); }, downloadFile: async (_, signal) => {
      queueMicrotask(() => manager.cancel()); signal.throwIfAborted(); return new Response('model');
    } });
    try { expect(await manager.download()).toMatchObject({ status: 'failed', error: 'model-cancelled' }); }
    finally { await f.close(); }
  });
});
