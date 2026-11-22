export function tsxChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides, TSX_DISABLE_CACHE: "1" };
}
