/** One consent level governs crash, error and usage reporting. Legacy flags are read only during migration. */
export const TELEMETRY_LEVELS = ["off", "crash", "error", "all"] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetryConsent {
  level?: TelemetryLevel;
  enabled?: boolean;
  crashReportingEnabled?: boolean;
}

export function isTelemetryLevel(value: unknown): value is TelemetryLevel {
  return TELEMETRY_LEVELS.some((level) => level === value);
}

export function telemetryLevel(settings: TelemetryConsent): TelemetryLevel {
  if (settings.level !== undefined) return settings.level;
  if (settings.enabled === true) return "all";
  return settings.crashReportingEnabled === true ? "crash" : "off";
}

export function telemetryLevelFlags(level: TelemetryLevel): { enabled: boolean; crashReportingEnabled: boolean } {
  return { enabled: level === "error" || level === "all", crashReportingEnabled: level !== "off" };
}

export const DEFAULT_TELEMETRY_ALLOWLIST: readonly string[] = Object.freeze(["localhost"]);

/** The displayed bound is exactly the one enforced, including the packaged loopback restriction. */
export function telemetryEndpointHosts(allowlistEnv: string | undefined, isPackaged: boolean): readonly string[] {
  const hosts = allowlistEnv === undefined || allowlistEnv === ""
    ? [...DEFAULT_TELEMETRY_ALLOWLIST]
    : allowlistEnv.split(",").map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0);
  return Object.freeze(hosts.filter((host) => !isPackaged || host !== "localhost"));
}

export interface EndpointValidationResult {
  valid: boolean;
  reason?: string;
}

/** URLs never carry credentials or alternate schemes; endpoint fields cannot widen the operator's host bound. */
export function validateTelemetryEndpoint(
  endpoint: string | undefined,
  opts: { isPackaged: boolean; allowlistEnv?: string; allowedHosts?: readonly string[] },
): EndpointValidationResult {
  if (typeof endpoint !== "string" || endpoint.length === 0) return { valid: false, reason: "endpoint missing" };
  let url: URL;
  try { url = new URL(endpoint); } catch { return { valid: false, reason: "endpoint not a valid URL" }; }
  if (url.protocol !== "https:") return { valid: false, reason: "protocol not allowed (https: required)" };
  if (url.username || url.password || url.hash) return { valid: false, reason: "endpoint credentials and fragments are not allowed" };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" && opts.isPackaged) return { valid: false, reason: "localhost endpoint rejected in packaged build" };
  const allowed = opts.allowedHosts ?? telemetryEndpointHosts(opts.allowlistEnv, opts.isPackaged);
  if (!allowed.includes(host)) return { valid: false, reason: "host not in telemetry allowlist" };
  return { valid: true };
}

/** Validate before any part of a cross-boundary settings write is applied. Empty endpoints explicitly disable that destination. */
export function telemetryPatchError(
  patch: unknown,
  opts: { isPackaged: boolean; allowlistEnv?: string },
): "invalid-telemetry-level" | "invalid-telemetry-endpoint" | undefined {
  if (patch === undefined) return undefined;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "invalid-telemetry-level";
  const values = patch as Record<string, unknown>;
  if (values.level !== undefined && !isTelemetryLevel(values.level)) return "invalid-telemetry-level";
  for (const key of ["endpoint", "crashReportEndpoint"] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== "string") return "invalid-telemetry-endpoint";
    const endpoint = values[key].trim();
    if (endpoint !== "" && !validateTelemetryEndpoint(endpoint, opts).valid) return "invalid-telemetry-endpoint";
  }
  return undefined;
}
