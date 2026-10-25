/** Non-user text may enter prompts but must lose a leading slash before it can dispatch privileged commands. */
export function stripLeadingSlash(input: string): string {
  let output = input;
  while (output.trimStart().startsWith("/")) {
    const leading = output.match(/^\s*/)?.[0] ?? "";
    const rest = output.slice(leading.length);
    output = `${leading}${rest.replace(/^\/+\s*/, "")}`;
  }
  return output;
}
