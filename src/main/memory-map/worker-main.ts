import { parentPort, workerData } from 'node:worker_threads';
import { buildGraph } from './graph.js';
import type { MemoryWorkerTask } from './worker-client.js';
// Projection only: this thread shares the host's process, so it never loads the local model.
async function run(): Promise<void> {
  if (!parentPort) throw new Error('Memory worker requires a parent port');
  const task = (workerData as { task: MemoryWorkerTask }).task;
  if (task.kind !== 'project') throw new Error('The projection worker does not run local inference');
  const embedder = { embed: async (): Promise<number[]> => { throw new Error('Projection requires cached vectors'); }, dispose: async () => {} };
  const value = await buildGraph(task.input, embedder, progress => parentPort!.postMessage({ kind: 'progress', progress }));
  parentPort.postMessage({ kind: 'result', value });
  parentPort.close();
}
void run().catch(() => { parentPort?.postMessage({ kind: 'error', error: 'graph-build-failed' }); parentPort?.close(); });
