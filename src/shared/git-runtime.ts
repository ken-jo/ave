/**
 * Git runtime status and progress as the renderer sees them (design §9, §13,
 * §15.7): `ave:git:runtime:status`, `ave:git:runtime:install` and the
 * `git-runtime:progress` event.
 */
import type { GitRuntimeMode } from "./git-runtime-mode.js";

export type GitRuntimeProgress =
  | { phase: "checking" }
  | { phase: "downloading"; bytes: number; total: number }
  | { phase: "verifying" }
  | { phase: "extracting" }
  | { phase: "smoke-testing" }
  | { phase: "ready"; version: string }
  /** `code` is a marketplace error code (design §14). */
  | { phase: "failed"; code: string; message: string };

export interface GitRuntimeStatus {
  mode: GitRuntimeMode;
  state: "ready" | "missing" | "too-old";
  /** The git the marketplace runs now. */
  active: { kind: "system" | "managed"; version: string; path: string } | null;
  /** A system git that was found but is older than the minimum. */
  systemTooOld: { path: string; version: string } | null;
  managed: {
    /** The pinned version this build installs. */
    version: string;
    installed: boolean;
    /** A build is pinned for this platform and architecture. */
    available: boolean;
    /** The pinned archive's size in bytes for this platform (design §15.7); null when none is pinned. */
    size: number | null;
  };
  /** The last install attempt's failure in this session, cleared by a success. */
  lastInstallError: { code: string; message: string } | null;
}

export type GitRuntimeResult =
  | { ok: true; status: GitRuntimeStatus }
  | { ok: false; error: "git-runtime-unavailable" | "user-keyboard-required" | "unauthorized-frame" };

/** The private `window.aveApi.gitRuntime` namespace. */
export interface GitRuntimeApi {
  status(): Promise<GitRuntimeResult>;
  /** Download and install the managed copy; requires a live keyboard gesture. */
  install(): Promise<GitRuntimeResult>;
  onProgress(listener: (progress: GitRuntimeProgress) => void): () => void;
}

const PHASES = new Set(["checking", "downloading", "verifying", "extracting", "smoke-testing", "ready", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape check for what crosses the bridge; anything else is treated as unavailable. */
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
