/**
 * Shared TypeScript 7 (native / Go compiler) AST access for build-check scripts.
 *
 * TS7 moved the monolithic compiler API off the default `import ts from
 * "typescript"` entry — that `.` export is now only a version stub — and split
 * the pieces under `typescript/unstable/*`. The AST module
 * (`typescript/unstable/ast`) ships the node types, `SyntaxKind`/`ScriptTarget`
 * enums, the `is*` type guards, a tokenizer (`createScanner`) and AST visitors,
 * but it has NO text->AST parser: there is no `createSourceFile` equivalent.
 * The only supported way to obtain a parsed `SourceFile` carrying the classic
 * node API (`forEachChild`, `importClause`, `getStart`, `getText`,
 * `getLineAndCharacterOfPosition`, …) is the native sync compiler service in
 * `typescript/unstable/sync`.
 *
 * This module is the ONE place that touches the explicitly-unstable
 * `typescript/unstable/*` surface. `typescript/unstable/*` may change across
 * TS7 patch releases, so if a future TS7 bump shifts it, only this file (and
 * each script's `typescript/unstable/ast` guard/enum imports) needs updating.
 */
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Normalize an OS path to the forward-slash form the compiler service expects. */
function toWirePath(path) {
  return String(path).split("\\").join("/");
}

/**
 * The project that owns `wirePath`. With one project in the snapshot it is the
 * only candidate, so the per-file `getDefaultProjectForFile` round trip to the
 * compiler service is skipped: over a whole checkout (~3,000 files) that query
 * alone was ~60% of the parse time.
 */
function projectForFile(snapshot, projects, wirePath) {
  if (projects.length === 1) return projects[0];
  return snapshot.getDefaultProjectForFile(wirePath) ?? projects.find((candidate) => candidate.program.getSourceFile(wirePath));
}

function resolveSourceFile(snapshot, projects, wirePath) {
  if (projects.length === 1) return projects[0].program.getSourceFile(wirePath);
  const preferred = snapshot.getDefaultProjectForFile(wirePath);
  const candidates = preferred ? [preferred, ...projects] : projects;
  for (const project of candidates) {
    const sourceFile = project.program.getSourceFile(wirePath);
    if (sourceFile) return sourceFile;
  }
  return undefined;
}

/**
 * Parse each on-disk file into a TypeScript `SourceFile` AST using the TS7 sync
 * compiler service, in a single short-lived server session.
 *
 * Returns a `Map` keyed by the EXACT path strings the caller passed in, so
 * callers keep their own path bookkeeping; only the wire form handed to the
 * service is normalized to forward slashes. Files are read from disk by the
 * service — matching the prior `ts.createSourceFile(readFileSync(file), …)`
 * behavior for on-disk inputs. Files the service cannot load are simply absent
 * from the result (the caller decides how to treat a miss). The script kind
 * (`.ts` vs `.tsx`) is inferred by the service from each file's extension.
 */
export function parseSourceFiles(paths) {
  const sourceFiles = new Map();
  if (paths.length === 0) return sourceFiles;

  const wireByInput = new Map(paths.map((path) => [path, toWirePath(path)]));
  const api = new API({});
  try {
    const snapshot = api.updateSnapshot({ openFiles: [...wireByInput.values()] });
    const projects = snapshot.getProjects();
    for (const [input, wirePath] of wireByInput) {
      const sourceFile = resolveSourceFile(snapshot, projects, wirePath);
      if (sourceFile) sourceFiles.set(input, sourceFile);
    }
  } finally {
    api.close();
  }
  return sourceFiles;
}

/**
 * Parse supplied source bytes without reading a checkout or executing code.
 * Results retain the caller's names; syntax errors are omitted. All inputs
 * share one isolated virtual filesystem and one short-lived compiler session.
 */
export function parseSourceTexts(texts) {
  return withParsedSourceTexts(texts, (sources) => sources);
}

/**
 * Inspect isolated source ASTs while compiler binding queries remain available.
 * The resolver maps each requested identifier to its sole declaring AST node;
 * missing or merged symbols have no proven declaration. Import aliases retain
 * their local import declaration rather than resolving to the exported symbol.
 * Binding queries must finish before the callback returns and the session closes.
 */
export function withParsedSourceTexts(texts, inspect) {
  const sourceFiles = new Map();
  if (texts.size === 0) return inspect(sourceFiles, () => new Map());
  const wireByInput = new Map([...texts.keys()].map((path) => [path, toWirePath(resolve(tmpdir(), "ave-source-inputs", path))]));
  const files = Object.fromEntries([...texts].map(([path, text]) => [wireByInput.get(path), text]));
  const filesystem = createVirtualFileSystem(files);
  const api = new API({ fs: {
    ...filesystem,
    readFile: (path) => filesystem.readFile(path) ?? null,
    getAccessibleEntries: (path) => filesystem.getAccessibleEntries(path) ?? { files: [], directories: [] },
  } });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [...wireByInput.values()] });
    const projects = snapshot.getProjects();
    const projectsByInput = new Map();
    for (const [input, wirePath] of wireByInput) {
      const project = projectForFile(snapshot, projects, wirePath);
      const sourceFile = project?.program.getSourceFile(wirePath);
      if (sourceFile && project.program.getSyntacticDiagnostics(wirePath).length === 0) {
        sourceFiles.set(input, sourceFile);
        projectsByInput.set(input, project);
      }
    }
    return inspect(sourceFiles, (path, identifiers) => {
      const project = projectsByInput.get(path);
      if (!project) throw new Error("Source binding context is unavailable");
      const symbols = identifiers.length > 0 ? project.checker.getSymbolAtLocation(identifiers) : [];
      if (symbols.length !== identifiers.length) throw new Error("Source binding resolution is incomplete");
      return new Map(identifiers.map((identifier, index) => [identifier,
        symbols[index]?.declarations.length === 1 ? symbols[index].declarations[0].resolve(project) : undefined]));
    });
  } finally {
    api.close();
  }
}
