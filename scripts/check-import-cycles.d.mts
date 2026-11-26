export function buildRuntimeImportGraph(
  rootInput: string,
  options?: { includeBuiltins?: boolean },
): Map<string, Set<string>>;
export function findRuntimeImportCycles(
  rootInput: string,
): Array<{ members: string[]; edges: string[] }>;
export function normalizeDisplayPath(path: string, pathSeparator?: string): string;
