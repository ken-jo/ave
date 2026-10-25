/** Share the bootstrap wire union across main, preload, and renderer. */

/** Keep skip reasons closed so renderers can translate policy outcomes. */
export type BootstrapSkipReason = "e2e-isolated";

interface BootstrapSkip {
  reason: BootstrapSkipReason;
}

/** Computed keys need explicit locale-table checks; literal translation scans cannot see them. */
export const BOOTSTRAP_SKIP_MESSAGE_KEY: Record<BootstrapSkipReason, string> = {
  "e2e-isolated": "bootstrapStatusPill.skippedE2eIsolated",
};

export type AppBootstrapStatus =
  | { phase: "start" }
  /** Installed and failed values are plugin ids; skipped describes an entirely skipped pass. */
  | {
      phase: "complete";
      installed: string[];
      failed: Array<{ id: string; error: string }>;
      skipped?: BootstrapSkip;
    }
  /** Bootstrap-level failure messages appear verbatim in the renderer banner. */
  | { phase: "error"; message: string };
