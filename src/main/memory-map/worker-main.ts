import { parentPort, workerData } from 'node:worker_threads';
import { createLocalEmbedder } from './embedding.js';
import { buildGraph, type GraphBuildInput } from './graph.js';
interface WorkerInput { folder: string; task: { kind: 'build'; input: GraphBuildInput } | { kind: 'embed'; text: string } }
async function run(): Promise<void> {
  if (!parentPort) throw new Error('Memory worker requires a parent port');
  const data = workerData as WorkerInput;
  const embedder = await createLocalEmbedder(data.folder);
  let value: unknown;
  try {
    value = data.task.kind === 'build' ? await buildGraph(data.task.input, embedder, progress => parentPort!.postMessage({ kind: 'progress', progress })) : await embedder.embed(data.task.text);
  } finally { await embedder.dispose(); }
  parentPort.postMessage({ kind: 'result', value });
  parentPort.close();
}
void run().catch(() => { parentPort?.postMessage({ kind: 'error', error: 'graph-build-failed' }); parentPort?.close(); });
