import { createLocalEmbedder } from './embedding.js';
import { serveInferenceChild } from './inference-child-serve.js';

// The confined inference child: the only process that loads the local model.
serveInferenceChild(async (task, files, onProgress) => {
  const embedder = await createLocalEmbedder(files);
  try {
    if (task.kind === 'embed') return await embedder.embed(task.text);
    const vectors: number[][] = [];
    for (const text of task.texts) {
      vectors.push(await embedder.embed(text));
      onProgress({ jobId: task.jobId, phase: 'embedding', completed: vectors.length, total: task.texts.length });
    }
    return vectors;
  } finally { await embedder.dispose(); }
}).then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`[memory-map-child] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
