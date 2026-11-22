import { Tokenizer } from '@huggingface/tokenizers';
export interface Embedder { embed(text: string): Promise<number[]>; dispose(): Promise<void> }
/** The verified model, tokenizer and tokenizer config, read by the host and handed to the inference child. */
export interface LocalModelBytes { model: Uint8Array; tokenizer: Uint8Array; tokenizerConfig: Uint8Array }
export function normalizeVector(vector: number[]): number[] {
  if (vector.length !== 384 || vector.some(n => !Number.isFinite(n))) throw new Error('Expected 384 finite embedding dimensions');
  const norm = Math.hypot(...vector);
  if (norm === 0) throw new Error('Embedding has zero norm');
  return vector.map(n => n / norm);
}
export async function createLocalEmbedder(files: LocalModelBytes): Promise<Embedder> {
  process.env.ORT_DISABLE_TELEMETRY = '1';
  const { InferenceSession, Tensor } = await import('onnxruntime-node');
  const text = new TextDecoder('utf-8', { fatal: true });
  const tokenizer = new Tokenizer(JSON.parse(text.decode(files.tokenizer)), JSON.parse(text.decode(files.tokenizerConfig)));
  const session = await InferenceSession.create(files.model, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  if (session.inputNames.join(',') !== 'input_ids,attention_mask,token_type_ids' || !session.outputNames.includes('last_hidden_state')) {
    await session.release(); throw new Error('Unexpected local embedding model contract');
  }
  return {
    async embed(text) {
      const encoded = tokenizer.encode('query: ' + text, { return_token_type_ids: true });
      const trim = (values: number[]) => values.length > 512 ? [...values.slice(0, 511), values.at(-1)!] : values;
      const ids = trim(encoded.ids); const mask = trim(encoded.attention_mask); const types = trim(encoded.token_type_ids);
      const tensor = (values: number[]) => new Tensor('int64', BigInt64Array.from(values, BigInt), [1, ids.length]);
      const feeds = { input_ids: tensor(ids), attention_mask: tensor(mask), token_type_ids: tensor(types) };
      const outputs = await session.run(feeds);
      try {
        const output = outputs.last_hidden_state;
        if (!output || output.dims.length !== 3 || output.dims[0] !== 1 || output.dims[1] !== ids.length || output.dims[2] !== 384) throw new Error('Expected token embeddings with 384 dimensions');
        const pooled = Array<number>(384).fill(0); let count = 0;
        for (let i = 0; i < ids.length; i++) if (mask[i]) {
          count++;
          for (let d = 0; d < 384; d++) pooled[d] = pooled[d]! + Number(output.data[i * 384 + d]);
        }
        if (!count) throw new Error('Embedding attention mask is empty');
        return normalizeVector(pooled.map(n => n / count));
      } finally { for (const value of Object.values(feeds)) value.dispose(); for (const value of Object.values(outputs)) value.dispose(); }
    },
    dispose: () => session.release(),
  };
}
