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
} from "../workload/runtime.js";

export interface AuthorizedProjectResolution {
  project: ProjectIdentity | null;
  authorized: boolean;
}

/**
 * Display label for the app-managed default/base-directory project. Kept as the
 * literal "default" instead of the workspace folder's basename (which surfaced a
 * confusing "workspace" label in the sidebar + insights). Non-default,
 * user-picked projects still derive their name from the folder basename.
 */
export const DEFAULT_PROJECT_NAME = "default";

export function defaultWorkspaceProject(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity {
  return {
    projectRoot: defaultWorkspaceRoot,
    projectName: DEFAULT_PROJECT_NAME,
    isDefault: true,
  };
}

/**
 * The one project a broker-bound run may work in. While the exclusive
 * workload-broker route is active the guest cwd is the whole authorized set: it
 * is matched byte-for-byte, never canonicalized against the controller host's
 * filesystem (where it need not exist), and the host default workspace is not
 * a fallback. Every caller that decides "which project" goes through this
 * module, so the CLI pre-check and the session authorizer cannot disagree.
 */
function activeBrokeredWorkloadProject(): ProjectIdentity | null {
  const projection = getActiveWorkloadBrokerProjection();
  if (projection === undefined) return null;
  const projectRoot = projection.workload.cwd;
  return {
    projectRoot,
    projectName: projectBasename(projectRoot) || DEFAULT_PROJECT_NAME,
  };
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
  if (getActiveWorkloadBrokerProjection() !== undefined) {
    return isActiveWorkloadBrokerCwd(projectRoot);
  }
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
  // Same acceptance as isAuthorizedWorkspaceProjectRoot: a symlink or case
  // alias of the default workspace is that workspace, not a fallback to it.
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
