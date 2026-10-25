// Use the native compiler service for parsing; the unstable AST module has visitors but no text parser.
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function toWirePath(path) {
  return String(path).split("\\").join("/");
}

// A single-project snapshot needs no per-file default-project query.
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

// Parse disk files in one compiler session and preserve caller path spellings as result keys.
// Unloadable files are omitted.
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

// Parse supplied bytes in one isolated virtual filesystem; omit syntax errors.
export function parseSourceTexts(texts) {
  return withParsedSourceTexts(texts, (sources) => sources);
}

// Binding queries must finish before the callback returns and the compiler session closes.
// Only sole declaring nodes are proven; import aliases retain their local declaration.
export function withParsedSourceTexts(texts, inspect) {
  const sourceFiles = new Map();
  if (texts.size === 0) return inspect(sourceFiles, () => new Map());
  const wireByInput = new Map([...texts.keys()].map((path) => {
    const wirePath = toWirePath(resolve(tmpdir(), "ave-source-inputs", path));
    // Account for compiler path canonicalization on case-insensitive hosts.
    return [path, process.platform === "win32" ? wirePath.toLowerCase() : wirePath];
  }));
  // Refuse distinct inputs that collide in the virtual tree.
  if (new Set(wireByInput.values()).size !== texts.size) return inspect(sourceFiles, () => new Map());
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
