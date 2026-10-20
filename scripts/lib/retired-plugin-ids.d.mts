export interface RetiredPluginId {
  readonly words: readonly string[];
  readonly join: string;
  readonly separator: string;
  readonly reason: string;
}

export declare const RETIRED_PLUGIN_IDS: readonly RetiredPluginId[];

export declare function retiredPluginId(entry: RetiredPluginId): string;

export declare function retiredPluginPattern(entry: RetiredPluginId): RegExp;

export declare const RETIRED_PLUGIN_PATTERNS: readonly (readonly [string, RegExp])[];

export declare function retiredPluginIdsIn(text: string): string[];
