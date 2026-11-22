import type { Readable, Writable } from 'node:stream';
import { acceptHostOverLoopback, parseChildLaunchArgs } from '../../plugins/isolation/child-loopback-link.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import type { LocalModelBytes } from './embedding.js';
import type { MemoryInferenceTask } from './worker-client.js';

/** The request starts with four big-endian lengths: the task JSON, the model, the tokenizer and the tokenizer config. */
export const INFERENCE_PREFIX_BYTES = 16;
export type InferenceHandler = (task: MemoryInferenceTask, files: LocalModelBytes, onProgress: (progress: MemoryMapProgress) => void) => Promise<unknown>;

function readRequest(input: Readable): Promise<{ task: MemoryInferenceTask; files: LocalModelBytes }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let total: number | undefined;
    const lengths = (bytes: Buffer): [number, number, number, number] => [bytes.readUInt32BE(0), bytes.readUInt32BE(4), bytes.readUInt32BE(8), bytes.readUInt32BE(12)];
    const onEnd = () => reject(new Error('The inference request ended early'));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk); length += chunk.length;
      if (total === undefined && length >= INFERENCE_PREFIX_BYTES) total = lengths(Buffer.concat(chunks)).reduce((sum, n) => sum + n, INFERENCE_PREFIX_BYTES);
      if (total === undefined || length < total) return;
      input.off('data', onData); input.off('end', onEnd);
      if (length !== total) { reject(new Error('The inference request carries extra bytes')); return; }
      const all = Buffer.concat(chunks, length);
      const [taskLength, modelLength, tokenizerLength] = lengths(all);
      const modelAt = INFERENCE_PREFIX_BYTES + taskLength;
      const tokenizerAt = modelAt + modelLength;
      const configAt = tokenizerAt + tokenizerLength;
      resolve({
        task: JSON.parse(all.subarray(INFERENCE_PREFIX_BYTES, modelAt).toString('utf8')) as MemoryInferenceTask,
        files: { model: all.subarray(modelAt, tokenizerAt), tokenizer: all.subarray(tokenizerAt, configAt), tokenizerConfig: all.subarray(configAt) },
      });
    };
    input.on('data', onData); input.once('end', onEnd); input.once('error', reject);
    // The loopback channel arrives paused after its handshake.
    input.resume();
  });
}

async function serve(input: Readable, output: Writable, handle: InferenceHandler): Promise<void> {
  const send = (message: object) => new Promise<void>(resolve => { output.write(`${JSON.stringify(message)}\n`, () => resolve()); });
  try {
    const { task, files } = await readRequest(input);
    const value = await handle(task, files, progress => { void send({ kind: 'progress', progress }); });
    await send({ kind: 'result', value });
  } catch { await send({ kind: 'error', error: 'graph-build-failed' }); }
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
