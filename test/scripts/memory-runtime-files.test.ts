import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);
const { assertMemoryRuntimeFiles, assertMemoryNotices } = require('../../scripts/lib/memory-runtime-files.cjs');
describe('memory runtime packaging', () => {
  it('keeps architecture filters independent across two targets sharing one packaging configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-package-targets-'));
    try {
      const verification = join(root, 'dist', 'src', 'main');
      const skills = join(root, 'dist', 'skill-scripts');
      mkdirSync(verification, { recursive: true });
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(verification, 'bundle-manifest.json'), JSON.stringify({ mxcVerificationBuild: false, files: [] }));
      const script = 'module.exports = {}';
      writeFileSync(join(skills, 'edit-xlsx.cjs'), script);
      writeFileSync(join(skills, 'manifest.json'), JSON.stringify({ version: 1, scripts: { 'edit-xlsx.cjs': createHash('sha256').update(script).digest('hex') } }));
      const config = JSON.parse(readFileSync('package.json', 'utf8')).build;
      const beforePack = require('../../scripts/electron-before-pack.cjs');
      const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js');
      const packager = { projectDir: root, config, debugLogger: { isEnabled: false } };
      const directory = (platform: string, arch: string) => resolve(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', platform, arch);
      const architectures = [[1, 'x64'], [3, 'arm64']] as const;
      for (const [arch, name] of architectures) {
        await beforePack({ packager, electronPlatformName: 'linux', arch });
        const matcher = getNodeModuleFileMatcher(root, root, (value: string) => value.replace(/\$\{arch\}/g, name), config.linux, packager);
        const filter = matcher.createFilter();
        const sibling = name === 'x64' ? 'arm64' : 'x64';
        expect(filter(directory('linux', name), { isDirectory: () => true }), `target directory for ${name}`).toBe(true);
        expect(filter(join(directory('linux', name), 'libonnxruntime.so.1'), { isDirectory: () => false })).toBe(true);
        expect(filter(directory('linux', sibling), { isDirectory: () => true })).toBe(false);
        expect(filter(directory('win32', name), { isDirectory: () => true })).toBe(false);
      }
      expect(config).toEqual(JSON.parse(readFileSync('package.json', 'utf8')).build);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('selects only the target native directory and refuses extra or missing binaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-runtime-'));
    try {
      const target = join(root, 'onnxruntime-node/bin/napi-v6/win32/x64');
      mkdirSync(target, { recursive: true });
      for (const name of ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll']) writeFileSync(join(target, name), 'binary');
      expect(() => assertMemoryRuntimeFiles(root, 'win32', 'x64')).not.toThrow();
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
