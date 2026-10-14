import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import type { PluginManifest, PluginSandboxDeclaration } from "./public-contract.js";
import { isRecord } from "../shared/is-record.js";

/** Host-owned subtrees that a reviewed declaration may name. */
export const HOST_DIRECTORY_CATALOG = {
  runtime: { segments: ["runtime"], piercesDenyFloor: false },
  certs: { segments: ["certs"], piercesDenyFloor: true },
} as const;

/**
 * Every catalog directory a read grant may open inside the sandbox read floor.
 * Not a grant: the ceiling a wrap's own `floorPierces` must stay within.
 */
export function hostDirectoryFloorPierces(): string[] {
  return Object.values(HOST_DIRECTORY_CATALOG)
    .filter((row) => row.piercesDenyFloor)
    .map((row) => join(aveHome(), ...row.segments));
}

/** The floor pierces a plugin's reviewed declaration asked for, and no others. */
export function declaredHostDirectoryFloorPierces(sandbox: PluginSandboxDeclaration | undefined): string[] {
  return (sandbox?.read ?? []).flatMap((grant) => {
    if (grant.kind !== "hostDirectory") return [];
    const name = grant.segments[0];
    const row = Object.hasOwn(HOST_DIRECTORY_CATALOG, name) ? HOST_DIRECTORY_CATALOG[name] : undefined;
    return row?.piercesDenyFloor === true ? [join(aveHome(), ...row.segments)] : [];
  });
}

function isWhy(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 400 && value.trim().length > 0;
}

/** The host rechecks the closed declaration even when a caller supplies a stale validator. */
export function sandboxDeclarationProblem(manifest: Pick<PluginManifest, "config" | "configSchema" | "sandbox">): string | null {
  const sandbox: unknown = manifest.sandbox;
  if (sandbox === undefined) return null;
  if (!isRecord(sandbox) || Object.keys(sandbox).some((key) => key !== "read" && key !== "write")) {
    return "sandbox must be an object with only read and write";
  }
  for (const access of ["read", "write"] as const) {
    const entries = sandbox[access];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 8) return `sandbox.${access} must have at most 8 entries`;
    for (const [index, entry] of entries.entries()) {
      const location = `sandbox.${access}[${index}]`;
      if (!isRecord(entry) || !isWhy(entry.why)) return `${location}.why must have 1-400 non-blank characters`;
      if (entry.kind === "hostDirectory") {
        if (access === "write") return `${location}: hostDirectory is read only`;
        if (Object.keys(entry).some((key) => !["kind", "segments", "why"].includes(key))) return `${location} has an unknown field`;
        if (!Array.isArray(entry.segments) || entry.segments.length !== 1 ||
            typeof entry.segments[0] !== "string" || !Object.hasOwn(HOST_DIRECTORY_CATALOG, entry.segments[0])) {
          return `${location}.segments does not name a host directory`;
        }
        continue;
      }
      if (entry.kind !== "userChosenDirectory" || Object.keys(entry).some((key) => !["kind", "configKey", "why"].includes(key))) {
        return `${location} has an unknown grant kind or field`;
      }
      const key = entry.configKey;
      if (typeof key !== "string" || key.length < 1 || key.length > 128 ||
          !(Object.prototype.hasOwnProperty.call(manifest.configSchema?.properties ?? {}, key) ||
            Object.prototype.hasOwnProperty.call(manifest.config ?? {}, key))) {
        return `${location}.configKey must name a declared config key`;
      }
      const property = manifest.configSchema?.properties[key];
      if (property ? property.type !== "string" : typeof manifest.config?.[key] !== "string") {
        return `${location}.configKey must name a string config key`;
      }
    }
  }
  return null;
}
