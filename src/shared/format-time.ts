/** Render all app time labels in the host’s zone and locale; main and renderer share this policy. */

import type { TranslateFn } from "../i18n/translate.js";

/** Accept epoch milliseconds from live events and ISO strings from stored records. */
export function formatHhMm(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMediumDateTime(value: number | string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Callers supply localized words; absent sub-minute wording uses just now. */
export interface RelativeTimeLabels {
  readonly justNow: () => string;
  readonly secondsAgo?: (count: number) => string;
  readonly minutesAgo: (count: number) => string;
  readonly hoursAgo: (count: number) => string;
  readonly daysAgo: (count: number) => string;
}

/** Floor relative buckets, clamp future instants to just now, and render invalid times empty. */
export function formatRelativeTime(value: number | string, labels: RelativeTimeLabels): string {
  const instant = new Date(value).getTime();
  if (!Number.isFinite(instant)) return "";
  const elapsedMs = Date.now() - instant;
  if (elapsedMs < 0) return labels.justNow();
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return labels.secondsAgo ? labels.secondsAgo(seconds) : labels.justNow();
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return labels.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.hoursAgo(hours);
  return labels.daysAgo(Math.floor(hours / 24));
}

/** Session rows share one label style; inject translation so this leaf keeps no catalog dependency. */
export function formatRelativeSessionTime(value: number | string, t: TranslateFn): string {
  return formatRelativeTime(value, {
    justNow: () => t("sidebar.justNow"),
    minutesAgo: (count) => t("sidebar.minutesAgo", { count }),
    hoursAgo: (count) => t("sidebar.hoursAgo", { count }),
    daysAgo: (count) => t("sidebar.daysAgo", { count }),
  });
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Include the instant’s numeric offset for DST-safe model context; omit seconds. */
export function formatLocalIsoWithOffset(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${offsetSign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}${offset}`;
}

/** Use seconds for settings status times, distinct from compact chat clocks. */
export function formatClockTime(value: number | string): string {
  return new Date(value).toLocaleTimeString();
}

/** Use full local date and time for settings tables, distinct from medium/short moment labels. */
export function formatDateTime(value: number | string): string {
  return new Date(value).toLocaleString();
}

export function formatMonthYear(value: number | string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(value));
}
