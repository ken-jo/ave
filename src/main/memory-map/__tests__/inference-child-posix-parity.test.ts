import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair, PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { MemoryMapHostError } from '../errors.js';
import { runInferenceChild } from '../inference-child.js';
import { MODEL_FILES } from '../model-manifest.js';

const state = vi.hoisted(() => ({
  assertReady: vi.fn(),
  confinedSpawn: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('../local-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../local-runtime.js')>(),
  assertLocalEmbeddingRuntime: state.assertReady,
  refreshLocalInferenceAdmission: async () => ({}),
}));
vi.mock('../../../permissions/confined-child.js', () => ({
  spawnConfinedChild: state.confinedSpawn,
  NODE_PRESERVE_SYMLINK_FLAGS: [],
  srtWinTargetEnv: () => ({}),
}));
vi.mock('../../../permissions/sandbox-process-home.js', () => ({
  createSandboxProcessHome: () => ({ env: {}, cleanup() {} }),
  isSandboxHomeUnavailable: () => false,
}));
vi.mock('../../../plugins/isolation/child-loopback-link.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../plugins/isolation/child-loopback-link.js')>(),
  connectToAnnouncedChild: state.connect,
}));
vi.mock('../model-manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../model-manifest.js')>();
  return { ...actual, MODEL_FILES: actual.MODEL_FILES.map(file => ({
    ...file, bytes: 1, sha256: createHash('sha256').update('a').digest('hex'),
  })) };
});

it('finishes an already confined inference without rereading readiness', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'inference-readiness-'));
  let ready = true;
  let readsAtSpawn = 0;
  state.assertReady.mockImplementation(() => {
    if (!ready) throw new MemoryMapHostError('local-runtime-unavailable');
    return 'offline-sandbox';
  });
  if (process.platform === 'win32') vi.stubEnv('SystemRoot', 'C:/example/Windows');
  const [transport, peer] = duplexPair();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout, stdin, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(),
  });
  state.connect.mockResolvedValue(transport);
  state.confinedSpawn.mockImplementation(async () => {
    readsAtSpawn = state.assertReady.mock.calls.length;
    ready = false;
    setImmediate(() => {
      const destination = process.platform === 'win32' ? peer : stdout;
      destination.write('{"kind":"result","value":"fixture-result"}\n');
    });
    return { child };
  });
  try {
    await Promise.all(MODEL_FILES.map(file => writeFile(join(folder, file.name), 'a')));
    await expect(runInferenceChild(folder, { kind: 'embed', text: 'fixture' }, new AbortController().signal))
      .resolves.toBe('fixture-result');
    expect(state.assertReady).toHaveBeenCalledTimes(readsAtSpawn);
    expect(readsAtSpawn).toBe(1);
  } finally {
    transport.destroy();
    peer.destroy();
    vi.unstubAllEnvs();
    await rm(folder, { recursive: true, force: true });
  }
});
