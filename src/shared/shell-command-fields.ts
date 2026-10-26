/** Inspect every command-bearing field: a read-only command field must not conceal an executable script field. */

/** Keep selectors private so consumers cannot recreate a first-match extraction loop. */
const SHELL_COMMAND_FIELDS: readonly string[] = [
  "command",
  "cmd",
  "script",
  "shellCommand",
];

/** Judge all extracted commands together; a compound is read-only only when every field is. */
export function extractShellCommands(input: Record<string, unknown>): string[] {
  const commands: string[] = [];
  for (const key of SHELL_COMMAND_FIELDS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) commands.push(value);
  }
  return commands;
}

export function hasShellCommandArgument(input: Record<string, unknown>): boolean {
  return extractShellCommands(input).length > 0;
}
