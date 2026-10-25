import type { MarketplaceErrorCode, MarketplaceErrorDetail } from "../marketplace/errors.js";
import type { GitRuntimeMode } from "./git-runtime-mode.js";
import { isRecord } from "./is-record.js";

export type GitRuntimeProgress =
  | { phase: "checking" }
  | { phase: "downloading"; bytes: number; total: number }
  | { phase: "verifying" }
  | { phase: "extracting" }
  | { phase: "smoke-testing" }
  | { phase: "ready"; version: string }
  /** Codes use the marketplace error vocabulary. */
  | { phase: "failed"; code: string; message: string };

export interface GitRuntimeStatus {
  mode: GitRuntimeMode;
  state: "ready" | "missing" | "too-old";
  active: { kind: "system" | "managed"; version: string; path: string } | null;
  /** A system git that was found but is older than the minimum. */
  systemTooOld: { path: string; version: string } | null;
  managed: {
    version: string;
    installed: boolean;
    available: boolean;
    /** Pinned archive size in bytes, or null when no build is available. */
    size: number | null;
  };
  /** Retain the last session install failure until a successful install. */
  lastInstallError: { code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail } | null;
}

export type GitRuntimeResult =
  | { ok: true; status: GitRuntimeStatus }
  | { ok: false; error: "git-runtime-unavailable" | "user-keyboard-required" | "unauthorized-frame" };

export interface GitRuntimeApi {
  status(): Promise<GitRuntimeResult>;
  /** Download and install the managed copy; requires a live keyboard gesture. */
  install(): Promise<GitRuntimeResult>;
  onProgress(listener: (progress: GitRuntimeProgress) => void): () => void;
}

const PHASES = new Set(["checking", "downloading", "verifying", "extracting", "smoke-testing", "ready", "failed"]);

/** Malformed bridge status reads as unavailable. */
export function parseGitRuntimeResult(value: unknown): GitRuntimeResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false) {
    return value.error === "git-runtime-unavailable" || value.error === "user-keyboard-required" || value.error === "unauthorized-frame"
      ? { ok: false, error: value.error }
      : null;
  }
  const status = value.status;
  if (value.ok !== true || !isRecord(status) || !isRecord(status.managed)) return null;
  if (status.state !== "ready" && status.state !== "missing" && status.state !== "too-old") return null;
  return { ok: true, status: status as unknown as GitRuntimeStatus };
}

export function parseGitRuntimeProgress(value: unknown): GitRuntimeProgress | null {
  return isRecord(value) && typeof value.phase === "string" && PHASES.has(value.phase) ? (value as unknown as GitRuntimeProgress) : null;
}
