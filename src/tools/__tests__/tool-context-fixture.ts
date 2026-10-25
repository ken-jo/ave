// Shared user-keyboard permission context for executor suites.
import type { ToolPermissionContext } from "../executor.js";
import type { ToolExecutionContext } from "../base.js";

export function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

export function toolExecutionContext(): ToolExecutionContext {
  return { cwd: "/tmp", extraAllowedDirectories: [], metadata: {} };
}
