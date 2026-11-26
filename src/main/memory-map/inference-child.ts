import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { cleanupAsrtSandboxAfterCommand } from '../../permissions/asrt-sandbox.js';
import { NODE_PRESERVE_SYMLINK_FLAGS, spawnConfinedChild, srtWinTargetEnv } from '../../permissions/confined-child.js';
import { createSandboxProcessHome, isSandboxHomeUnavailable } from '../../permissions/sandbox-process-home.js';
import { CHILD_LOOPBACK_TRANSPORT_ARG, connectToAnnouncedChild, encodeChildEnv } from '../../plugins/isolation/child-loopback-link.js';
import { spawnMxcBundledHolder } from '../../sandbox/wrap-bundled-command.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { win32SystemBinary } from '../../shared/windows-system-path.js';
import { buildSafeChildEnv } from '../../tools/safe-env.js';
import { mainDir } from '../main-paths.js';
import { spawnManaged } from '../managed-child-processes.js';
import { MemoryMapHostError } from './errors.js';
import { checkedInferenceFrameBytes, INFERENCE_FILES, INFERENCE_PREFIX_BYTES } from './inference-request.js';
import { assertLocalEmbeddingRuntime, type LocalInferenceRoute } from './local-runtime.js';
import type { ModelFile } from './model-manifest.js';
import type { MemoryInferenceTask } from './worker-client.js';

// Set in the process environment at creation, where the native runtime reads it; the network block is the boundary, this is defense in depth.
const TELEMETRY_OPT_OUT = { ORT_DISABLE_TELEMETRY: '1' } as const;
const INFERENCE_CHILD_LABEL = 'memory-map-inference';
const INFERENCE_EGRESS_OWNER = { kind: 'worker', role: 'worker', pluginId: undefined, instanceId: 'memory-map', network: 'offline' } as const;

function write(output: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { output.write(chunk, error => { if (error) reject(error); else resolve(); }); });
}

// The child reads no model file: the host streams the verified bytes, so no grant reaches the model folder.
async function writeRequest(output: Writable, folder: string, taskJson: string, lengths: readonly number[]): Promise<void> {
  const handles: FileHandle[] = [];
  const opened: { handle: FileHandle; file: ModelFile; initial: BigIntStats }[] = [];
  try {
    for (const file of INFERENCE_FILES) {
      const handle = await open(join(folder, file.name), 'r');
      handles.push(handle);
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || initial.size !== BigInt(file.bytes)) throw new MemoryMapHostError('model-integrity-failed');
      opened.push({ handle, file, initial });
    }
    const prefix = Buffer.alloc(INFERENCE_PREFIX_BYTES);
    for (const [index, bytes] of lengths.entries()) prefix.writeUInt32BE(bytes, index * 4);
    await write(output, prefix);
    await write(output, Buffer.from(taskJson, 'utf8'));
    let frameTail: Buffer | undefined;
    for (const { handle, file } of opened) {
      if (frameTail !== undefined) await write(output, frameTail);
      const hash = createHash('sha256');
      let received = 0;
      let finalChunk: Buffer | undefined;
      for await (const chunk of handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: false })) {
        const bytes = chunk as Buffer;
        received += bytes.length;
        hash.update(bytes);
        if (received === file.bytes) finalChunk = bytes;
        else await write(output, bytes);
      }
      if (finalChunk === undefined || (await handle.stat()).size !== file.bytes || hash.digest('hex') !== file.sha256) {
        throw new MemoryMapHostError('model-integrity-failed');
      }
      frameTail = finalChunk;
    }
    // Withhold the end of the frame until every streamed file has passed its final check.
    await Promise.all(opened.map(async ({ handle, initial }) => {
      const current = await handle.stat({ bigint: true });
      if (current.size !== initial.size || current.mtimeNs !== initial.mtimeNs || current.ctimeNs !== initial.ctimeNs) {
        throw new MemoryMapHostError('model-integrity-failed');
      }
    }));
    if (frameTail === undefined) throw new MemoryMapHostError('model-integrity-failed');
    await write(output, frameTail);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

function sandboxHomeOrRefusal(): ReturnType<typeof createSandboxProcessHome> {
  try {
    return createSandboxProcessHome();
  } catch (error) {
    if (isSandboxHomeUnavailable(error)) throw new MemoryMapHostError('sandbox-home-unavailable');
    throw error;
  }
}

async function spawnInferenceChild(route: LocalInferenceRoute, signal: AbortSignal): Promise<{
  input: Readable; output: Writable; stop: () => void | Promise<void>;
}> {
  const windows = process.platform === 'win32';
  const entry = join(mainDir, 'memory-map-child.js');
  const baseEnv = buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: '1', ...TELEMETRY_OPT_OUT });
  if (route === 'mxc') {
    const cwd = win32SystemBinary('');
    const runtimeReadRoots = [dirname(process.execPath), cwd];
    const holder = await spawnMxcBundledHolder({
      label: INFERENCE_CHILD_LABEL,
      command: process.execPath,
      args: [entry],
      cwd,
      baseEnv,
      holderEnv: TELEMETRY_OPT_OUT,
      allowRead: runtimeReadRoots,
      ownedReadRoots: runtimeReadRoots,
      allowWrite: [],
      egressOwner: INFERENCE_EGRESS_OWNER,
      workerTransport: 'stdio-control-v1',
      signal,
    });
    holder.process.stderr.resume();
    return { input: holder.process.stdout, output: holder.process.stdin, stop: holder.release };
  }

  const cwd = windows ? win32SystemBinary('') : undefined;
  const home = windows ? sandboxHomeOrRefusal() : undefined;
  let wrapped = false;
  const release = () => {
    home?.cleanup();
    if (wrapped) { wrapped = false; void cleanupAsrtSandboxAfterCommand(); }
  };
  let child: ChildProcess | undefined;
  try {
    const extraEnv = { ...home?.env, ...TELEMETRY_OPT_OUT };
    if (route === 'unconfined') {
      child = spawnManaged(process.execPath, [entry], {
        cwd, env: { ...baseEnv, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
      }, { label: INFERENCE_CHILD_LABEL });
    } else {
      // The account backend delivers no spawn environment or stdin, so it uses authenticated loopback.
      const launch = home
        ? {
            args: [...NODE_PRESERVE_SYMLINK_FLAGS, entry, CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv(srtWinTargetEnv(baseEnv, extraEnv))],
            windowsShell: 'cmd' as const,
            windowsCommandLineEnv: { ELECTRON_RUN_AS_NODE: '1', ...TELEMETRY_OPT_OUT },
            cwd,
          }
        : { args: [entry] };
      ({ child } = await spawnConfinedChild({
        command: process.execPath,
        ...launch,
        label: INFERENCE_CHILD_LABEL,
        egressOwner: INFERENCE_EGRESS_OWNER,
        grantMode: 'deny-only',
        baseEnv,
        extraEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        onWrapped: () => { wrapped = true; },
      }));
    }
    const running = child;
    const stop = () => { if (running.exitCode === null && running.signalCode === null) running.kill(); };
    running.once('close', release);
    running.once('error', () => { if (running.pid === undefined) release(); });
    running.stderr?.resume();
    const { stdout, stdin } = running;
    if (!stdout || !stdin) throw new Error('[memory-map-inference] the child has no pipes');
    if (!home || route === 'unconfined') return { input: stdout, output: stdin, stop };
    const exited = new Promise<string>(resolve => {
      running.once('exit', (code, signal) => resolve(`code=${String(code)} signal=${String(signal)}`));
      running.once('error', error => resolve(error.message));
    });
    const socket = await connectToAnnouncedChild({ stdout, exited, timeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildConnectMs });
    return { input: socket, output: socket, stop };
  } catch (error) {
    child?.kill();
    release();
    throw error;
  }
}

export async function runInferenceChild<T>(folder: string, task: MemoryInferenceTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, localInferenceWithoutSandbox?: boolean): Promise<T> {
  signal.throwIfAborted();
  const route = assertLocalEmbeddingRuntime(localInferenceWithoutSandbox);
  const taskJson = JSON.stringify(task);
  const lengths = [Buffer.byteLength(taskJson, 'utf8'), ...INFERENCE_FILES.map(file => file.bytes)];
  checkedInferenceFrameBytes(lengths);
  const { input, output, stop } = await spawnInferenceChild(route, signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const lines = createInterface({ input });
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      lines.close();
      void Promise.resolve().then(stop).then(
        () => { if (error) reject(error); else resolve(value as T); },
        (cleanupError: unknown) => reject(error ?? cleanupError),
      );
    };
    const abort = () => finish(new Error('Memory worker cancelled'));
    const failed = () => finish(new Error('Memory worker failed'));
    input.on('error', failed);
    output.on('error', failed);
    // The line reader re-emits its input's errors.
    lines.on('error', failed);
    lines.on('line', line => {
      if (settled) return;
      let message: { kind?: string; progress?: MemoryMapProgress; value?: unknown; error?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { finish(new Error('Memory worker failed')); return; }
      if (message.kind === 'progress') { if (message.progress !== undefined) onProgress?.(message.progress); }
      else if (message.kind === 'result') finish(undefined, message.value as T);
      else if (message.kind === 'error' && (message.error === 'invalid-input' || message.error === 'model-integrity-failed' || message.error === 'catalog-too-large')) finish(new MemoryMapHostError(message.error));
      else finish(new Error('Memory worker failed'));
    });
    lines.once('close', () => finish(new Error('Memory worker exited before completion')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    writeRequest(output, folder, taskJson, lengths).catch((error: unknown) => finish(error instanceof Error ? error : new Error('Memory worker failed')));
  });
}
