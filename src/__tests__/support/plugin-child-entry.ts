/**
 * The plugin child entry a runtime under test spawns.
 *
 * `PluginRuntimeOptions.childEntryPath` is required and has no default (§9.8
 * A1: every `entry` plugin runs in a child). The app passes the emitted
 * `plugin-child-main.js`; a source checkout has none, so `vitest.globalSetup.ts`
 * bundles the same entry once per run, with the shipped build's boundary, and
 * provides its path here. A test that constructs a `PluginRuntime` passes this.
 */
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
