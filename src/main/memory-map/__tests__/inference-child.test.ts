import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { runInferenceChild } from '../inference-child.js';
import { MODEL_FILES } from '../model-manifest.js';

const { spawn, grant, createHome } = vi.hoisted(() => ({ spawn: vi.fn(), grant: vi.fn(), createHome: vi.fn() }));
vi.mock('../../../permissions/confined-child.js', () => ({
  spawnConfinedChild: spawn, NODE_PRESERVE_SYMLINK_FLAGS: [], srtWinTargetEnv: (_base: unknown, extra: unknown) => extra,
}));
vi.mock('../../../permissions/windows-acl-grant-holder.js', () => ({ holdWindowsFilesystemGrant: grant }));
vi.mock('../../../permissions/sandbox-process-home.js', () => ({ createSandboxProcessHome: createHome }));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({ cleanupAsrtSandboxAfterCommand: vi.fn() }));
vi.mock('../local-runtime.js', () => ({ assertLocalEmbeddingRuntime: vi.fn() }));
vi.mock('../model-manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../model-manifest.js')>();
  return { ...actual, MODEL_FILES: actual.MODEL_FILES.map(file => ({
    ...file, bytes: 32, sha256: createHash('sha256').update(Buffer.alloc(32)).digest('hex'),
  })) };
});

const HOST_PLATFORM = process.platform;
let folder: string;
const TASK = { kind: 'embed', text: 'fixture' } as const;
const REQUEST_BYTES = 16 + Buffer.byteLength(JSON.stringify(TASK)) + MODEL_FILES.slice(0, 3).reduce((size, file) => size + file.bytes, 0);

beforeEach(async () => {
  setProcessPlatform('linux');
  spawn.mockReset();
  folder = await mkdtemp(join(tmpdir(), 'inference-stream-'));
  for (const file of MODEL_FILES) writeFileSync(join(folder, file.name), Buffer.alloc(file.bytes));
});

afterEach(async () => {
  setProcessPlatform(HOST_PLATFORM);
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});

function serveReply(onFirstWrite?: () => void) {
  let received = 0;
  const stdout = new PassThrough();
  const completed = vi.fn();
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (received === 0) onFirstWrite?.();
      received += chunk.length;
      if (received === REQUEST_BYTES) {
        completed();
        stdout.write('{"kind":"result","value":"embedded"}\n');
      }
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(),
  });
  spawn.mockResolvedValue({ child });
  return completed;
}

describe('inference model stream', () => {
  it('delivers a complete verified request', async () => {
    const completed = serveReply();
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).resolves.toBe('embedded');
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([
    ['grown', (file: string) => appendFileSync(file, 'x')],
    ['truncated', (file: string) => truncateSync(file, 31)],
    ['edited at the same size', (file: string) => writeFileSync(file, Buffer.alloc(32, 1))],
  ] as const)('rejects a model %s after the handle size check', async (_case, mutate) => {
    const [model] = MODEL_FILES;
    if (model === undefined) throw new Error('The fixture model manifest is empty');
    const completed = serveReply(() => mutate(join(folder, model.name)));
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code: 'model-integrity-failed' });
    expect(completed).not.toHaveBeenCalled();
  });
});

it('uses the Windows system directory as cwd without a profile ACL grant', async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', 'C:/Windows');
  const home = { path: 'C:/scratch/inference-home', env: { HOME: 'C:/scratch/inference-home' }, cleanup: vi.fn() };
  createHome.mockReturnValue(home);
  grant.mockReturnValue({ release: vi.fn() });
  const refused = new Error('spawn refused by fixture');
  spawn.mockRejectedValue(refused);
  await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toBe(refused);
  expect(grant).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    cwd: 'C:\\Windows\\System32', grantMode: 'deny-only', extraEnv: expect.objectContaining(home.env),
  }));
  expect(home.cleanup).toHaveBeenCalledOnce();
});
