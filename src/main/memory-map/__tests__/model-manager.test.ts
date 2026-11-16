import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalModelManager, verifyModelFolder } from '../model-manager.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body = 'model') {
  const root = await mkdtemp(join(tmpdir(), 'memory-model-')); roots.push(root);
  const files = [{ name: 'weights.bin', bytes: 5, sha256: createHash('sha256').update('model').digest('hex') }];
  let saved: string | undefined;
  const namespace: FeatureNamespaceHandle = {
    dir: root, readJson: async (_, fallback) => fallback, writeJson: async () => {},
    childDir: async name => { const path = join(root, name); await mkdir(path, { recursive: true }); return path; },
    createFile: name => open(join(root, name), 'wx'),
  };
  const server = createServer((_, response) => { response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const manager = new LocalModelManager({ namespace, files, readPath: () => saved, savePath: path => { saved = path; }, downloadFile: (_, signal) => fetch('http://127.0.0.1:' + port, { signal }) });
  return { manager, root, files, saved: () => saved, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
describe('local model lifecycle', () => {
  it('does not request files on status, and commits only a complete verified download', async () => {
    const f = await fixture();
    try {
      expect((await f.manager.status()).status).toBe('unconfigured');
      expect(f.saved()).toBeUndefined();
      expect(await f.manager.download()).toMatchObject({ status: 'ready', completedFiles: 1, receivedBytes: 5 });
      expect(await readFile(join(f.saved()!, 'weights.bin'), 'utf8')).toBe('model');
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
      const nested = join(f.root, 'existing/onnx'); await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'weights.bin'), 'model');
      expect(await verifyModelFolder(join(f.root, 'existing'), f.files)).toBe(await verifyModelFolder(nested, f.files));
      expect((await f.manager.useExisting(join(f.root, 'existing'))).status).toBe('ready');
      await writeFile(join(nested, 'weights.bin'), 'wrong');
      expect(await f.manager.useExisting(nested)).toMatchObject({ status: 'failed', error: 'model-integrity-failed' });
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
