import { MemoryMapHostError } from "./errors.js";

export function assertLocalEmbeddingRuntime(): void {
  // The Windows provider can be enabled by an OS collector after initialization.
  if (process.platform === "win32") throw new MemoryMapHostError("local-runtime-unavailable");
}
