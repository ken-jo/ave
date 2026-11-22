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

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../../permissions/confined-child.js', () => ({ spawnConfinedChild: spawn }));
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
    const completed = serveReply(() => mutate(join(folder, MODEL_FILES[0]!.name)));
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code: 'model-integrity-failed' });
    expect(completed).not.toHaveBeenCalled();
  });
});
