export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
export const WINDOWS_COMMAND_LINE_MARGIN = 8192;

// Default spawn quoting doubles backslashes before quotes and at the end of a quoted argument.
function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[ \t"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"';
}

/** The one command-line form for native requests: the MXC request builder and the plugin adapter's intent check both use it. */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  // CreateProcess counts UTF-16 code units, including the terminating NUL.
  return windowsCommandLine(command, args).length + 1;
}
