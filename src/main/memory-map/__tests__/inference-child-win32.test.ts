import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cleanupAsrtSandboxAfterCommand } from '../../../permissions/asrt-sandbox.js';
import { appendFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { duplexPair, PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { deferred } from '../../../__tests__/support/deferred.js';
import { mainDir } from '../../main-paths.js';
import { MemoryMapHostError } from '../errors.js';
import type { LocalInferenceRoute } from '../local-runtime-win32.js';
import type { ConfinedChildSpec } from '../../../permissions/confined-child.js';
import { MxcProcessCleanupError } from '../../../permissions/mxc-extension-errors.js';
import { TOOL_TIMEOUT_POLICY } from '../../../shared/tool-timeout-policy.js';
import type { WindowsBackgroundAdmission } from '../../../permissions/windows-background-features.js';
import { parseChildLaunchArgs } from '../../../plugins/isolation/child-loopback-link.js';
import { runInferenceChild } from '../inference-child-win32.js';
import { INFERENCE_ACCOUNT_EXIT_RECEIPT, INFERENCE_ACCOUNT_RELAY_ARG, MAX_INFERENCE_TASK_BYTES } from '../inference-request.js';
import { MODEL_FILES } from '../model-manifest.js';

const { spawn, spawnMxc, spawnHost, route, refreshAdmission, grant, createHome, connectLoopback, helperIdentity } = vi.hoisted(() => ({
  spawn: vi.fn<(spec: ConfinedChildSpec) => unknown>(), grant: vi.fn(), createHome: vi.fn(), connectLoopback: vi.fn(),
  spawnMxc: vi.fn(), spawnHost: vi.fn(),
  route: vi.fn<(_enabled?: boolean, _admission?: WindowsBackgroundAdmission) => LocalInferenceRoute>(() => 'offline-sandbox'),
  refreshAdmission: vi.fn<() => Promise<WindowsBackgroundAdmission | undefined>>(async () => undefined),
  helperIdentity: vi.fn(() => 'helper'),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnHost,
}));
vi.mock('../../../sandbox/wrap-bundled-command.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../sandbox/wrap-bundled-command.js')>(), spawnMxcBundledHolder: spawnMxc,
}));
vi.mock('../../../permissions/confined-child.js', () => ({
  spawnConfinedChild: spawn, NODE_PRESERVE_SYMLINK_FLAGS: [], srtWinTargetEnv: (_base: unknown, extra: unknown) => extra,
}));
vi.mock('../../../plugins/isolation/child-loopback-link.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../plugins/isolation/child-loopback-link.js')>(),
  connectToAnnouncedChild: connectLoopback,
}));
vi.mock('../../../permissions/windows-acl-grant-holder.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../permissions/windows-acl-grant-holder.js')>(), holdWindowsFilesystemGrant: grant,
}));
vi.mock('../../../permissions/sandbox-process-home.js', () => ({
  createSandboxProcessHome: createHome,
  isSandboxHomeUnavailable: (error: unknown) => (error as { code?: unknown } | undefined)?.code === 'sandbox-home-unavailable',
}));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({
  cleanupAsrtSandboxAfterCommand: vi.fn(),
  getWindowsConfinementRoute: () => [],
  getWindowsAccountConfinementHelperIdentity: helperIdentity,
}));
vi.mock('../local-runtime-win32.js', async importOriginal => ({
  ...await importOriginal<typeof import('../local-runtime-win32.js')>(),
  assertLocalEmbeddingRuntime: route,
  refreshLocalInferenceAdmission: refreshAdmission,
}));
vi.mock('../model-manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../model-manifest.js')>();
  return { ...actual, MODEL_FILES: actual.MODEL_FILES.map(file => ({
    ...file, bytes: 131081, sha256: createHash('sha256').update(Buffer.alloc(131081)).digest('hex'),
  })) };
});

const HOST_PLATFORM = process.platform;
const FIXTURE_SYSTEM_ROOT = win32.join('C:\\', 'example', 'Windows');
let folder: string;
const TASK = { kind: 'embed', text: 'fixture' } as const;
const TASK_BYTES = Buffer.from(JSON.stringify(TASK));
const MODEL_BYTES = MODEL_FILES.slice(0, 3).map(file => Buffer.alloc(file.bytes));
const REQUEST_PREFIX = Buffer.alloc(16);
[TASK_BYTES, ...MODEL_BYTES].forEach((bytes, index) => { REQUEST_PREFIX.writeUInt32BE(bytes.length, index * 4); });
const REQUEST_FRAME = Buffer.concat([REQUEST_PREFIX, TASK_BYTES, ...MODEL_BYTES]);

beforeEach(async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  createHome.mockReset().mockImplementation(() => ({ env: {}, cleanup: vi.fn() }));
  spawn.mockReset();
  spawnMxc.mockReset();
  spawnHost.mockReset();
  route.mockReset();
  refreshAdmission.mockReset();
  helperIdentity.mockReset();
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

function publishAccountReceipt(child: { stderr: PassThrough; emit: EventEmitter['emit'] }) {
  child.stderr.write(`${INFERENCE_ACCOUNT_EXIT_RECEIPT}\n`);
  child.emit('close', 0, null);
}

function serveReply(beforeWrite?: (received: number) => void | Promise<void>) {
  let received = 0;
  const stdout = new PassThrough();
  const completed = vi.fn();
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const receive = () => {
        received += chunk.length;
        if (received === REQUEST_FRAME.length) {
          completed();
          stdout.write('{"kind":"result","value":"embedded"}\n');
        }
        callback();
      };
      const pending = beforeWrite?.(received);
      if (pending) void pending.then(receive);
      else receive();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(),
  });
  spawn.mockImplementation(async spec => {
    spec.onSpawn?.(child as unknown as ChildProcess);
    return { child };
  });
  connectLoopback.mockImplementation(async () => {
    const [socket, peer] = duplexPair();
    peer.pipe(stdin);
    stdout.pipe(peer);
    socket.once('close', () => { peer.destroy(); publishAccountReceipt(child); });
    return socket;
  });
  return { child, completed };
}

describe('inference model stream', () => {
  it('refuses an oversized UTF-8 task before allocating its wire buffer or launching the child', async () => {
    const batch = { kind: 'embed-batch' as const, texts: ['한글'], jobId: 'job' };
    const taskJson = JSON.stringify(batch);
    const measure = Buffer.byteLength;
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
      value === taskJson ? MAX_INFERENCE_TASK_BYTES + 1 : measure(value, encoding));
    spawn.mockRejectedValue(new Error('Unexpected child launch'));
    await expect(runInferenceChild(folder, batch, new AbortController().signal)).rejects.toMatchObject({ code: 'catalog-too-large' });
    expect(byteLength).toHaveBeenCalledWith(taskJson, 'utf8');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a file with a mismatched manifest length before writing any frame bytes', async () => {
    appendFileSync(join(folder, MODEL_FILES[1].name), 'x');
    const { child } = serveReply();
    const requestWrite = vi.spyOn(child.stdin, 'write');
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code: 'model-integrity-failed' });
    expect(requestWrite).not.toHaveBeenCalled();
  });

  it.each(['model-integrity-failed', 'catalog-too-large'])('preserves a %s refusal from the child', async code => {
    const { child } = serveReply(received => {
      if (received === 0) child.stdout.write(`${JSON.stringify({ kind: 'error', error: code })}\n`);
    });
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it('refuses with the named reason, launching nothing, when no Windows sandbox HOME can be made', async () => {
    vi.stubEnv('SystemRoot', undefined);
    createHome.mockImplementationOnce(() => {
      throw Object.assign(new Error('sandboxed processes are unavailable'), { code: 'sandbox-home-unavailable' });
    });
    await expect(runInferenceChild(folder, TASK, new AbortController().signal))
      .rejects.toMatchObject({ name: 'MemoryMapHostError', code: 'sandbox-home-unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('delivers the request through the account transport using exactly three pipes', async () => {
    vi.stubEnv('NODE_CHANNEL_FD', '3');
    const { child, completed } = serveReply();
    const requestWrite = vi.spyOn(child.stdin, 'write');
    const processStdin = new PassThrough();
    const stdioWrite = vi.spyOn(processStdin, 'write');
    {
      vi.stubEnv('SystemRoot', 'C:/Windows');
      createHome.mockReturnValue({ env: {}, cleanup: vi.fn() });
      const [socket, peer] = duplexPair();
      peer.pipe(child.stdin);
      child.stdout.pipe(peer);
      socket.once('close', () => { peer.destroy(); publishAccountReceipt(child); });
      connectLoopback.mockResolvedValueOnce(socket);
      child.stdin = processStdin;
      child.stdout = new PassThrough();
    }
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).resolves.toBe('embedded');
    expect(completed).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    const launch = spawn.mock.calls[0]?.[0];
    expect(launch?.stdio).toStrictEqual(['pipe', 'pipe', 'pipe']);
    expect(launch?.args[1]).toBe(INFERENCE_ACCOUNT_RELAY_ARG);
    const mode = parseChildLaunchArgs(launch?.args.slice(2) ?? []);
    const env = { ...launch?.baseEnv, ...launch?.extraEnv, ...launch?.windowsCommandLineEnv, ...(mode.transport === 'loopback' ? mode.env : {}) };
    expect(Object.keys(env).map(name => name.toUpperCase())).not.toContain('NODE_CHANNEL_FD');
    expect(Buffer.concat(requestWrite.mock.calls.map(([chunk]) => chunk as Buffer))).toEqual(REQUEST_FRAME);
    expect(mode.transport).toBe('loopback');
    expect(connectLoopback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stdout: child.stdout }));
    expect(stdioWrite).not.toHaveBeenCalled();
  });

  it('closes the offline transport when the helper changes during a held handshake', async () => {
    setProcessPlatform('win32');
    vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
    const cleanup = vi.fn();
    createHome.mockReturnValue({ env: {}, cleanup });
    const { child, completed } = serveReply();
    const [socket, peer] = duplexPair();
    const requestWrite = vi.spyOn(socket, 'write');
    peer.pipe(child.stdin);
    child.stdout.pipe(peer);
    const connecting = deferred<void>();
    const connect = deferred<typeof socket>();
    socket.once('close', () => publishAccountReceipt(child));
    connectLoopback.mockImplementationOnce(() => { connecting.resolve(); return connect.promise; });

    const inference = runInferenceChild(folder, TASK, new AbortController().signal);
    await connecting.promise;
    helperIdentity.mockReturnValue('replacement-helper');
    connect.resolve(socket);
    try {
      await expect.soft(inference).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
      expect.soft(requestWrite).not.toHaveBeenCalled();
      expect.soft(completed).not.toHaveBeenCalled();
      expect.soft(socket.destroyed).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      peer.destroy();
    }
  });

  it('withholds the final unconfined request bytes when a held write outlives its receipt', async () => {
    const admission: WindowsBackgroundAdmission = {
      areSwitchesAvailable: () => current === admission,
      searchIndexPolicy: () => 'inactive',
      isBackendOperational: () => false,
    };
    const replacement = { ...admission, areSwitchesAvailable: () => true };
    let current: WindowsBackgroundAdmission = admission;
    refreshAdmission.mockResolvedValue(admission);
    route.mockImplementation((_enabled, receipt) => {
      if (!receipt?.areSwitchesAvailable()) throw new MemoryMapHostError('local-runtime-unavailable');
      return 'unconfined';
    });
    const writing = deferred<void>();
    const release = deferred<void>();
    const { child, completed } = serveReply(received => {
      if (received !== 0) return;
      writing.resolve();
      return release.promise;
    });
    child.kill.mockImplementationOnce(() => { queueMicrotask(() => child.emit('exit', 0, null)); return true; });
    spawnHost.mockReturnValue(child);

    const inference = runInferenceChild(folder, TASK, new AbortController().signal);
    await writing.promise;
    current = replacement;
    refreshAdmission.mockResolvedValue(replacement);
    release.resolve();
    await expect.soft(inference).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
    expect.soft(completed).not.toHaveBeenCalled();
    expect.soft(child.stdin.destroyed).toBe(true);
    expect.soft(child.stdout.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('discards a result that arrives after the dispatched route is superseded', async () => {
    const { child, completed } = serveReply();
    completed.mockImplementationOnce(() => {
      route.mockImplementation(() => { throw new MemoryMapHostError('local-runtime-unavailable'); });
    });
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
    expect(completed).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['grown', (file: string) => appendFileSync(file, 'x')],
    ['truncated', (file: string) => truncateSync(file, 31)],
    ['edited at the same size', (file: string) => writeFileSync(file, Buffer.alloc(32, 1))],
  ] as const)('rejects a model %s after the handle size check', async (_case, mutate) => {
    const [model] = MODEL_FILES;
    if (model === undefined) throw new Error('The fixture model manifest is empty');
    const { completed } = serveReply(received => { if (received === 0) mutate(join(folder, model.name)); });
    await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toMatchObject({ code: 'model-integrity-failed' });
    expect(completed).not.toHaveBeenCalled();
  });
  it.each([
    ['grows', (path: string) => appendFileSync(path, 'x')],
    ['changes without growing', (path: string) => {
      writeFileSync(path, Buffer.alloc(MODEL_FILES[0].bytes, 1));
      utimesSync(path, 1, 1);
    }],
  ] as const)('rejects a frame if an earlier model %s while the next model streams', async (_case, mutate) => {
    const first = MODEL_FILES[0];
    let changed = false;
    const { completed } = serveReply(received => {
      if (received === REQUEST_PREFIX.length + TASK_BYTES.length + first.bytes) {
        mutate(join(folder, first.name));
        changed = true;
      }
    });
    const outcome = await runInferenceChild(folder, TASK, new AbortController().signal).catch(error => error);
    expect(changed).toBe(true);
    expect(completed).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ code: 'model-integrity-failed' });
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

it.each(['cancellation', 'late startup refusal'] as const)('retains HOME and wrap when the wrapper exits before the target during %s', async reason => {
  vi.mocked(cleanupAsrtSandboxAfterCommand).mockClear();
  const cleanup = vi.fn();
  createHome.mockReturnValue({ env: {}, cleanup });
  const wrapper = Object.assign(new EventEmitter(), {
    pid: 2200, stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  });
  const target = new EventEmitter();
  const targetExit = vi.fn();
  target.once('exit', targetExit);
  const [socket, peer] = duplexPair();
  const acquired = deferred<void>();
  const control = new AbortController();
  spawn.mockImplementationOnce(spec => {
    spec.onWrapped?.();
    spec.onSpawn?.(wrapper as unknown as ChildProcess);
    acquired.resolve();
    if (reason === 'late startup refusal') throw new Error('late startup refusal');
    return { child: wrapper };
  });
  const connected = deferred<void>();
  connectLoopback.mockImplementation(async () => {
    connected.resolve();
    return socket;
  });

  const result = runInferenceChild(folder, TASK, control.signal);
  const observed = result.catch((error: unknown) => error);
  try {
    await acquired.promise;
    if (reason === 'cancellation') {
      await connected.promise;
      control.abort();
    }
    wrapper.emit('exit', 0, null);
    wrapper.emit('close', 0, null);
    await expect.soft(observed).resolves.toMatchObject({ name: 'ManagedExitUnconfirmedError' });
    expect.soft(targetExit).not.toHaveBeenCalled();
    expect.soft(cleanup).not.toHaveBeenCalled();
    expect.soft(cleanupAsrtSandboxAfterCommand).not.toHaveBeenCalled();
  } finally {
    target.emit('exit');
    socket.destroy();
    peer.destroy();
    wrapper.stdout.destroy();
  }
});

it('releases only after the relay confirms the stopped target tree', async () => {
  vi.mocked(cleanupAsrtSandboxAfterCommand).mockClear();
  const cleanup = vi.fn();
  createHome.mockReturnValue({ env: {}, cleanup });
  const { child: wrapper } = serveReply();
  const target = new EventEmitter();
  const [socket, peer] = duplexPair();
  const connected = deferred<void>();
  const stopRequested = deferred<void>();
  const control = new AbortController();
  connectLoopback.mockImplementationOnce(async () => {
    socket.once('close', stopRequested.resolve);
    connected.resolve();
    return socket;
  });
  spawn.mockImplementationOnce(spec => {
    spec.onWrapped?.();
    spec.onSpawn?.(wrapper as unknown as ChildProcess);
    return { child: wrapper };
  });
  target.once('exit', () => publishAccountReceipt(wrapper));

  const result = runInferenceChild(folder, TASK, control.signal).catch((error: unknown) => error);
  try {
    await connected.promise;
    control.abort();
    await stopRequested.promise;
    wrapper.emit('exit', 0, null);
    expect(cleanup).not.toHaveBeenCalled();
    expect(cleanupAsrtSandboxAfterCommand).not.toHaveBeenCalled();
    target.emit('exit');
    await expect(result).resolves.toMatchObject({ message: 'Memory worker cancelled' });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupAsrtSandboxAfterCommand).toHaveBeenCalledOnce();
    expect(wrapper.kill).not.toHaveBeenCalled();
  } finally {
    socket.destroy();
    peer.destroy();
  }
});

it('streams verified bytes through the container holder and releases it', async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  route.mockReturnValue('mxc');
  const { child, completed } = serveReply();
  const release = vi.fn(async () => {});
  const fenceInput = vi.fn<(admit: () => void) => void>();
  spawnMxc.mockResolvedValue({ process: Object.assign(child, { fenceInput }), release });
  const signal = new AbortController().signal;
  await expect(runInferenceChild(folder, TASK, signal)).resolves.toBe('embedded');
  // The holder's own frames take the request's admission: it refuses once the route is superseded.
  expect(fenceInput).toHaveBeenCalledOnce();
  const admitFrame = fenceInput.mock.calls[0]?.[0];
  if (admitFrame === undefined) throw new Error('Input was not fenced');
  expect(admitFrame).not.toThrow();
  route.mockReturnValue('unconfined');
  expect(admitFrame).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  expect(spawnMxc).toHaveBeenCalledWith(expect.objectContaining({
    workerTransport: 'stdio-control-v1', signal, cwd: win32.join(FIXTURE_SYSTEM_ROOT, 'System32'), allowWrite: [],
    egressOwner: expect.objectContaining({ network: 'offline' }),
    holderEnv: expect.objectContaining({ ORT_DISABLE_TELEMETRY: '1' }),
  }));
  expect(spawnMxc.mock.calls[0]?.[0].allowRead).not.toContain(folder);
  expect(completed).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnHost).not.toHaveBeenCalled();
});

it('keeps a container start refusal instead of starting a host child', async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  route.mockReturnValue('mxc');
  spawnMxc.mockRejectedValue(new Error('Container refused'));
  await expect(runInferenceChild(folder, TASK, new AbortController().signal)).rejects.toThrow('Container refused');
  expect(spawnHost).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('keeps the container cleanup refusal when Cancel stops an active inference', async () => {
  route.mockReturnValue('mxc');
  const writing = deferred<void>();
  const { child } = serveReply(() => { writing.resolve(); return new Promise(() => {}); });
  const failure = new MxcProcessCleanupError('Container exit unconfirmed');
  const release = vi.fn().mockRejectedValue(failure);
  spawnMxc.mockResolvedValue({ process: Object.assign(child, { fenceInput: vi.fn() }), release });
  const controller = new AbortController();
  const outcome = runInferenceChild(folder, TASK, controller.signal).catch((error: unknown) => error);
  await writing.promise;
  controller.abort();
  expect(await outcome).toBe(failure);
  expect(release).toHaveBeenCalledOnce();
});

it.each([true, false])('drains container output queued before the exit frame (receipt: %s)', async receivedExit => {
  route.mockReturnValue('mxc');
  const writing = deferred<void>();
  const queuedOutput = deferred<void>();
  const terminalFrame = deferred<void>();
  const { child } = serveReply(() => { writing.resolve(); return new Promise(() => {}); });
  const failure = new MxcProcessCleanupError('Container exit unconfirmed');
  const release = vi.fn(async () => {
    child.stdout.resume();
    try {
      for (const frame of [
        '{"kind":"progress","progress":{"phase":"embedding"}}\n',
        '{"kind":"result","value":"discarded"}\n',
      ]) {
        await new Promise<void>((resolve, reject) => {
          child.stdout.write(frame, error => error ? reject(error) : resolve());
        });
      }
    } catch {
      throw failure;
    } finally {
      queuedOutput.resolve();
    }
    await terminalFrame.promise;
    if (!receivedExit) throw failure;
  });
  spawnMxc.mockResolvedValue({ process: Object.assign(child, { fenceInput: vi.fn() }), release });
  const controller = new AbortController();
  const onProgress = vi.fn();
  const confirmed = vi.fn();
  const outcome = runInferenceChild(folder, TASK, controller.signal, onProgress, undefined, undefined,
    { starting: vi.fn(), confirmed }).catch((error: unknown) => error);

  await writing.promise;
  controller.abort();
  await queuedOutput.promise;
  expect(confirmed).not.toHaveBeenCalled();
  terminalFrame.resolve();
  const error = await outcome;
  expect(onProgress).not.toHaveBeenCalled();
  if (receivedExit) {
    expect(error).toEqual(new Error('Memory worker cancelled'));
    expect(confirmed).toHaveBeenCalledOnce();
  } else {
    expect(error).toBe(failure);
    expect(confirmed).not.toHaveBeenCalled();
  }
});

it.each([true, false])('waits for direct child exit after Cancel (confirmed: %s)', async confirmed => {
  route.mockReturnValue('unconfined');
  const stopped = deferred<void>();
  const { child } = serveReply(() => new Promise(() => {}));
  const cleanup = vi.fn();
  const onExitConfirmed = vi.fn();
  createHome.mockReturnValue({ env: {}, cleanup });
  child.kill.mockImplementation(() => { stopped.resolve(); return true; });
  spawnHost.mockReturnValue(Object.assign(child, { pid: 123 }));
  const controller = new AbortController();
  const reply = vi.fn();
  const result = runInferenceChild(folder, TASK, controller.signal, undefined, undefined, undefined,
    { starting: vi.fn(), confirmed: onExitConfirmed }).catch(reply);
  await vi.waitFor(() => expect(spawnHost).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  try {
    controller.abort();
    await stopped.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(reply).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    if (!confirmed) {
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsInferenceTargetExitMs);
      await result;
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ name: 'ManagedExitUnconfirmedError' }));
      expect(onExitConfirmed).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    }
    child.emit('exit', 0, null);
    await result;
    await vi.advanceTimersByTimeAsync(0);
    if (confirmed) expect(reply).toHaveBeenCalledWith(expect.objectContaining({ message: 'Memory worker cancelled' }));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onExitConfirmed).toHaveBeenCalledOnce();
  } finally {
    child.emit('exit', 0, null);
    vi.useRealTimers();
  }
});

it('streams verified bytes to a managed host child only for the unconfined route', async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  route.mockReturnValue('unconfined');
  createHome.mockReturnValue({ env: {}, cleanup: vi.fn() });
  const { child, completed } = serveReply();
  child.kill.mockImplementationOnce(() => child.emit('close'));
  spawnHost.mockReturnValue(child);
  await expect(runInferenceChild(folder, TASK, new AbortController().signal)).resolves.toBe('embedded');
  expect(spawnHost).toHaveBeenCalledExactlyOnceWith(process.execPath, [join(mainDir, 'memory-map-child.js')], expect.objectContaining({
    cwd: win32.join(FIXTURE_SYSTEM_ROOT, 'System32'), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', ORT_DISABLE_TELEMETRY: '1' }),
  }));
  expect(completed).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnMxc).not.toHaveBeenCalled();
});

it.each(['cancelled', 'disabled'] as const)('starts no child when shared admission is pending and inference is %s', async change => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  const refresh = deferred<undefined>();
  refreshAdmission.mockReturnValue(refresh.promise);
  route.mockImplementation(enabled => {
    if (enabled === false) throw new MemoryMapHostError('local-inference-disabled');
    return 'unconfined';
  });
  createHome.mockReturnValue({ env: {}, cleanup: vi.fn() });
  spawnHost.mockImplementation(() => { throw new Error('Unexpected host spawn'); });
  const controllers = [new AbortController(), new AbortController()];
  let enabled = true;
  const reason = new Error('Inference cancelled during admission');
  const runs = controllers.map(({ signal }) =>
    runInferenceChild(folder, TASK, signal, undefined, () => enabled).then(value => value, error => error),
  );
  expect(refreshAdmission).toHaveBeenCalledTimes(2);
  if (change === 'cancelled') for (const controller of controllers) controller.abort(reason);
  else enabled = false;
  refresh.resolve(undefined);
  const outcomes = await Promise.all(runs);

  expect.soft(spawnHost).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnMxc).not.toHaveBeenCalled();
  if (change === 'cancelled') expect(outcomes).toEqual([reason, reason]);
  else expect(outcomes).toEqual([expect.objectContaining({ code: 'local-inference-disabled' }), expect.objectContaining({ code: 'local-inference-disabled' })]);
});

it('checks live preference again after preparing the host child', async () => {
  setProcessPlatform('win32');
  vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
  let enabled = true;
  route.mockImplementation(preference => {
    if (preference === false) throw new MemoryMapHostError('local-inference-disabled');
    return 'unconfined';
  });
  const cleanup = vi.fn();
  createHome.mockImplementationOnce(() => {
    enabled = false;
    return { env: {}, cleanup };
  });
  spawnHost.mockImplementation(() => { throw new Error('Unexpected host spawn'); });

  await expect(runInferenceChild(folder, TASK, new AbortController().signal, undefined, () => enabled))
    .rejects.toMatchObject({ code: 'local-inference-disabled' });
  expect(spawnHost).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(['cancel', 'route change'] as const)('refuses native creation after a delayed offline wrap on %s', async change => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const resume = deferred<void>();
  const nativeCreate = vi.fn(() => { throw new Error('Unexpected native creation'); });
  const reason = new Error('Inference cancelled during wrapping');
  spawn.mockImplementation(async spec => {
    spec.onWrapped?.();
    entered.resolve();
    await resume.promise;
    spec.assertStillValid?.();
    nativeCreate();
  });
  const run = runInferenceChild(folder, TASK, controller.signal).catch((error: unknown) => error);
  await entered.promise;
  if (change === 'cancel') controller.abort(reason);
  else route.mockReturnValue('unconfined');
  resume.resolve();

  const outcome = await run;
  expect.soft(nativeCreate).not.toHaveBeenCalled();
  expect(spawnHost).not.toHaveBeenCalled();
  if (change === 'cancel') expect(outcome).toBe(reason);
  else expect(outcome).toMatchObject({ code: 'local-runtime-unavailable' });
});

describe('inference dispatch and delivery under a superseded receipt', () => {
  function supersedableRoute() {
    let live = true;
    route.mockImplementation(() => {
      if (!live) throw new MemoryMapHostError('local-runtime-unavailable');
      return 'offline-sandbox';
    });
    return () => { live = false; };
  }

  it('sends no task or model bytes after a held prefix write outlives its receipt', async () => {
    const supersede = supersedableRoute();
    const writing = deferred<void>();
    const release = deferred<void>();
    const { child, completed } = serveReply(received => {
      if (received !== 0) return;
      writing.resolve();
      return release.promise;
    });
    const requestWrite = vi.spyOn(child.stdin, 'write');

    const inference = runInferenceChild(folder, TASK, new AbortController().signal);
    await writing.promise;
    supersede();
    release.resolve();
    await expect.soft(inference).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
    expect.soft(requestWrite.mock.calls.map(([chunk]) => (chunk as Buffer).length)).toEqual([REQUEST_PREFIX.length]);
    expect(completed).not.toHaveBeenCalled();
  });

  it('refuses a result whose receipt is superseded while child cleanup is held', async () => {
    setProcessPlatform('win32');
    vi.stubEnv('SystemRoot', FIXTURE_SYSTEM_ROOT);
    let live = true;
    route.mockImplementation(() => {
      if (!live) throw new MemoryMapHostError('local-runtime-unavailable');
      return 'mxc';
    });
    const { child, completed } = serveReply();
    const releasing = deferred<void>();
    const released = deferred<void>();
    spawnMxc.mockResolvedValue({
      process: Object.assign(child, { fenceInput: vi.fn() }),
      release: vi.fn(() => { releasing.resolve(); return released.promise; }),
    });

    const inference = runInferenceChild(folder, TASK, new AbortController().signal);
    await releasing.promise;
    expect(completed).toHaveBeenCalledOnce();
    live = false;
    released.resolve();
    await expect(inference).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
  });

  it('forwards no progress once its receipt is superseded', async () => {
    const supersede = supersedableRoute();
    const progress = { jobId: 'job', phase: 'embedding', completed: 1, total: 2 } as const;
    const { child, completed } = serveReply(received => {
      if (received !== 0) return;
      child.stdout.write(`${JSON.stringify({ kind: 'progress', progress })}
`);
      return new Promise<void>(resolve => { setImmediate(() => { supersede(); child.stdout.write(`${JSON.stringify({ kind: 'progress', progress: { ...progress, completed: 2 } })}
`); setImmediate(resolve); }); });
    });
    const onProgress = vi.fn();

    await expect(runInferenceChild(folder, TASK, new AbortController().signal, onProgress)).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
    expect(onProgress.mock.calls).toEqual([[progress]]);
    expect(completed).not.toHaveBeenCalled();
  });
});
