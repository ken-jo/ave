import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { win32 } from 'node:path';
import { acceptHostOverLoopback } from '../../plugins/isolation/child-loopback-link.js';
import { raceWithAbort, sleep } from '../../shared/abortable-deadline.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { runWithCeiling } from '../../tools/executor-ceiling.js';
import { INFERENCE_ACCOUNT_EXIT_RECEIPT } from './inference-request.js';

const BASIC_LIMIT_INFORMATION = 2;
const BASIC_PROCESS_ID_LIST = 3;
const BREAKAWAY_FLAGS = 0x0800 | 0x1000;

export async function bindInferenceAccountJob() {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new Error('Inference relay requires a Windows job');
  }
  const ffi = await import('koffi');
  const kernel = ffi.load('kernel32.dll');
  const query = kernel.func('bool __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)');
  const limits = Buffer.alloc(64);
  // A null handle queries the kernel job inherited from the account runner.
  if (!query(null, BASIC_LIMIT_INFORMATION, limits, limits.length, null)
    || (limits.readUInt32LE(16) & BREAKAWAY_FLAGS) !== 0) {
    throw new Error('Inference relay job cannot prove target ownership');
  }
  const members = Buffer.alloc(8 + 32 * 8);
  const listMembers = (): bigint[] | undefined => {
    if (!query(null, BASIC_PROCESS_ID_LIST, members, members.length, null)) return undefined;
    const listed = members.readUInt32LE(4);
    if (listed === 0 || listed > 32 || listed !== members.readUInt32LE(0)) return undefined;
    return Array.from({ length: listed }, (_, index) => members.readBigUInt64LE(8 + index * 8));
  };
  const relay = BigInt(process.pid);
  const initial = listMembers();
  if (!initial?.includes(relay)) throw new Error('Inference relay job membership is unverified');

  const open = kernel.func('void * __stdcall OpenProcess(uint32_t, bool, uint32_t)');
  const close = kernel.func('bool __stdcall CloseHandle(void *)');
  const imageName = kernel.func('bool __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)');
  const systemDirectory = kernel.func('uint32_t __stdcall GetSystemDirectoryW(void *, uint32_t)');
  const image = Buffer.alloc(32768 * 2);
  const systemLength = systemDirectory(image, image.length / 2);
  if (!systemLength || systemLength >= image.length / 2) throw new Error('Inference relay system directory is unverified');
  const systemRoot = image.toString('utf16le', 0, systemLength * 2).toLowerCase();
  const pins = new Map<bigint, NonNullable<ReturnType<typeof open>>>();
  const release = () => {
    for (const handle of pins.values()) close(handle);
    pins.clear();
  };
  try {
    // Only the already-running command interpreter and system console hosts may remain with the relay.
    for (const pid of initial) {
      if (pid === relay) continue;
      if (pid <= 0n || pid > 0xffffffffn) throw new Error('Inference relay job membership is unverified');
      const handle = open(0x1000, false, Number(pid));
      if (!handle) throw new Error('Inference relay job member is unverified');
      pins.set(pid, handle);
      const length: [number] = [image.length / 2];
      const expected = win32.join(systemRoot, pid === BigInt(process.ppid) ? 'cmd.exe' : 'conhost.exe');
      if (!imageName(handle, 0, image, length) || image.toString('utf16le', 0, length[0] * 2).toLowerCase() !== expected) {
        throw new Error('Inference relay job member is unverified');
      }
    }
    return {
      // The open handles pin those identities across the target's lifetime.
      targetTreeGone: () => {
        const current = listMembers();
        return current?.includes(relay) === true && current.every(pid => pid === relay || pins.has(pid));
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function runInferenceAccountTarget(socket: Socket, env: Readonly<Record<string, string>>,
  targetTreeGone: () => boolean): Promise<void> {
  socket.on('error', () => {});
  if (socket.destroyed || socket.readableEnded) {
    if (!targetTreeGone()) throw new Error('Inference relay job membership is unverified');
    return;
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('Inference target entry is missing');
  const overrides = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  const overrideKeys = new Set(Object.keys(overrides).map(name => name.toUpperCase()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !overrideKeys.has(name.toUpperCase())));
  const child = spawn(process.execPath, [...process.execArgv, entry], {
    env: { ...inherited, ...overrides },
    stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true,
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const ownerLeft = new AbortController();
  const stop = () => ownerLeft.abort();
  socket.once('end', stop);
  socket.once('close', stop);
  socket.pipe(child.stdin);
  child.stdout.pipe(socket, { end: false });
  try {
    await raceWithAbort(closed, ownerLeft.signal).catch(() => {
      try { child.kill(); } catch { /* The job verdict decides whether teardown can proceed. */ }
    });
    const exit = await runWithCeiling(async signal => {
      await raceWithAbort(closed, signal);
      while (!targetTreeGone()) await sleep(TOOL_TIMEOUT_POLICY.processGroupExitPollMs, signal);
    }, TOOL_TIMEOUT_POLICY.windowsInferenceTargetExitMs, undefined, 'Windows inference target termination');
    if (!exit.ok) throw exit.error;
  } finally {
    socket.off('end', stop);
    socket.off('close', stop);
    socket.unpipe(child.stdin);
    child.stdout.unpipe(socket);
    if (!socket.destroyed) await new Promise<void>(resolve => {
      socket.once('close', resolve);
      socket.end(resolve);
    });
  }
}

export async function serveInferenceAccountRelay(env: Readonly<Record<string, string>>): Promise<void> {
  const job = await bindInferenceAccountJob();
  try {
    const socket = await acceptHostOverLoopback({
      announce: line => { process.stdout.write(line); },
      acceptTimeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildAcceptMs,
      handshakeTimeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildHandshakeMs,
    });
    await runInferenceAccountTarget(socket, env, job.targetTreeGone);
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(INFERENCE_ACCOUNT_EXIT_RECEIPT + '\n', error => error ? reject(error) : resolve());
    });
  } finally {
    job.release();
  }
}
