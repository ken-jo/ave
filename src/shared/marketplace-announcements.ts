import { SUPPORTED_LOCALES, type Locale } from "../i18n/locale.js";
import {
  isSettingsSection,
  isSettingsTab,
  parseSettingsPath,
  type SettingsTab,
} from "./settings-tabs.js";
import { validateExternalUrl } from "./external-url.js";
import { appVersionSatisfiesMin } from "./semver-compare.js";

export const MARKETPLACE_ANNOUNCEMENT_LEVELS = [
  "info",
  "warning",
  "critical",
] as const;

type MarketplaceAnnouncementLevel =
  typeof MARKETPLACE_ANNOUNCEMENT_LEVELS[number];

/** Bound announcement buttons to keep the banner usable; recheck the server’s limit at ingress. */
const MARKETPLACE_ANNOUNCEMENT_MAX_ACTIONS = 3;

/** Announcement actions navigate only; fetched content must never mutate host settings. */
export type MarketplaceAnnouncementActionTarget =
  | { kind: "settings"; settingsTab: SettingsTab; settingsSection?: string }
  | { kind: "url"; url: string };

/** Carry all compiled labels so locale switches need no refetch. */
export interface MarketplaceAnnouncementAction {
  label: ActionLabel;
  target: MarketplaceAnnouncementActionTarget;
}

/** Normalized projection of the public announcements response. */
export interface MarketplaceAnnouncement {
  id: number;
  title: string;
  body: string;
  level: MarketplaceAnnouncementLevel;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  actions: MarketplaceAnnouncementAction[];
}

export type MarketplaceAnnouncementPayload = MarketplaceAnnouncement[];

function isMarketplaceAnnouncementLevel(
  value: unknown,
): value is MarketplaceAnnouncementLevel {
  return (
    typeof value === "string" &&
    (MARKETPLACE_ANNOUNCEMENT_LEVELS as readonly string[]).includes(value)
  );
}

/** One text per compiled language; English is always there. */
type ActionLabel = { en: string } & Partial<Record<Locale, string>>;

/** Installed locales missing from the announcement use English. */
export function announcementActionLabel(action: Pick<MarketplaceAnnouncementAction, "label">, locale: Locale): string {
  return action.label[locale] ?? action.label.en;
}

function parseActionLabel(value: unknown): ActionLabel | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label: Partial<Record<Locale, string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const text = raw[locale];
    // Require every shipped language so labels cannot render blank.
    if (typeof text !== "string" || text.trim().length === 0) return null;
    label[locale] = text.trim();
  }
  return label as ActionLabel;
}

function parseActionTarget(
  value: unknown,
): MarketplaceAnnouncementActionTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "settings") {
    // Reject unknown tabs and sections; default-tab normalization could point labels at the wrong destination.
    const path = parseSettingsPath(raw.path);
    if (path === null) return null;
    return path.section === undefined
      ? { kind: "settings", settingsTab: path.tab }
      : { kind: "settings", settingsTab: path.tab, settingsSection: path.section };
  }
  if (raw.kind === "url") {
    // External announcement destinations require HTTPS and no embedded credentials.
    const validation = validateExternalUrl(raw.url);
    if (!validation.ok) return null;
    return new URL(validation.url).protocol === "https:"
      ? { kind: "url", url: validation.url }
      : null;
  }
  return null;
}

/** Drop malformed or unsupported actions; unknown app versions hide only actions with a declared minimum. */
export function parseMarketplaceAnnouncementActions(
  value: unknown,
  appVersion: string,
): MarketplaceAnnouncementAction[] {
  if (!Array.isArray(value)) return [];
  const actions: MarketplaceAnnouncementAction[] = [];
  for (const entry of value) {
    if (actions.length >= MARKETPLACE_ANNOUNCEMENT_MAX_ACTIONS) break;
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;

    const minAppVersionRaw = raw.min_app_version !== undefined
      ? raw.min_app_version
      : raw.minAppVersion;
    if (minAppVersionRaw !== undefined && minAppVersionRaw !== null) {
      if (typeof minAppVersionRaw !== "string") continue;
      if (!appVersionSatisfiesMin(appVersion, minAppVersionRaw)) continue;
    }

    const label = parseActionLabel(raw.label);
    if (label === null) continue;
    const target = parseActionTarget(raw.target);
    if (target === null) continue;
    actions.push({ label, target });
  }
  return actions;
}

export function isMarketplaceAnnouncementAction(
  value: unknown,
): value is MarketplaceAnnouncementAction {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (parseActionLabel(raw.label) === null) return false;
  const target = raw.target;
  if (!target || typeof target !== "object") return false;
  const rawTarget = target as Record<string, unknown>;
  if (rawTarget.kind === "settings") {
    const tab = rawTarget.settingsTab;
    if (!isSettingsTab(tab)) return false;
    const section = rawTarget.settingsSection;
    return section === undefined || isSettingsSection(tab, section);
  }
  if (rawTarget.kind === "url") {
    const validation = validateExternalUrl(rawTarget.url);
    return validation.ok && new URL(validation.url).protocol === "https:";
  }
  return false;
}

/** Read bare arrays or known announcements/items arrays; other shapes contain no rows. */
function announcementRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.announcements)) return obj.announcements;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

/** Drop malformed rows individually rather than defaulting blank fields or hiding every announcement. */
function parseMarketplaceAnnouncementRow(value: unknown, appVersion: string): MarketplaceAnnouncement | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const idRaw = row.id;
  let id: number | null = null;
  if (typeof idRaw === "number" && Number.isSafeInteger(idRaw)) {
    id = idRaw;
  } else if (typeof idRaw === "string" && /^\d+$/.test(idRaw)) {
    const parsed = Number.parseInt(idRaw, 10);
    if (Number.isSafeInteger(parsed)) id = parsed;
  }
  if (id === null) return null;
  if (!isMarketplaceAnnouncementLevel(row.level)) return null;

  const createdAtRaw = row.created_at !== undefined ? row.created_at : row.createdAt;
  const startsAtRaw = row.starts_at !== undefined ? row.starts_at : row.startsAt;
  const endsAtRaw = row.ends_at !== undefined ? row.ends_at : row.endsAt;
  if (typeof row.title !== "string" || typeof row.body !== "string" || typeof createdAtRaw !== "string") {
    return null;
  }
  return {
    id,
    title: row.title,
    body: row.body,
    level: row.level,
    createdAt: createdAtRaw,
    startsAt: typeof startsAtRaw === "string" ? startsAtRaw : null,
    endsAt: typeof endsAtRaw === "string" ? endsAtRaw : null,
    actions: parseMarketplaceAnnouncementActions(row.actions, appVersion),
  };
}

export function parseMarketplaceAnnouncementRows(data: unknown, appVersion: string): MarketplaceAnnouncement[] {
  return announcementRows(data)
    .map((row) => parseMarketplaceAnnouncementRow(row, appVersion))
    .filter((announcement): announcement is MarketplaceAnnouncement => announcement !== null);
}

/** Normalize dismissed ids identically for writes and filtering; deduplicate and sort so comparisons and broadcast keys stay stable. */
export function normalizeDismissedAnnouncementIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const validIds = new Set<number>();
  for (const id of ids) {
    if (typeof id === "number" && Number.isSafeInteger(id)) {
      validIds.add(id);
    }
  }
  return Array.from(validIds).sort((a, b) => a - b);
}
