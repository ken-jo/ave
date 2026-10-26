import type { PermissionManager } from "../../permissions/permission-manager.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";

export function distinctPathArguments(length: number): string {
  let command = "printf %s";
  for (let index = 0; command.length < length; index += 1) command += ` data/path${index}`;
  return command.slice(0, length);
}

export function checkShellPermission(
  manager: PermissionManager,
  cwd: string,
  sessionId: string,
  command: string,
  dialect: ShellRuleDialect,
  runsSandboxed: boolean,
  headless = false,
) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed },
    sessionId,
    headless,
  });
}
