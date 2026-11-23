export const LOCAL_MODEL_ID = 'intfloat/multilingual-e5-small';
export const LOCAL_MODEL_REVISION = '614241f622f53c4eeff9890bdc4f31cfecc418b3';
export const PREPROCESSING_REVISION = 'query-512-mask-mean-l2-v1';
export interface ModelFile { name: string; bytes: number; sha256: string }
export const MODEL_FILES: readonly ModelFile[] = Object.freeze([
  { name: 'model_qint8_avx512_vnni.onnx', bytes: 118346824, sha256: 'dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88' },
  { name: 'tokenizer.json', bytes: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { name: 'tokenizer_config.json', bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
  { name: 'config.json', bytes: 653, sha256: 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6' },
]);
export function modelFileUrl(name: string): string {
  if (!MODEL_FILES.some(file => file.name === name)) throw new Error('Unknown model file');
  return `https://huggingface.co/${LOCAL_MODEL_ID}/resolve/${LOCAL_MODEL_REVISION}/onnx/${name}`;
}
