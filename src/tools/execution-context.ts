import { AsyncLocalStorage } from "node:async_hooks";

const toolExecutionCwd = new AsyncLocalStorage<string>();

// Nested calls inherit the authorized cwd through async-local state, isolating concurrent conversations without process.chdir.
export function currentToolExecutionCwd(): string | undefined {
  return toolExecutionCwd.getStore();
}

// Bind authorized cwd across the complete async chain.
export function runWithToolExecutionCwd<T>(cwd: string, fn: () => T): T {
  return toolExecutionCwd.run(cwd, fn);
}
