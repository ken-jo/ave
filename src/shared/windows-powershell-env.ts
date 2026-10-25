/** Build an internal Windows PowerShell 5.1 child's environment. */
export function windowsPowerShellEnv(env: Readonly<Record<string, string>>): Record<string, string>;
export function windowsPowerShellEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Let the child rebuild its edition-specific module search path.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}
