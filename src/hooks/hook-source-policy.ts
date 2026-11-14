import type { HookConfigEntry } from "./hook-config.js";

export type HookSourceKind = "user" | "system" | "project" | "managed";

export interface HookRuntimePolicy {
  allowManagedHooksOnly: boolean;
  allowedHttpHookUrls: string[];
  httpHookAllowedEnvVars: string[];
  managedHooks: HookConfigEntry[];
}
