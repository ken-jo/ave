import { isFileChangeOperation, type WorkspaceFileItem } from "./preview-targets.js";
import { workspaceFilePath, type WorkspaceChangeFile, type WorkspaceFileFilter } from "./workspace-changes.js";

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface WorkspaceTreeNode extends WorkspaceDirectoryEntry {
  children: WorkspaceTreeNode[];
  file?: WorkspaceFileItem;
  change?: WorkspaceChangeFile;
  session: boolean;
  changedDescendants: number;
  outside?: boolean;
}

export function normalizeWorkspaceTreePath(path: string, root: string | null): string {
  return workspaceFilePath(path, root ?? undefined);
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
}

/** Overlay known session paths onto bounded directory listings without reading unopened folders. */
export function buildWorkspaceTree({
  root,
  roots,
  workspaceRoot,
  childrenByPath,
  files,
  changes,
  filter,
  query,
}: {
  root: string | null;
  roots: readonly string[];
  workspaceRoot?: string;
  childrenByPath: Readonly<Record<string, readonly WorkspaceDirectoryEntry[]>>;
  files: readonly WorkspaceFileItem[];
  changes: readonly WorkspaceChangeFile[];
  filter: WorkspaceFileFilter;
  query: string;
}): { nodes: WorkspaceTreeNode[]; outsideNodes: WorkspaceTreeNode[] } {
  const defaultRoot = workspaceRoot ?? roots[0] ?? root;
  const activeRoot = root ? normalizeWorkspaceTreePath(root, null) : null;
  const normalizedRoots = roots.map((path) => normalizeWorkspaceTreePath(path, null));
  const nodes = new Map<string, WorkspaceTreeNode>();
  const ensure = (path: string, type: "file" | "directory", name = path.split("/").at(-1) ?? path): WorkspaceTreeNode => {
    const previous = nodes.get(path);
    if (previous) return previous;
    const node: WorkspaceTreeNode = { name, path, type, children: [], session: false, changedDescendants: 0 };
    nodes.set(path, node);
    return node;
  };
  for (const entries of Object.values(childrenByPath)) {
    for (const entry of entries) {
      const path = normalizeWorkspaceTreePath(entry.path, null);
      if (activeRoot && within(activeRoot, path)) ensure(path, entry.type, entry.name);
    }
  }
  const metadata = new Map<string, { file?: WorkspaceFileItem; change?: WorkspaceChangeFile }>();
  const artifactPaths = new Set<string>();
  for (const file of files) {
    const path = normalizeWorkspaceTreePath(file.path, defaultRoot);
    if (!isFileChangeOperation(file.operation)) artifactPaths.add(path);
    const previous = metadata.get(path) ?? {};
    metadata.set(path, { ...previous, file: previous.file && isFileChangeOperation(previous.file.operation) && !isFileChangeOperation(file.operation) ? previous.file : file });
  }
  for (const change of changes) {
    const path = normalizeWorkspaceTreePath(change.path, defaultRoot);
    metadata.set(path, { ...metadata.get(path), change });
  }
  const outsideNodes: WorkspaceTreeNode[] = [];
  for (const [path, metadataValue] of metadata) {
    const outside = !normalizedRoots.some((candidate) => within(candidate, path));
    if (!outside && (!activeRoot || !within(activeRoot, path))) continue;
    const node = ensure(path, "file");
    node.file = metadataValue.file ?? metadataValue.change?.file;
    node.change = metadataValue.change ?? (node.file && isFileChangeOperation(node.file.operation) ? {
      path, displayPath: node.file.path, operation: node.file.operation, added: 0, removed: 0,
      countsKnown: false, latest: false, file: node.file,
    } : undefined);
    node.session = artifactPaths.has(path);
    node.outside = outside;
    if (outside) {
      outsideNodes.push(node);
      continue;
    }
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent && activeRoot && parent !== activeRoot && within(activeRoot, parent)) {
      ensure(parent, "directory");
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  const rootNodes: WorkspaceTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.outside || !activeRoot || !within(activeRoot, node.path) || node.path === activeRoot) continue;
    const parentPath = node.path.slice(0, node.path.lastIndexOf("/"));
    const parent = nodes.get(parentPath);
    if (parent?.type === "directory") parent.children.push(node);
    else rootNodes.push(node);
  }
  const needle = query.trim().toLocaleLowerCase();
  const filterNodes = (items: WorkspaceTreeNode[]): WorkspaceTreeNode[] => items
    .sort((a, b) => a.type !== b.type ? a.type === "directory" ? -1 : 1 : a.name.localeCompare(b.name))
    .flatMap((node) => {
      const children = filterNodes(node.children);
      const changedDescendants = node.children.reduce((total, child) => total + (child.change ? 1 : child.changedDescendants), 0);
      node.changedDescendants = changedDescendants;
      const matchesFilter = filter === "all" || (filter === "changed" ? Boolean(node.change) : node.session);
      const matchesQuery = !needle || [node.name, node.path, node.file?.label, node.file?.sourceLabel].some((text) => text?.toLocaleLowerCase().includes(needle));
      if ((matchesFilter && matchesQuery && node.type === "file") || children.length > 0 || (filter === "all" && !needle && node.type === "directory")) {
        return [{ ...node, children }];
      }
      return [];
    });
  return { nodes: filterNodes(rootNodes), outsideNodes: filterNodes(outsideNodes) };
}
