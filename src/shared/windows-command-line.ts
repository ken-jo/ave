export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
export const WINDOWS_COMMAND_LINE_MARGIN = 8192;

// Default spawn quoting doubles backslashes before quotes and at the end of a quoted argument.
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  const quote = (value: string): string => {
    if (value.length > 0 && !/[ \t"]/.test(value)) return value;
    return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"';
  };
  // CreateProcess counts UTF-16 code units, including the terminating NUL.
  return [command, ...args].map(quote).join(" ").length + 1;
}
