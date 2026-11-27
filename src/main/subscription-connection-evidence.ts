import type { CodexExecutableArtifact } from "./codex-executable-artifact.js";

export function executableEvidenceKey(artifact: CodexExecutableArtifact): string {
  return JSON.stringify([artifact.executable, artifact.contentHash, artifact.companion?.executable, artifact.companion?.contentHash]);
}

export type SubscriptionAccountVerdict =
  | { kind: "connected"; accountKey?: string; planType?: string | null }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

export type SubscriptionConnectionEvidence =
  | { kind: "read"; source: object; artifact: string | null; version: string | null }
  | { kind: "artifact"; source: object; artifact: string | null; version: string | null; runtime?: "not-configured" | "unavailable" }
  | { kind: "advertisement" | "login-completed" | "logout" | "sign-out" | "transport-lost" | "retired"; source: object };

export type SubscriptionEvidenceSink = (
  evidence: SubscriptionConnectionEvidence,
) => ((verdict: SubscriptionAccountVerdict) => boolean) | undefined;
