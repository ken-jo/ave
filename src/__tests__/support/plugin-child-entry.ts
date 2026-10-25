/** Use the per-run bundled child entry so source tests exercise the shipped dependency boundary. */
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    pluginChildEntryPath: string;
  }
}

export function pluginChildEntryPath(): string {
  const path = inject("pluginChildEntryPath");
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("vitest.globalSetup.ts did not provide pluginChildEntryPath; run the suite through bun run test:vitest");
  }
  return path;
}
