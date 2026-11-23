import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Value imports and re-exports with a relative specifier; `import type` / `export type` are erased by the bundler.
const STATIC_EDGE = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:m?js|jsx)$/, '');
  return [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, base, join(base, 'index.ts')]
    .find(candidate => /\.(?:ts|tsx|mts)$/.test(candidate) && existsSync(candidate));
}

function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_EDGE)) {
      const specifier = match[1];
      const target = specifier === undefined ? undefined : resolveSpecifier(file, specifier);
      if (target !== undefined && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

describe('main entry and the memory map', () => {
  it('reaches no src/main/memory-map module through static imports', () => {
    const memoryMapDir = join(repoRoot, 'src', 'main', 'memory-map') + sep;
    const reached = [...staticClosure(join(repoRoot, 'src', 'main.ts'))]
      .filter(file => file.startsWith(memoryMapDir))
      .map(file => relative(repoRoot, file).split(sep).join('/'));
    expect(reached).toEqual([]);
  });

  it('still reaches the memory-map channel registration, so the walk covers the IPC domains', () => {
    const reached = staticClosure(join(repoRoot, 'src', 'main.ts'));
    expect(reached.has(join(repoRoot, 'src', 'ipc', 'domains', 'memory-map.ts'))).toBe(true);
    expect(reached.has(join(repoRoot, 'src', 'ipc', 'domains', 'memory-map-runtime.ts'))).toBe(false);
  });
});
