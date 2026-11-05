// Shared by the schedule panel and work board schedule tests.

/** A local wall-clock time ("2026-11-05T09:00:00") as the ISO instant the host stores. */
export const localIso = (local: string): string => new Date(local).toISOString();
