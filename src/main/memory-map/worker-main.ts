import { parentPort, workerData } from 'node:worker_threads';
import { createLocalEmbedder } from './embedding.js';
import { buildGraph } from './graph.js';
import type { MemoryWorkerTask } from './worker-client.js';
interface WorkerInput { folder: string; task: MemoryWorkerTask }
async function run(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('Memory worker requires a parent port');
  const data = workerData as WorkerInput;
  const embedder = data.task.kind === 'project' ? {
    embed: async (): Promise<number[]> => { throw new Error('Projection requires cached vectors'); }, dispose: async () => {},
  } : await createLocalEmbedder(data.folder);
  let value: unknown;
  try {
    value = data.task.kind !== 'embed' ? await buildGraph(data.task.input, embedder, progress => port.postMessage({ kind: 'progress', progress })) : await embedder.embed(data.task.text);
  } finally { await embedder.dispose(); }
  port.postMessage({ kind: 'result', value });
  port.close();
}
void run().catch(() => { parentPort?.postMessage({ kind: 'error', error: 'graph-build-failed' }); parentPort?.close(); });
