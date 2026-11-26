import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { cleanupAsrtSandboxAfterCommand } from '../../permissions/asrt-sandbox.js';
import { NODE_PRESERVE_SYMLINK_FLAGS, spawnConfinedChild, srtWinTargetEnv } from '../../permissions/confined-child.js';
import { createSandboxProcessHome, isSandboxHomeUnavailable } from '../../permissions/sandbox-process-home.js';
import { CHILD_LOOPBACK_TRANSPORT_ARG, connectToAnnouncedChild, encodeChildEnv } from '../../plugins/isolation/child-loopback-link.js';
import { spawnMxcBundledHolder } from '../../sandbox/wrap-bundled-command.js';
import { commitUnderAdmission } from '../../shared/admission-commit.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { win32SystemBinary } from '../../shared/windows-system-path.js';
import { buildSafeChildEnv } from '../../tools/safe-env.js';
import { mainDir } from '../main-paths.js';
import { spawnManaged } from '../managed-child-processes.js';
import { MemoryMapHostError } from './errors.js';
import { checkedInferenceFrameBytes, INFERENCE_FILES, INFERENCE_PREFIX_BYTES } from './inference-request.js';
import { assertLocalEmbeddingRuntime, bindLocalEmbeddingRuntime, refreshLocalInferenceAdmission, type LocalInferenceRoute } from './local-runtime.js';
import type { ModelFile } from './model-manifest.js';
import type { MemoryInferenceTask } from './worker-client.js';

// Set in the process environment at creation, where the native runtime reads it; the network block is the boundary, this is defense in depth.
const TELEMETRY_OPT_OUT = { ORT_DISABLE_TELEMETRY: '1' } as const;
const INFERENCE_CHILD_LABEL = 'memory-map-inference';
const INFERENCE_EGRESS_OWNER = { kind: 'worker', role: 'worker', pluginId: undefined, instanceId: 'memory-map', network: 'offline' } as const;

// Every dispatch to the child crosses the admission boundary: a refusal sends nothing.
function send(output: Writable, chunk: Buffer, assertStillValid: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      commitUnderAdmission(assertStillValid, () => { output.write(chunk, error => { if (error) reject(error); else resolve(); }); });
    } catch (error) { reject(error as Error); }
  });
}

// The child reads no model file: the host streams the verified bytes, so no grant reaches the model folder.
async function writeRequest(output: Writable, folder: string, taskJson: string, lengths: readonly number[], assertStillValid: () => void): Promise<void> {
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
    await send(output, prefix, assertStillValid);
    await send(output, Buffer.from(taskJson, 'utf8'), assertStillValid);
    let frameTail: Buffer | undefined;
    for (const { handle, file } of opened) {
      if (frameTail !== undefined) await send(output, frameTail, assertStillValid);
      const hash = createHash('sha256');
      let received = 0;
      let finalChunk: Buffer | undefined;
      for await (const chunk of handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: false })) {
        const bytes = chunk as Buffer;
        received += bytes.length;
        hash.update(bytes);
        if (received === file.bytes) finalChunk = bytes;
        else await send(output, bytes, assertStillValid);
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
    await send(output, frameTail, assertStillValid);
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

async function spawnInferenceChild(readRoute: () => LocalInferenceRoute, signal: AbortSignal): Promise<{
  input: Readable; output: Writable; stop: () => void | Promise<void>; assertStillValid: () => void;
}> {
  signal.throwIfAborted();
  const { route, assertStillValid: assertRoute } = bindLocalEmbeddingRuntime(readRoute);
  const assertStillValid = () => {
    signal.throwIfAborted();
    assertRoute();
  };
  const windows = process.platform === 'win32';
  const entry = join(mainDir, 'memory-map-child.js');
  const baseEnv = buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: '1', ...TELEMETRY_OPT_OUT });
  if (route === 'mxc') {
    const cwd = win32SystemBinary('');
    const runtimeReadRoots = [dirname(process.execPath), cwd];
    assertStillValid();
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
      assertStillValid,
    });
    // The supervisor splits a write into frames across yields; each frame takes the same check.
    holder.process.fenceInput(assertStillValid);
    holder.process.stderr.resume();
    return { input: holder.process.stdout, output: holder.process.stdin, stop: holder.release, assertStillValid };
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
    assertStillValid();
    if (route === 'unconfined') {
      if (!isAbsolute(entry)) throw new Error('Inference child entry must be absolute');
      child = spawnManaged(process.execPath, [entry], {
        cwd, env: { ...baseEnv, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
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
        assertStillValid,
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
    if (!home || route === 'unconfined') return { input: stdout, output: stdin, stop, assertStillValid };
    const exited = new Promise<string>(resolve => {
      running.once('exit', (code, signal) => resolve(`code=${String(code)} signal=${String(signal)}`));
      running.once('error', error => resolve(error.message));
    });
    const socket = await connectToAnnouncedChild({ stdout, exited, timeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildConnectMs });
    return { input: socket, output: socket, stop, assertStillValid };
  } catch (error) {
    child?.kill();
    release();
    throw error;
  }
}

export async function runInferenceChild<T>(folder: string, task: MemoryInferenceTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, readLocalInferencePreference?: () => boolean): Promise<T> {
  signal.throwIfAborted();
  const admission = await refreshLocalInferenceAdmission();
  const readRoute = () => assertLocalEmbeddingRuntime(readLocalInferencePreference?.(), admission);
  signal.throwIfAborted();
  const taskJson = JSON.stringify(task);
  const lengths = [Buffer.byteLength(taskJson, 'utf8'), ...INFERENCE_FILES.map(file => file.bytes)];
  checkedInferenceFrameBytes(lengths);
  const { input, output, stop, assertStillValid } = await spawnInferenceChild(readRoute, signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const lines = createInterface({ input });
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      lines.close();
      if (error) {
        output.destroy();
        input.destroy();
      }
      void Promise.resolve().then(stop).then(
        () => {
          if (error) { reject(error); return; }
          // Cleanup yielded, so the result leaves under the receipt as it stands now.
          try { commitUnderAdmission(assertStillValid, () => resolve(value as T)); } catch (refusal) { reject(refusal as Error); }
        },
        (cleanupError: unknown) => reject(error ?? cleanupError),
      );
    };
    const abort = () => finish(new Error('Memory worker cancelled'));
    const failed = () => finish(new Error('Memory worker failed'));
    const refuse = (error: unknown) => finish(error instanceof Error ? error : new Error('Memory worker failed'));
    input.on('error', failed);
    output.on('error', failed);
    // The line reader re-emits its input's errors.
    lines.on('error', failed);
    lines.on('line', line => {
      if (settled) return;
      let message: { kind?: string; progress?: MemoryMapProgress; value?: unknown; error?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { finish(new Error('Memory worker failed')); return; }
      if (message.kind === 'progress') {
        const { progress } = message;
        if (progress === undefined || onProgress === undefined) return;
        try { commitUnderAdmission(assertStillValid, () => onProgress(progress)); } catch (error) { refuse(error); }
      }
      else if (message.kind === 'result') {
        try { assertStillValid(); } catch (error) { refuse(error); return; }
        finish(undefined, message.value as T);
      }
      else if (message.kind === 'error' && (message.error === 'invalid-input' || message.error === 'model-integrity-failed' || message.error === 'catalog-too-large')) finish(new MemoryMapHostError(message.error));
      else finish(new Error('Memory worker failed'));
    });
    lines.once('close', () => finish(new Error('Memory worker exited before completion')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { assertStillValid(); } catch (error) { refuse(error); return; }
    void writeRequest(output, folder, taskJson, lengths, assertStillValid).catch(refuse);
  });
}
