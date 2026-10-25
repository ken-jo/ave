import type { PluginToolInvocationContext } from "../plugins/runtime/index.js";
import type { ToolPermissionContext } from "../tools/executor.js";
import { createWorkspaceRootRevocationFilter } from "../permissions/workspace-root-lifecycle.js";

export type PluginSurfacePermissionBase = Omit<
  ToolPermissionContext,
  "additionalDirectories" | "getAdditionalDirectories" | "onTurnDirectoryGrant" | "onSessionDirectoryGrant"
>;

export interface PluginSurfacePermissionScope {
  createPermissionContext(
    context: PluginToolInvocationContext,
    base: PluginSurfacePermissionBase,
  ): ToolPermissionContext;
  /** Removing a workspace root revokes covered session grants across all plugin subjects. */
  revokeWorkspaceRoot(
    removedRoot: string,
    options?: { readonly preserveRoots?: readonly string[] },
  ): { sessionDirectoriesRemoved: number; turnDirectoriesRemoved: number };
}

export interface PluginSurfacePermissionScopeOptions {
  readPersistedDirectories: () => readonly string[];
  onSessionDirectoryAdded?: (subject: string, directory: string) => void;
  onSessionDirectoriesRevoked?: () => void;
}

export function pluginPermissionGrantSubject(context: PluginToolInvocationContext): string {
  return context.ownerPluginId ?? context.callerPluginId ?? "host";
}

export function createPluginSurfacePermissionScope(
  options: PluginSurfacePermissionScopeOptions,
): PluginSurfacePermissionScope {
  const sessionAdditionalDirectories = new Map<string, string[]>();

  const addSessionDirectory = (subject: string, directory: string): void => {
    const current = sessionAdditionalDirectories.get(subject) ?? [];
    if (current.includes(directory)) return;
    sessionAdditionalDirectories.set(subject, [...current, directory]);
    options.onSessionDirectoryAdded?.(subject, directory);
  };

  return {
    revokeWorkspaceRoot(
      removedRoot: string,
      revocation: { readonly preserveRoots?: readonly string[] } = {},
    ): { sessionDirectoriesRemoved: number; turnDirectoriesRemoved: number } {
      const isRevoked = createWorkspaceRootRevocationFilter(
        removedRoot,
        revocation.preserveRoots ?? [],
      );
      let sessionDirectoriesRemoved = 0;
      for (const [subject, directories] of sessionAdditionalDirectories) {
        const retained = directories.filter((directory) => !isRevoked(directory));
        if (retained.length === directories.length) continue;
        sessionDirectoriesRemoved += directories.length - retained.length;
        if (retained.length === 0) sessionAdditionalDirectories.delete(subject);
        else sessionAdditionalDirectories.set(subject, retained);
      }
      if (sessionDirectoriesRemoved > 0) options.onSessionDirectoriesRevoked?.();
      // Turn grants die with their invocation; only session grants are durable sweep targets.
      return { sessionDirectoriesRemoved, turnDirectoriesRemoved: 0 };
    },
    createPermissionContext(
      context: PluginToolInvocationContext,
      base: PluginSurfacePermissionBase,
    ): ToolPermissionContext {
      const subject = pluginPermissionGrantSubject(context);
      const turnAdditionalDirectories: string[] = [];
      const getAdditionalDirectories = (): readonly string[] => [
        ...options.readPersistedDirectories(),
        ...(sessionAdditionalDirectories.get(subject) ?? []),
        ...turnAdditionalDirectories,
      ];

      return {
        ...base,
        additionalDirectories: getAdditionalDirectories(),
        getAdditionalDirectories,
        onTurnDirectoryGrant: (directory) => {
          if (!turnAdditionalDirectories.includes(directory)) {
            turnAdditionalDirectories.push(directory);
          }
        },
        onSessionDirectoryGrant: (directory) => addSessionDirectory(subject, directory),
      };
    },
  };
}

/** Expose the live scope so later workspace-removal IPC reaches the single boot-owned instance. */
let activePluginSurfacePermissionScope: PluginSurfacePermissionScope | undefined;

export function setActivePluginSurfacePermissionScope(
  scope: PluginSurfacePermissionScope | undefined,
): void {
  activePluginSurfacePermissionScope = scope;
}

export function getActivePluginSurfacePermissionScope():
  | PluginSurfacePermissionScope
  | undefined {
  return activePluginSurfacePermissionScope;
}
