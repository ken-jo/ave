export const TIER_INFRASTRUCTURE: readonly string[];
export const CENSUS_TRIGGERS: readonly string[];
export interface VitestTierSelection {
  census: boolean;
  reason: string;
}
export function planVitestTiers(input: { eventName: string; ref: string | undefined; plan: unknown; changedPaths: readonly string[] | null }): VitestTierSelection;
export function changedPathsFor(eventName: string, before: string | undefined, run?: (args: string[]) => string): string[] | null;
