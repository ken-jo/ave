/** Build an internal Windows PowerShell 5.1 child's environment. */
export function windowsPowerShellEnv(env = process.env) {
  // Let the child rebuild its edition-specific module search path.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}
