import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair, PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import type { ConfinedChildSpec } from '../../../permissions/confined-child.js';
import { parseChildLaunchArgs } from '../../../plugins/isolation/child-loopback-link.js';
import { runInferenceChild } from '../inference-child.js';
import { MODEL_FILES } from '../model-manifest.js';

const { spawn, grant, createHome, connectLoopback } = vi.hoisted(() => ({
  spawn: vi.fn<(spec: ConfinedChildSpec) => unknown>(), grant: vi.fn(), createHome: vi.fn(), connectLoopback: vi.fn(),
}));
vi.mock('../../../permissions/confined-child.js', () => ({
  spawnConfinedChild: spawn, NODE_PRESERVE_SYMLINK_FLAGS: [], srtWinTargetEnv: (_base: unknown, extra: unknown) => extra,
}));
vi.mock('../../../plugins/isolation/child-loopback-link.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../plugins/isolation/child-loopback-link.js')>(),
  connectToAnnouncedChild: connectLoopback,
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
const TASK_BYTES = Buffer.from(JSON.stringify(TASK));
const MODEL_BYTES = MODEL_FILES.slice(0, 3).map(file => Buffer.alloc(file.bytes));
const REQUEST_PREFIX = Buffer.alloc(16);
[TASK_BYTES, ...MODEL_BYTES].forEach((bytes, index) => { REQUEST_PREFIX.writeUInt32BE(bytes.length, index * 4); });
const REQUEST_FRAME = Buffer.concat([REQUEST_PREFIX, TASK_BYTES, ...MODEL_BYTES]);

beforeEach(async () => {
  setProcessPlatform('linux');
  spawn.mockReset();
  connectLoopback.mockReset();
  folder = await mkdtemp(join(tmpdir(), 'inference-stream-'));
  for (const file of MODEL_FILES) writeFileSync(join(folder, file.name), Buffer.alloc(file.bytes));
});

afterEach(async () => {
  setProcessPlatform(HOST_PLATFORM);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
      if (received === REQUEST_FRAME.length) {
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
  return { child, completed };
}

describe('inference model stream', () => {
  it.each(['linux', 'win32'] as const)('delivers the request through the protocol transport using exactly three pipes on %s', async platform => {
    setProcessPlatform(platform);
    vi.stubEnv('NODE_CHANNEL_FD', '3');
    const { child, completed } = serveReply();
    const requestWrite = vi.spyOn(child.stdin, 'write');
    const processStdin = new PassThrough();
    const stdioWrite = vi.spyOn(processStdin, 'write');
    if (platform === 'win32') {
      createHome.mockReturnValue({ env: {}, cleanup: vi.fn() });
      const [socket, peer] = duplexPair();
      peer.pipe(child.stdin);
      child.stdout.pipe(peer);
      connectLoopback.mockResolvedValueOnce(socket);
      child.stdin = processStdin;
      child.stdout = new PassThrough();
    }
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).resolves.toBe('embedded');
    expect(completed).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    const launch = spawn.mock.calls[0]?.[0];
    expect(launch?.stdio).toStrictEqual(['pipe', 'pipe', 'pipe']);
    const mode = parseChildLaunchArgs(launch?.args.slice(1) ?? []);
    const env = { ...launch?.baseEnv, ...launch?.extraEnv, ...launch?.windowsCommandLineEnv, ...(mode.transport === 'loopback' ? mode.env : {}) };
    expect(Object.keys(env).map(name => name.toUpperCase())).not.toContain('NODE_CHANNEL_FD');
    expect(Buffer.concat(requestWrite.mock.calls.map(([chunk]) => chunk as Buffer))).toEqual(REQUEST_FRAME);
    if (platform === 'win32') {
      expect(mode.transport).toBe('loopback');
      expect(connectLoopback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stdout: child.stdout }));
      expect(stdioWrite).not.toHaveBeenCalled();
    } else {
      expect(mode.transport).toBe('stdio');
      expect(connectLoopback).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['grown', (file: string) => appendFileSync(file, 'x')],
    ['truncated', (file: string) => truncateSync(file, 31)],
    ['edited at the same size', (file: string) => writeFileSync(file, Buffer.alloc(32, 1))],
  ] as const)('rejects a model %s after the handle size check', async (_case, mutate) => {
    const [model] = MODEL_FILES;
    if (model === undefined) throw new Error('The fixture model manifest is empty');
    const { completed } = serveReply(() => mutate(join(folder, model.name)));
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
