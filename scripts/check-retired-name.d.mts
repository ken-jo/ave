import type { RetiredPluginId } from "./lib/retired-plugin-ids.mjs";

export interface RetiredPluginAllowance {
  readonly path: string;
  readonly words: readonly string[];
  readonly text: string;
  readonly reason: string;
}

export interface RetiredNameOffender {
  path: string;
  inPath: boolean;
  lines: number[];
}

export declare const RETIRED_NAME: string;
export declare const RETIRED_NAME_PATTERN: RegExp;
export declare const ALLOWLIST: readonly (readonly [string, string])[];
export declare const RETIRED_PLUGIN_ALLOWLIST: readonly RetiredPluginAllowance[];

export declare function scanRetiredName(
  repoRoot: string,
  allowlist?: readonly (readonly [string, string])[],
): { offenders: RetiredNameOffender[]; stale: string[] };

export declare function scanRetiredPluginIds(
  repoRoot: string,
  allowlist?: readonly RetiredPluginAllowance[],
  ids?: readonly RetiredPluginId[],
): { offenders: (RetiredNameOffender & { id: string })[]; stale: string[] };
