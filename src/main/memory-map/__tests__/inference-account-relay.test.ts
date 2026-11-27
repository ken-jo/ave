import type { ChildProcess } from 'node:child_process';
import { createManagedResources, observeManagedWindowsRelayTreeExit } from '../../managed-child-processes.js';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { duplexPair, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { afterQueuedCallbacks } from '../../../__tests__/support/deferred.js';
import { bindInferenceAccountJob, runInferenceAccountTarget, serveInferenceAccountRelay } from '../inference-account-relay.js';
import { INFERENCE_ACCOUNT_EXIT_RECEIPT } from '../inference-request.js';

const { query, spawn, open, close, imageName, systemDirectory, accept } = vi.hoisted(() => ({
  query: vi.fn(), spawn: vi.fn(), open: vi.fn(), close: vi.fn(), imageName: vi.fn(), systemDirectory: vi.fn(),
  accept: vi.fn(),
}));
vi.mock('../../../plugins/isolation/child-loopback-link.js', () => ({ acceptHostOverLoopback: accept }));
vi.mock('koffi', () => ({ load: () => ({
  func: (prototype: string) => {
    if (prototype.includes('QueryInformationJobObject')) return query;
    if (prototype.includes('OpenProcess')) return open;
    if (prototype.includes('CloseHandle')) return close;
    if (prototype.includes('QueryFullProcessImageName')) return imageName;
    if (prototype.includes('GetSystemDirectory')) return systemDirectory;
    throw new Error('Unexpected Windows entry point');
  },
}) }));
vi.mock('node:child_process', () => ({ spawn }));
const host = process.platform;

beforeEach(() => {
  setProcessPlatform('win32');
  query.mockReset();
  spawn.mockReset();
  accept.mockReset();
  open.mockReset().mockImplementation((_access, _inherit, pid: number) => pid);
  close.mockReset().mockReturnValue(true);
  systemDirectory.mockReset().mockImplementation((output: Buffer) => output.write('C:\\Windows\\System32', 'utf16le') / 2);
  imageName.mockReset().mockImplementation((pid: number, _flags, output: Buffer, length: number[]) => {
    const name = pid === process.ppid ? 'cmd.exe' : 'conhost.exe';
    length[0] = output.write(`C:\\Windows\\System32\\${name}`, 'utf16le') / 2;
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  setProcessPlatform(host);
});

function job(limits: number, initialPids: number[]) {
  let pids = initialPids;
  query.mockImplementation((_job, type: number, output: Buffer) => {
    if (type === 2) output.writeUInt32LE(limits, 16);
    else if (type === 3) {
      output.writeUInt32LE(pids.length, 0);
      output.writeUInt32LE(pids.length, 4);
      pids.forEach((pid, index) => { output.writeBigUInt64LE(BigInt(pid), 8 + 8 * index); });
    } else throw new Error('Unexpected information class');
    return true;
  });
  return (members: number[]) => { pids = members; };
}

describe('account relay job evidence', () => {
  it.each(['authenticated EOF', 'accept timeout'] as const)('receipts pre-auth Cancel without starting a target (%s)', async exit => {
    job(0x2000, [process.pid]);
    const [socket, peer] = duplexPair();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_line, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return true;
    });
    try {
      if (exit === 'accept timeout') accept.mockRejectedValue(new Error('Accept timed out'));
      else accept.mockResolvedValue(socket);
      const result = serveInferenceAccountRelay({}).catch(() => undefined);
      peer.end();
      await result;
      expect.soft(spawn).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(`${INFERENCE_ACCOUNT_EXIT_RECEIPT}\n`, expect.any(Function));
    } finally {
      stderr.mockRestore();
      socket.destroy();
      peer.destroy();
    }
  });
  it.each(['bootstrap query failure', 'post-bind spawn failure'] as const)('requires the applicable exit proof for %s', async failure => {
    const wrapper = Object.assign(new EventEmitter(), { stderr: new PassThrough(), pid: 1 });
    const namespace = createManagedResources();
    const observed = observeManagedWindowsRelayTreeExit(wrapper as unknown as ChildProcess, namespace, INFERENCE_ACCOUNT_EXIT_RECEIPT);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((line, encoding, callback) => {
      wrapper.stderr.write(line);
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return true;
    });
    const [socket, peer] = duplexPair();
    try {
      if (failure === 'bootstrap query failure') query.mockReturnValue(false);
      else {
        job(0x2000, [process.pid]);
        accept.mockResolvedValue(socket);
        spawn.mockImplementation(() => {
          query.mockReturnValue(false);
          throw new Error('Target creation attempt failed');
        });
        peer.write('request');
      }

      await expect(serveInferenceAccountRelay({})).rejects.toThrow();
      await afterQueuedCallbacks();
      const replied = vi.fn();
      void observed.then(replied);
      await afterQueuedCallbacks();
      expect.soft(replied).not.toHaveBeenCalled();
      wrapper.stderr.end();
      wrapper.emit('close');
      const receipt = await observed;
      if (failure === 'bootstrap query failure') {
        expect(accept).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        expect(receipt).toBeDefined();
      } else {
        expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [...process.execArgv, process.argv[1]], {
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
          stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true,
        });
        expect(receipt).toBeUndefined();
      }
    } finally {
      stderr.mockRestore();
      socket.destroy();
      peer.destroy();
      wrapper.emit('close');
    }
  });

  it('pins preexisting infrastructure and refuses live target processes', async () => {
    const relay = process.pid;
    const parent = process.ppid;
    const consoleHost = relay + parent + 1;
    const target = consoleHost + 1;
    const setMembers = job(0x2000, [relay, parent, consoleHost]);
    const { targetTreeGone, release } = await bindInferenceAccountJob();
    setMembers([relay, parent, consoleHost, target]);
    expect(targetTreeGone()).toBe(false);
    setMembers([relay, target]);
    expect(targetTreeGone()).toBe(false);
    setMembers([parent]);
    expect(targetTreeGone()).toBe(false);
    setMembers([relay, parent, consoleHost]);
    expect(targetTreeGone()).toBe(true);
    release();
    expect(close.mock.calls).toEqual([[parent], [consoleHost]]);
  });

  it('refuses a console lookalike or a job member it cannot inspect', async () => {
    job(0x2000, [process.pid, process.ppid + process.pid + 1]);
    imageName.mockImplementationOnce((_pid, _flags, output: Buffer, length: number[]) => {
      length[0] = output.write('C:\\example\\conhost.exe', 'utf16le') / 2;
      return true;
    });
    await expect(bindInferenceAccountJob()).rejects.toThrow('member is unverified');
    open.mockReturnValueOnce(null);
    await expect(bindInferenceAccountJob()).rejects.toThrow('member is unverified');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([0x0800, 0x1000])('refuses a job whose limits permit breakaway (%i)', async limits => {
    job(limits, [process.pid]);
    await expect(bindInferenceAccountJob()).rejects.toThrow('cannot prove target ownership');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses unavailable or unrelated job membership before starting a target', async () => {
    query.mockReturnValue(false);
    await expect(bindInferenceAccountJob()).rejects.toThrow('cannot prove target ownership');
    job(0x2000, [process.ppid]);
    await expect(bindInferenceAccountJob()).rejects.toThrow('membership is unverified');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['stop failed', 'process still in job'] as const)('produces no verified exit when %s', async failure => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [socket, peer] = duplexPair();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    if (failure === 'stop failed') child.kill.mockImplementation(() => { throw new Error('Stop failed'); });
    spawn.mockReturnValue(child);
    const targetTreeGone = vi.fn(() => false);
    const result = runInferenceAccountTarget(socket as unknown as Socket, {}, targetTreeGone).catch(error => error as Error);
    try {
      peer.write('request');
      await afterQueuedCallbacks();
      socket.destroy();
      await afterQueuedCallbacks();
      expect(child.kill).toHaveBeenCalledOnce();
      if (failure === 'process still in job') child.emit('close');
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBeInstanceOf(Error);
      if (failure === 'process still in job') expect(targetTreeGone).toHaveBeenCalled();
      else expect(targetTreeGone).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      peer.destroy();
    }
  });
});
