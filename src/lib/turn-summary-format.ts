/** Keep duration and byte rounding shared; callers decide when missing values should hide labels. */

export interface DurationFormatUnits {
  hour: string;
  minute: string;
  second: string;
}

export const KOREAN_DURATION_UNITS: DurationFormatUnits = {
  hour: "시간",
  minute: "분",
  second: "초",
};

const COMPACT_DURATION_UNITS: DurationFormatUnits = {
  hour: "h",
  minute: "m",
  second: "s",
};

/** Clamp invalid durations to zero; callers hide unavailable values. Localize unit labels without duplicating rounding. */
export function formatDuration(ms: number, units: DurationFormatUnits = COMPACT_DURATION_UNITS): string {
  if (!Number.isFinite(ms) || ms <= 0) return `0${units.second}`;
  if (ms < 100) return `<0.1${units.second}`;
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}${units.second}`;
  }
  if (ms < 3_600_000) {
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec - minutes * 60;
    if (Math.abs(seconds - Math.round(seconds)) < 0.05) {
      return `${minutes}${units.minute} ${Math.round(seconds)}${units.second}`;
    }
    return `${minutes}${units.minute} ${seconds.toFixed(1)}${units.second}`;
  }
  const totalMin = ms / 60_000;
  const hours = Math.floor(totalMin / 60);
  const minutes = Math.round(totalMin - hours * 60);
  return `${hours}${units.hour} ${String(minutes).padStart(2, "0")}${units.minute}`;
}

/** Use binary byte units, one decimal above bytes, and zero for invalid counts. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
