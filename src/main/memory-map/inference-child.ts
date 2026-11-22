import type { ChildProcess } from 'node:child_process';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { cleanupAsrtSandboxAfterCommand } from '../../permissions/asrt-sandbox.js';
import { NODE_PRESERVE_SYMLINK_FLAGS, spawnConfinedChild, srtWinTargetEnv } from '../../permissions/confined-child.js';
import { createSandboxProcessHome } from '../../permissions/sandbox-process-home.js';
import { holdWindowsFilesystemGrant, type HeldWindowsGrant } from '../../permissions/windows-acl-grant-holder.js';
import { CHILD_LOOPBACK_TRANSPORT_ARG, connectToAnnouncedChild, encodeChildEnv } from '../../plugins/isolation/child-loopback-link.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { buildSafeChildEnv } from '../../tools/safe-env.js';
import { mainDir } from '../main-paths.js';
import { MemoryMapHostError } from './errors.js';
import { INFERENCE_PREFIX_BYTES } from './inference-child-serve.js';
import { assertLocalEmbeddingRuntime } from './local-runtime.js';
import { MODEL_FILES } from './model-manifest.js';
import type { MemoryInferenceTask } from './worker-client.js';

// Set in the process environment at creation, where the native runtime reads it; the network block is the boundary, this is defense in depth.
const TELEMETRY_OPT_OUT = { ORT_DISABLE_TELEMETRY: '1' } as const;
const INFERENCE_FILES = MODEL_FILES.slice(0, 3);

function write(output: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { output.write(chunk, error => { if (error) reject(error); else resolve(); }); });
}

// The child reads no model file: the host streams the verified bytes, so no grant reaches the model folder.
async function writeRequest(output: Writable, folder: string, task: MemoryInferenceTask): Promise<void> {
  const opened: { handle: FileHandle; bytes: number }[] = [];
  try {
    for (const file of INFERENCE_FILES) {
      const handle = await open(join(folder, file.name), 'r');
      opened.push({ handle, bytes: file.bytes });
      if ((await handle.stat()).size !== file.bytes) throw new MemoryMapHostError('model-integrity-failed');
    }
    const header = Buffer.from(JSON.stringify(task), 'utf8');
    const prefix = Buffer.alloc(INFERENCE_PREFIX_BYTES);
    for (const [index, n] of [header.length, ...opened.map(file => file.bytes)].entries()) prefix.writeUInt32BE(n, index * 4);
    await write(output, prefix); await write(output, header);
    for (const { handle, bytes } of opened) {
      let sent = 0;
      for await (const chunk of handle.createReadStream({ start: 0, end: bytes - 1, autoClose: false })) {
        sent += (chunk as Buffer).length;
        await write(output, chunk as Buffer);
      }
      if (sent !== bytes) throw new MemoryMapHostError('model-integrity-failed');
    }
  } finally { await Promise.all(opened.map(({ handle }) => handle.close())); }
}

async function spawnInferenceChild(): Promise<{ child: ChildProcess; input: Readable; output: Writable; release: () => void }> {
  const windows = process.platform === 'win32';
  const home = windows ? createSandboxProcessHome() : undefined;
  let grant: HeldWindowsGrant | undefined;
  let wrapped = false;
  const release = () => {
    grant?.release(); home?.cleanup();
    if (wrapped) { wrapped = false; void cleanupAsrtSandboxAfterCommand(); }
  };
  let child: ChildProcess | undefined;
  try {
    // srt-win starts only in a directory the sandbox account may read; the child writes nowhere.
    if (home) grant = await holdWindowsFilesystemGrant({ label: 'memory-map-inference:asrt-win-acl', allowRead: [home.path], allowWrite: [] });
    const held = grant;
    const entry = join(mainDir, 'memory-map-child.js');
    const baseEnv = buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: '1', ...TELEMETRY_OPT_OUT });
    const extraEnv = { ...home?.env, ...TELEMETRY_OPT_OUT };
    // Windows: srt-win delivers no spawn environment or stdin, so the child gets its environment on the cmd.exe line and an argument, and talks over authenticated loopback.
    const launch = home
      ? {
          args: [...NODE_PRESERVE_SYMLINK_FLAGS, entry, CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv(srtWinTargetEnv(baseEnv, extraEnv))],
          windowsShell: 'cmd' as const,
          windowsCommandLineEnv: { ELECTRON_RUN_AS_NODE: '1', ...TELEMETRY_OPT_OUT },
          cwd: home.path,
        }
      : { args: [entry] };
    ({ child } = await spawnConfinedChild({
      command: process.execPath,
      ...launch,
      label: 'memory-map-inference',
      egressOwner: { kind: 'worker', role: 'worker', pluginId: undefined, instanceId: 'memory-map', network: 'offline' },
      grantMode: 'deny-only',
      baseEnv,
      extraEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      onWrapped: () => { wrapped = true; },
      assertStillValid: () => held?.assertAlive(),
    }));
    const running = child;
    running.once('close', release);
    running.once('error', () => { if (running.pid === undefined) release(); });
    held?.onLost(() => running.kill());
    running.stderr?.resume();
    const { stdout, stdin } = running;
    if (!stdout || !stdin) throw new Error('[memory-map-inference] the child has no pipes');
    if (!home) return { child: running, input: stdout, output: stdin, release };
    const exited = new Promise<string>(resolve => {
      running.once('exit', (code, signal) => resolve(`code=${String(code)} signal=${String(signal)}`));
      running.once('error', error => resolve(error.message));
    });
    const socket = await connectToAnnouncedChild({ stdout, exited, timeoutMs: TOOL_TIMEOUT_POLICY.windowsPluginChildConnectMs });
    return { child: running, input: socket, output: socket, release };
  } catch (error) {
    child?.kill();
    release();
    throw error;
  }
}

/** Build or embed in a child the OS sandbox keeps off the network; without that sandbox local inference is unavailable. */
export async function runInferenceChild<T>(folder: string, task: MemoryInferenceTask, signal: AbortSignal, onProgress?: (progress: MemoryMapProgress) => void): Promise<T> {
  signal.throwIfAborted();
  assertLocalEmbeddingRuntime();
  const { child, input, output } = await spawnInferenceChild();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new Error('Memory worker cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const failed = () => finish(new Error('Memory worker failed'));
    input.on('error', failed);
    output.on('error', failed);
    const lines = createInterface({ input });
    // The line reader re-emits its input's errors.
    lines.on('error', failed);
    lines.on('line', line => {
      let message: { kind?: string; progress?: MemoryMapProgress; value?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { finish(new Error('Memory worker failed')); return; }
      if (message.kind === 'progress') { if (message.progress !== undefined) onProgress?.(message.progress); }
      else if (message.kind === 'result') finish(undefined, message.value as T);
      else finish(new Error('Memory worker failed'));
    });
    lines.once('close', () => finish(new Error('Memory worker exited before completion')));
    writeRequest(output, folder, task).catch((error: unknown) => finish(error instanceof Error ? error : new Error('Memory worker failed')));
  });
}
