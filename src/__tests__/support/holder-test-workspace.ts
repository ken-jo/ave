// The conversation's default project folder for suites that run plugin children as macOS or Linux holders. Kept apart
// from mac-holder-route.ts and linux-holder-route.ts so a `vi.mock` factory can load it without pulling in the permission modules it would mock under.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isContainerHolderRouteEnabled } from "../../shared/container-platform.js";

let holderWorkspace: string | undefined;

/**
 * For `vi.mock("…/main/default-workspace-root.js", …)`: the conversation's default project folder is a temporary
 * folder, not the checkout. No holder runs an executable from a workspace, and the plugin child runtime here is the
 * checkout's own Electron (`process.execPath`); a packaged app runs its runtime from its bundle, outside any project.
 */
export function holderTestWorkspaceRoot<T extends typeof import("../../main/default-workspace-root.js")>(actual: T): T {
  if ((process.platform !== "darwin" && process.platform !== "linux") || !isContainerHolderRouteEnabled(process.platform)) return actual;
  const root = (): string => holderWorkspace ??= realpathSync.native(mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "ave-holder-workspace-")));
  return {
    ...actual,
    getDefaultWorkspaceRoot: root,
    isDefaultWorkspaceRoot: (projectRoot: string, defaultWorkspaceRoot?: string) => actual.isDefaultWorkspaceRoot(projectRoot, defaultWorkspaceRoot ?? root()),
  };
}

/** Removes the temporary project folder, if one was made. */
export function releaseHolderTestWorkspace(): void {
  if (holderWorkspace !== undefined) rmSync(holderWorkspace, { recursive: true, force: true });
  holderWorkspace = undefined;
}
