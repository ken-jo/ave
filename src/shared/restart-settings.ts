import type { SystemSettings } from "../data/settings-store.js";

/** Startup inputs retained by main for next-launch change indicators. */
export type BootSystemSettings = Pick<SystemSettings,
  "hardwareAcceleration" | "corpCaEnabled" | "corpCaCommonName" | "corpCaDebugLog">;

/** Values captured once by the host; renderer remounts must not redefine the running launch. */
export interface BootSettingsSnapshot {
  startupSettings: BootSystemSettings;
  bootCrashReportEndpoint: string | undefined;
}

export type AppUpdateCheckResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized-frame" | "updater-unavailable" | "update-check-failed" };
