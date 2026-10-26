import { listAuthorizedWorkspaceProjects } from "../main/project-root-authorization.js";

interface WorkspaceDirectorySource {
  getTurnAdditionalDirectories(): readonly string[];
  getSessionExecutionCwd(): string;
}

// Retain readers, never copies of grants. Permission checks read these same live
// loop methods, including additions, turn expiry, session reset and revocation.
const workspaceDirectorySources = new Set<WeakRef<WorkspaceDirectorySource>>();

export function registerWorkspaceDirectorySource(source: WorkspaceDirectorySource): void {
  workspaceDirectorySources.add(new WeakRef(source));
}

// Native account grants can affect every live conversation, so protect all of
// their authorized roots, including conversations other than the current turn.
export function listAuthorizedWorkspaceRoots(): readonly string[] {
  const roots = listAuthorizedWorkspaceProjects().map(project => project.projectRoot);
  for (const reference of workspaceDirectorySources) {
    const source = reference.deref();
    if (source === undefined) {
      workspaceDirectorySources.delete(reference);
      continue;
    }
    roots.push(...source.getTurnAdditionalDirectories());
    roots.push(source.getSessionExecutionCwd());
  }
  return roots;
}
