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

/**
 * An announcement carries at most this many buttons. The banner is one line of
 * chrome floating over the conversation; past three buttons it stops reading as
 * a notice and starts reading as a toolbar. Mirrors the server's
 * `ANNOUNCEMENT_MAX_ACTIONS` — the server rejects a fourth, and this drops one
 * that arrives anyway.
 */
const MARKETPLACE_ANNOUNCEMENT_MAX_ACTIONS = 3;

/**
 * Where an announcement button goes.
 *
 * Both arms NAVIGATE. Neither writes host state, and there is deliberately no
 * third arm that could: an announcement is content fetched from the
 * marketplace, so a button that flipped a setting would be a channel from a
 * marketplace post into this machine's configuration. The user turns a feature
 * on themselves at the destination.
 *
 * `settingsTab` names the page and `settingsSection` the block within it. The
 * section is optional because a notice about a whole page is a real thing to
 * write; when it is present it is one of the anchors `SETTINGS_SECTIONS` lists
 * for that tab, so the button lands on the control rather than on the page that
 * happens to contain it.
 */
export type MarketplaceAnnouncementActionTarget =
  | { kind: "settings"; settingsTab: SettingsTab; settingsSection?: string }
  | { kind: "url"; url: string };

/**
 * One button on an announcement banner, already validated and already gated —
 * an action that reaches the renderer is one this build can honour.
 *
 * The label carries every compiled language rather than pre-resolved text: the
 * user can switch language without the banner refetching, so the banner picks
 * the label at render time ({@link announcementActionLabel}).
 */
export interface MarketplaceAnnouncementAction {
  label: ActionLabel;
  target: MarketplaceAnnouncementActionTarget;
}

/**
 * Marketplace announcement payload pushed from main to renderer.
 *
 * Mirrors the public `GET /api/v1/announcements` contract after the cloud
 * fetcher has normalized trust-boundary values.
 */
export interface MarketplaceAnnouncement {
  id: number;
  title: string;
  body: string;
  level: MarketplaceAnnouncementLevel;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  /** Empty when the announcement was authored without buttons. */
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

/** The label in `locale`, or in English for an installed language the announcement does not carry. */
export function announcementActionLabel(action: Pick<MarketplaceAnnouncementAction, "label">, locale: Locale): string {
  return action.label[locale] ?? action.label.en;
}

function parseActionLabel(value: unknown): ActionLabel | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label: Partial<Record<Locale, string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const text = raw[locale];
    // Every shipped language is required. A missing one would render a blank
    // button for readers in that language rather than degrade to another.
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
    // `<tab>` or `<tab>/<section>`, and nothing else. Both halves are checked
    // against what this build actually ships, and an unrecognized one drops the
    // whole action rather than resolving it: `normalizeSettingsTab` answers
    // "llm" for anything it cannot place, which would point a button labelled
    // for one destination at another.
    const path = parseSettingsPath(raw.path);
    if (path === null) return null;
    return path.section === undefined
      ? { kind: "settings", settingsTab: path.tab }
      : { kind: "settings", settingsTab: path.tab, settingsSection: path.section };
  }
  if (raw.kind === "url") {
    // Same authority every external-navigation sink in the app uses: http(s)
    // only, no embedded credentials. Narrowed to https here because an
    // announcement is fetched content and there is no reason for one to send a
    // reader somewhere unencrypted.
    const validation = validateExternalUrl(raw.url);
    if (!validation.ok) return null;
    return new URL(validation.url).protocol === "https:"
      ? { kind: "url", url: validation.url }
      : null;
  }
  return null;
}

/**
 * Validate the `actions` array from a server announcement row and drop every
 * entry this build cannot honour.
 *
 * Revalidates what the marketplace already validated, because this is the trust
 * boundary: the app must hold up regardless of what the server sends. Dropping
 * rather than defaulting is the same rule the sibling row fields follow — a
 * malformed entry yields no button, never a button pointing somewhere it was
 * not asked to.
 *
 * `appVersion` gates each action's `min_app_version`. `appVersionSatisfiesMin`
 * fails closed, so an unresolvable running version hides gated buttons rather
 * than showing controls whose destination may not exist. An action with no
 * declared minimum is not gated at all.
 */
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

/** True when `value` is an already-normalized action — used to validate the
 *  local dev catalog, which carries the host shape rather than the wire one. */
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

/**
 * The announcement rows of a response: a bare array, or the array under
 * `announcements` (or `items`). Anything else is no rows.
 */
function announcementRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.announcements)) return obj.announcements;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

/**
 * Normalizes one announcement row of the wire contract (snake_case or
 * camelCase dates). Returns `null` for a row missing a required field, so a
 * single malformed entry never blanks the whole banner; required fields are
 * not defaulted into blank UI.
 */
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
    // Buttons this build can honour. An action naming a place this version
    // does not have is dropped here rather than carried to the renderer, so
    // the banner can only ever draw a control that leads somewhere. An empty
    // app version keeps the version gate fail-closed.
    actions: parseMarketplaceAnnouncementActions(row.actions, appVersion),
  };
}

/** Every well-formed announcement in a response; malformed rows are dropped. */
export function parseMarketplaceAnnouncementRows(data: unknown, appVersion: string): MarketplaceAnnouncement[] {
  return announcementRows(data)
    .map((row) => parseMarketplaceAnnouncementRow(row, appVersion))
    .filter((announcement): announcement is MarketplaceAnnouncement => announcement !== null);
}

/**
 * Normalize the persisted `settings.marketplace.dismissedAnnouncementIds` list
 * — the single definition of "what counts as a valid dismissed id".
 *
 * Shared because the renderer WRITES the list (`useMarketplaceAnnouncements`
 * dismiss) and main FILTERS every announcement push against it
 * (`wireAnnouncementCheck`), so the two sides must agree on which entries
 * survive and in what order. Order is load-bearing on the renderer side: the
 * dismiss path compares the normalized next list against the normalized
 * existing one element-by-element to decide whether to write at all, and on
 * the main side it feeds the broadcast dedup key.
 *
 * Accepts anything: a non-array input yields an empty list. Keeps only safe
 * integers, deduplicates, and sorts ascending.
 */
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
