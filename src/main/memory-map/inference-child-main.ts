import { createLocalEmbedder } from './embedding.js';
import { buildGraph } from './graph.js';
import { serveInferenceChild } from './inference-child-serve.js';

// The confined inference child: the only process that loads the local model.
serveInferenceChild(async (task, files, onProgress) => {
  const embedder = await createLocalEmbedder(files);
  try {
    return task.kind === 'build' ? await buildGraph(task.input, embedder, onProgress) : await embedder.embed(task.text);
  } finally { await embedder.dispose(); }
}).then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`[memory-map-child] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
