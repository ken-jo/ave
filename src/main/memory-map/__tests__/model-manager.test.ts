import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, open, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalModelManager, verifyModelFolder } from '../model-manager.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body = 'model', namespaceName = '') {
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
  const manager = new LocalModelManager({ namespace, files, readPath: () => saved, savePath: path => { saved = path; }, downloadFile: (_, signal) => fetch(`http://127.0.0.1:${port}`, { signal }) });
  return { manager, root, files, saved: () => saved, setSaved: (path: string) => { saved = path; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
describe('local model lifecycle', () => {
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
