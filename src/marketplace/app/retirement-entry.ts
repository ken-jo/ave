import type { RetirementSuccessors } from "../../shared/alerts-types.js";

/** A synced source's authority to retire a plugin and transfer its choices. */
export interface RetirementEntry {
  sourceId: string;
  successors: RetirementSuccessors;
}

export interface RetirementEntryLookup {
  /** Null until an applicable retirement is known; ambiguous claims reject. */
  getRetirementEntry(pluginId: string): Promise<RetirementEntry | null>;
}
