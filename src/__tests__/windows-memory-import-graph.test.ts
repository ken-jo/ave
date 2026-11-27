import { globSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const classA = [
  'src/data/settings-defaults.ts',
  'src/ipc/domains/memory-map.ts',
  'src/ipc/domains/memory-map-runtime.ts',
  'src/main/memory-map/host.ts',
  'src/main/memory-map/inference-child-main.ts',
  'src/main/memory-map/inference-child.ts',
  'src/main/memory-map/local-runtime.ts',
  'src/main/memory-map/model-manager.ts',
  'src/main/memory-map/provider-embeddings.ts',
  'src/main/memory-map/worker-client.ts',
  'src/memory/session-turn-journal.ts',
];
const selectors = new Set([
  'src/ipc/domains/chat.ts', 'src/ipc/domains/settings.ts', 'src/boot/services.ts',
  'src/boot.ts', 'src/data/settings-store.ts', 'src/data/settings-normalization.ts',
]);
const windowsModules = new Set([
  'src/ipc/domains/memory-map-win32.ts', 'src/ipc/domains/memory-map-runtime-win32.ts',
  'src/ipc/domains/sessions-search-win32.ts', 'src/memory/session-repository-win32.ts',
  'src/main/memory-map/host-win32.ts', 'src/main/memory-map/inference-child-win32.ts',
  'src/main/memory-map/local-runtime-win32.ts', 'src/main/memory-map/model-manager-win32.ts',
  'src/main/memory-map/provider-embeddings-win32.ts', 'src/main/memory-map/worker-client-win32.ts',
  'src/shared/admission-commit.ts', 'src/permissions/windows-background-features.ts',
  'src/permissions/windows-confinement-evidence.ts',
]);
// Carried Windows paths in shared files retain their existing admission edges.
const existingEdges = new Set([
  'src/boot/steps/sandbox-init.ts:windows-background-features.ts',
  'src/boot/steps/sandbox-init.ts:windows-confinement-evidence.ts',
  'src/permissions/confined-child.ts:windows-confinement-evidence.ts',
  'src/permissions/egress-host-listener.ts:admission-commit.ts',
  'src/permissions/mxc-extension-admission.ts:windows-confinement-evidence.ts',
  'src/permissions/mxc-extension-channel.ts:admission-commit.ts',
  'src/permissions/mxc-extension-process.ts:admission-commit.ts',
  'src/permissions/mxc-extension-process.ts:windows-confinement-evidence.ts',
  'src/permissions/mxc-policy-pipe.ts:admission-commit.ts',
  'src/permissions/mxc-supervisor-service.ts:admission-commit.ts',
  'src/plugins/isolation/child-loopback-link.ts:admission-commit.ts',
  'src/tools/mxc-shell-launch.ts:windows-confinement-evidence.ts',
  'src/tools/shell-tools.ts:windows-confinement-evidence.ts',
]);
const importEdge = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const portable = (path: string) => path.replaceAll('\\', '/');

function targets(file: string): string[] {
  const source = readFileSync(resolve(root, file), 'utf8');
  return [...source.matchAll(importEdge)].map(([, specifier]) =>
    portable(relative(root, resolve(root, dirname(file), specifier))).replace(/\.(?:js|jsx)$/, '.ts'));
}

it('keeps Windows admission dependencies out of the POSIX implementations', () => {
  const forbidden = /^(?:admission-commit|windows-background-features|windows-confinement-evidence|.*-win32)\.ts$/;
  expect(classA.flatMap(file => targets(file).filter(target => forbidden.test(basename(target)))
    .map(target => [file, target]))).toEqual([]);
});

it('restricts Windows implementation imports to Windows modules and their outer selectors', () => {
  const illegal = globSync('src/**/*.{ts,tsx}', { cwd: root }).map(portable)
    .filter(file => !file.split('/').includes('__tests__') && !/\.test\.[^/]+$/.test(file))
    .filter(file => !windowsModules.has(file) && !selectors.has(file))
    .flatMap(file => targets(file).filter(target => windowsModules.has(target))
      .filter(target => !existingEdges.has(file + ':' + basename(target)))
      .map(target => [file, target]));
  expect(illegal).toEqual([]);
});
