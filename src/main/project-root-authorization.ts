import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { sanitizeRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import {
  disambiguateProjectNames,
  projectBasename,
  projectRootEquals,
  type ProjectIdentity,
} from "../shared/project-identity.js";
import {
  getDefaultWorkspaceRoot,
  isDefaultWorkspaceRoot,
} from "./default-workspace-root.js";
import {
  getActiveWorkloadBrokerProjection,
  isActiveWorkloadBrokerCwd,
  isWorkloadBrokerActive,
} from "../workload/runtime.js";

export interface AuthorizedProjectResolution {
  project: ProjectIdentity | null;
  authorized: boolean;
}

// Keep the managed project label stable; only user-picked projects use their folder basename.
export const DEFAULT_PROJECT_NAME = "default";

// Broker-bound runs authorize only the exact guest cwd, without host canonicalization or default-workspace fallback.
// CLI, session, listing, and execution resolution must share this authority.
function activeBrokeredWorkloadProject(): ProjectIdentity | null {
  if (!isWorkloadBrokerActive()) return null;
  const projection = getActiveWorkloadBrokerProjection();
  if (projection === undefined) return null;
  const projectRoot = projection.workload.cwd;
  return {
    projectRoot,
    projectName: projectBasename(projectRoot) || DEFAULT_PROJECT_NAME,
  };
}

export function defaultWorkspaceProject(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity {
  const brokered = activeBrokeredWorkloadProject();
  if (brokered !== null) return brokered;
  return {
    projectRoot: defaultWorkspaceRoot,
    projectName: DEFAULT_PROJECT_NAME,
    isDefault: true,
  };
}

// Whether the root a session actually bound matches the root that was requested. Byte-for-byte for a brokered guest cwd; a symlink or case alias of the
// default workspace binds the canonical default root, which is the directory the caller named.
export function sessionBoundProjectRootMatches(
  boundRoot: string | null,
  requestedRoot: string,
): boolean {
  if (boundRoot === null) return false;
  if (projectRootEquals(boundRoot, requestedRoot)) return true;
  return !isWorkloadBrokerActive()
    && isDefaultWorkspaceRoot(requestedRoot)
    && isDefaultWorkspaceRoot(boundRoot);
}

export function listAuthorizedWorkspaceProjects(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity[] {
  const brokered = activeBrokeredWorkloadProject();
  if (brokered !== null) return [brokered];
  const defaultProject = defaultWorkspaceProject(defaultWorkspaceRoot);
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const projects: ProjectIdentity[] = [defaultProject];
  for (const root of sanitizeRuntimeAllowedDirectories(additional)) {
    if (projects.some((project) => projectRootEquals(project.projectRoot, root))) continue;
    projects.push({
      projectRoot: root,
      projectName: projectBasename(root) || defaultProject.projectName,
    });
  }
  return disambiguateProjectNames(projects);
}

export function isAuthorizedWorkspaceProjectRoot(projectRoot: string): boolean {
  if (isWorkloadBrokerActive()) return isActiveWorkloadBrokerCwd(projectRoot);
  if (isDefaultWorkspaceRoot(projectRoot)) return true;
  return listAuthorizedWorkspaceProjects().some((project) => projectRootEquals(project.projectRoot, projectRoot));
}

export function resolveAuthorizedWorkspaceProject(
  requestedRoot: string | undefined,
  _requestedName?: string,
): AuthorizedProjectResolution {
  const brokered = activeBrokeredWorkloadProject();
  if (brokered !== null) {
    return !requestedRoot || isActiveWorkloadBrokerCwd(requestedRoot)
      ? { project: brokered, authorized: true }
      : { project: null, authorized: false };
  }
  if (!requestedRoot) {
    return { project: defaultWorkspaceProject(), authorized: true };
  }
  // Same acceptance as isAuthorizedWorkspaceProjectRoot: a symlink or case alias of the default workspace is that workspace, not a fallback to it.
  if (isDefaultWorkspaceRoot(requestedRoot)) {
    return { project: defaultWorkspaceProject(), authorized: true };
  }
  const authorized = listAuthorizedWorkspaceProjects().find((project) =>
    projectRootEquals(project.projectRoot, requestedRoot),
  );
  if (!authorized) {
    return { project: null, authorized: false };
  }
  return {
    project: authorized,
    authorized: true,
  };
}
