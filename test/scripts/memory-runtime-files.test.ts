import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);
const { assertMemoryRuntimeFiles, memoryRuntimeExclusions, assertMemoryNotices } = require('../../scripts/lib/memory-runtime-files.cjs');
describe('memory runtime packaging', () => {
  it('selects only the target native directory and refuses extra or missing binaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-runtime-'));
    try {
      const target = join(root, 'onnxruntime-node/bin/napi-v6/win32/x64');
      mkdirSync(target, { recursive: true });
      for (const name of ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll']) writeFileSync(join(target, name), 'binary');
      expect(() => assertMemoryRuntimeFiles(root, 'win32', 'x64')).not.toThrow();
      expect(memoryRuntimeExclusions('win32', 'x64')).toContain('!node_modules/onnxruntime-node/bin/napi-v6/linux{,/**/*}');
      mkdirSync(join(root, 'onnxruntime-node/bin/napi-v6/linux/x64'), { recursive: true });
      expect(() => assertMemoryRuntimeFiles(root, 'win32', 'x64')).toThrow('Unexpected');
      rmSync(join(root, 'onnxruntime-node/bin/napi-v6/linux'), { recursive: true });
      rmSync(join(target, 'onnxruntime.dll'));
      expect(() => assertMemoryRuntimeFiles(root, 'win32', 'x64')).toThrow('missing');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('ships versioned original notices for every memory runtime dependency', () => {
    expect(() => assertMemoryNotices('resources')).not.toThrow();
    for (const row of require('../../scripts/lib/memory-runtime-notices.json')) {
      expect(JSON.parse(readFileSync(join(row.packageRoot, 'package.json'), 'utf8')).version).toBe(row.version);
    }
  });
});
