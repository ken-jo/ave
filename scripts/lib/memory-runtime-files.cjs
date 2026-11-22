const { readdirSync, statSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const notices = require('./memory-runtime-notices.json');
const PLATFORMS = ['darwin', 'linux', 'win32'];
const ARCHES = ['x64', 'arm64'];
function assertMemoryRuntimeFiles(nodeModules, platform, arch) {
  if (!PLATFORMS.includes(platform) || !ARCHES.includes(arch)) throw new Error('Unsupported memory runtime target: ' + platform + '/' + arch);
  const root = join(nodeModules, 'onnxruntime-node/bin/napi-v6');
  for (const p of readdirSync(root)) {
    if (p !== platform) throw new Error('Unexpected memory runtime platform: ' + p);
    for (const a of readdirSync(join(root, p))) if (a !== arch) throw new Error('Unexpected memory runtime architecture: ' + a);
  }
  const names = platform === 'win32' ? ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll'] :
    ['onnxruntime_binding.node', platform === 'darwin' ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1'];
  for (const name of names) if (!statSync(join(root, platform, arch, name), { throwIfNoEntry: false })?.size) throw new Error('Memory runtime binary missing: ' + name);
}
function assertMemoryNotices(resources) {
  for (const row of notices) {
    const bytes = readFileSync(join(resources, 'licenses/memory', row.noticeFile));
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('Memory runtime notice mismatch: ' + row.packageName);
  }
}
module.exports = { assertMemoryRuntimeFiles, assertMemoryNotices };
