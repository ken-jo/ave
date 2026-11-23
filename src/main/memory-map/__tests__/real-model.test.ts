import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalEmbedder } from '../embedding.js';
import { verifyModelFolder } from '../model-manager.js';
import { cosine } from '../graph.js';
describe('local embedding model qualification', () => {
  it.skipIf(!process.env.AVE_E5_MODEL_DIR)('embeds multilingual paraphrases closer than unrelated text', async () => {
    const modelDir = process.env.AVE_E5_MODEL_DIR;
    assert.ok(modelDir);
    const folder = await verifyModelFolder(modelDir);
    const read = (name: string) => readFile(join(folder, name));
    const embedder = await createLocalEmbedder({ model: await read('model_qint8_avx512_vnni.onnx'), tokenizer: await read('tokenizer.json'), tokenizerConfig: await read('tokenizer_config.json') });
    try {
      const ko = await embedder.embed('설정에서 로컬 메모리 검색을 활성화하세요.');
      const en = await embedder.embed('Enable local memory search in settings.');
      const unrelated = await embedder.embed('The ocean contains many species of deep sea fish.');
      expect(ko).toHaveLength(384); expect(en).toHaveLength(384); expect(Math.hypot(...ko)).toBeCloseTo(1, 6);
      const related = cosine(ko, en); const koUnrelated = cosine(ko, unrelated); const enUnrelated = cosine(en, unrelated);
      console.log(JSON.stringify({ dimensions: ko.length, koEn: related, koUnrelated, enUnrelated }));
      expect(related).toBeGreaterThan(koUnrelated); expect(related).toBeGreaterThan(enUnrelated);
    } finally { await embedder.dispose(); }
  }, 120000);
});
