export function windowsPowerShellEnv(env = process.env) {
  // Let the child rebuild its edition-specific module search path.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}
