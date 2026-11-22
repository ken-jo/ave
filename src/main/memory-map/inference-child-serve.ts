import type { Readable, Writable } from 'node:stream';
import { acceptHostOverLoopback, parseChildLaunchArgs } from '../../plugins/isolation/child-loopback-link.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import type { LocalModelBytes } from './embedding.js';
import { MemoryMapHostError } from './errors.js';
import { checkedInferenceFrameBytes, INFERENCE_PREFIX_BYTES } from './inference-request.js';
import type { MemoryInferenceTask } from './worker-client.js';

export type InferenceHandler = (task: MemoryInferenceTask, files: LocalModelBytes, onProgress: (progress: MemoryMapProgress) => void) => Promise<unknown>;

async function readRequest(input: Readable): Promise<{ task: MemoryInferenceTask; files: LocalModelBytes }> {
  const prefix = Buffer.alloc(INFERENCE_PREFIX_BYTES);
  let prefixBytes = 0;
  let payload: Buffer | undefined;
  let payloadBytes = 0;
  // The request and response can share a socket, so keep its write side open.
  for await (const data of input.iterator({ destroyOnReturn: false })) {
    const chunk = data as Buffer;
    let offset = 0;
    if (payload === undefined) {
      offset = chunk.copy(prefix, prefixBytes);
      prefixBytes += offset;
      if (prefixBytes < prefix.length) continue;
      const lengths = [prefix.readUInt32BE(0), prefix.readUInt32BE(4), prefix.readUInt32BE(8), prefix.readUInt32BE(12)];
      const payloadSize = checkedInferenceFrameBytes(lengths) - prefix.length;
      if (chunk.length - offset > payloadSize) throw new MemoryMapHostError('invalid-input');
      payload = Buffer.allocUnsafe(payloadSize);
    }
    if (payloadBytes + chunk.length - offset > payload.length) throw new MemoryMapHostError('invalid-input');
    payloadBytes += chunk.copy(payload, payloadBytes, offset);
    if (payloadBytes !== payload.length) continue;
    const modelAt = prefix.readUInt32BE(0);
    const tokenizerAt = modelAt + prefix.readUInt32BE(4);
    const configAt = tokenizerAt + prefix.readUInt32BE(8);
    return {
      task: JSON.parse(payload.subarray(0, modelAt).toString('utf8')) as MemoryInferenceTask,
      files: { model: payload.subarray(modelAt, tokenizerAt), tokenizer: payload.subarray(tokenizerAt, configAt), tokenizerConfig: payload.subarray(configAt) },
    };
  }
  throw new Error('The inference request ended early');
}

async function serve(input: Readable, output: Writable, handle: InferenceHandler): Promise<void> {
  const send = (message: object) => new Promise<void>(resolve => { output.write(`${JSON.stringify(message)}\n`, () => resolve()); });
  try {
    const { task, files } = await readRequest(input);
    const value = await handle(task, files, progress => { void send({ kind: 'progress', progress }); });
    await send({ kind: 'result', value });
  } catch (error) {
    await send({ kind: 'error', error: error instanceof MemoryMapHostError ? error.code : 'graph-build-failed' });
  }
}

/** The child's side of one request: stdio where the host owns the pipes, the authenticated loopback channel under the Windows sandbox. */
export async function serveInferenceChild(handle: InferenceHandler): Promise<void> {
  const mode = parseChildLaunchArgs(process.argv.slice(2));
  if (mode.transport === 'relay') throw new Error('The inference child has no relay transport');
  if (mode.transport === 'stdio') return serve(process.stdin, process.stdout, handle);
  for (const [name, value] of Object.entries(mode.env)) process.env[name] = value;
  const socket = await acceptHostOverLoopback({
    announce: line => { process.stdout.write(line); },
    acceptTimeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildAcceptMs,
    handshakeTimeoutMs: TOOL_TIMEOUT_POLICY.windowsInferenceChildHandshakeMs,
  });
  await serve(socket, socket, handle);
}
