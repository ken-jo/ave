import { isRecord } from "./is-record.js";

/** Which git the marketplace would run. `missing` means no usable installer copy (none is provided for this system, or the install-time download did not complete) and no usable system git. */
export interface GitRuntimeStatus {
  state: "ready" | "missing";
  active: { kind: "installer" | "system"; version: string } | null;
  /** A system git that was found but is older than the minimum. */
  systemTooOld: { version: string } | null;
  /** The installer provides git for this system (packaged Windows), so a `missing` state means its copy is absent or broken. */
  installerProvides: boolean;
}

export type GitRuntimeResult =
  | { ok: true; status: GitRuntimeStatus }
  | { ok: false; error: "git-runtime-unavailable" | "unauthorized-frame" };

export interface GitRuntimeApi {
  status(): Promise<GitRuntimeResult>;
}

/** Malformed bridge status reads as unavailable. */
export function parseGitRuntimeResult(value: unknown): GitRuntimeResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false) {
    return value.error === "git-runtime-unavailable" || value.error === "unauthorized-frame" ? { ok: false, error: value.error } : null;
  }
  const status = value.status;
  if (value.ok !== true || !isRecord(status)) return null;
  if (status.state !== "ready" && status.state !== "missing") return null;
  return { ok: true, status: status as unknown as GitRuntimeStatus };
}
