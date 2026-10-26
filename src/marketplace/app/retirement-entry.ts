import type { RetirementSuccessors } from "../../shared/alerts-types.js";

export interface RetirementEntry {
  sourceId: string;
  successors: RetirementSuccessors;
}

export interface RetirementEntryLookup {
  /** Null until an applicable retirement is known; ambiguous claims reject. */
  getRetirementEntry(pluginId: string): Promise<RetirementEntry | null>;
}
