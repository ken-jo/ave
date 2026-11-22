import { parentPort, workerData } from 'node:worker_threads';
import { buildGraph } from './graph.js';
import type { MemoryWorkerTask } from './worker-client.js';
// Projection only: this thread shares the host's process, so it never loads the local model.
async function run(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('Memory worker requires a parent port');
  const task = (workerData as { task: MemoryWorkerTask }).task;
  if (task.kind !== 'project') throw new Error('The projection worker does not run local inference');
  const embedder = { embed: async (): Promise<number[]> => { throw new Error('Projection requires cached vectors'); }, dispose: async () => {} };
  const value = await buildGraph(task.input, embedder, progress => port.postMessage({ kind: 'progress', progress }));
  port.postMessage({ kind: 'result', value });
  port.close();
}
void run().catch(() => { parentPort?.postMessage({ kind: 'error', error: 'graph-build-failed' }); parentPort?.close(); });
