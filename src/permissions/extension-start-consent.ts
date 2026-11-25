/** Per-start human consent for an extension start that nothing confines, and the starts waiting for it. */
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { turnExtensionPolicyContext } from "../shared/turn-extension-policy.js";

const log = createLogger("extension-start-consent");

export const EXTENSION_START_CONSENT_REQUIRED_CODE = "extension-start-consent-required";

/** Why the start would run without OS isolation. */
export type ExtensionStartUnconfinedCause = "no-backend" | "home-privacy-unverified";

export class ExtensionStartConsentRequiredError extends Error {
  readonly code = EXTENSION_START_CONSENT_REQUIRED_CODE;
  constructor(readonly unconfinedCause: ExtensionStartUnconfinedCause) {
    super(`Extension start needs approval: it would run without OS isolation (${unconfinedCause}; ${EXTENSION_START_CONSENT_REQUIRED_CODE})`);
    this.name = "ExtensionStartConsentRequiredError";
  }
}

export function isExtensionStartConsentRequired(error: unknown): error is ExtensionStartConsentRequiredError {
  return error instanceof ExtensionStartConsentRequiredError;
}

declare const EXTENSION_START_CONSENT: unique symbol;
/** Opaque, single-use, bound to one start key. Minted only by a human answer in this module. */
interface ExtensionStartConsent { readonly [EXTENSION_START_CONSENT]: true }
export interface ExtensionStartAuthority { readonly key: string; readonly consent: ExtensionStartConsent }

const liveConsents = new WeakMap<ExtensionStartConsent, string>();

function mintAuthority(key: string): ExtensionStartAuthority {
  const consent = Object.freeze({}) as ExtensionStartConsent;
  liveConsents.set(consent, key);
  return Object.freeze({ key, consent });
}

/** What a start shows the gate: its own key, the consent threaded to it, and whether this crossing is the spawn. */
export interface ExtensionStartPresentation {
  readonly key: string;
  readonly authority: ExtensionStartAuthority | undefined;
  /** The spawn crossing spends the consent; earlier crossings of the same start leave it live. */
  readonly spend?: boolean;
}

function isConsentObject(authority: ExtensionStartAuthority | undefined): authority is ExtensionStartAuthority {
  return typeof authority === "object" && authority !== null && typeof authority.consent === "object" && authority.consent !== null;
}

/** True when the consent is live for exactly this start. A spend burns it whether it matched or not. */
export function presentExtensionStartConsent(start: ExtensionStartPresentation | undefined): boolean {
  if (start === undefined || !isConsentObject(start.authority)) return false;
  const live = start.authority.key === start.key && liveConsents.get(start.authority.consent) === start.key;
  if (start.spend === true) liveConsents.delete(start.authority.consent);
  return live;
}

function burnExtensionStartConsent(authority: ExtensionStartAuthority): void {
  liveConsents.delete(authority.consent);
}

type PendingExtensionStartKind = "plugin-child" | "mcp-stdio" | "worker" | "plugin-hook";

/** What the gate says about a waiting start now: a backend confines it, it still needs a person, or it is refused outright. */
export type ExtensionStartRecheck = "confined" | "refused" | ExtensionStartUnconfinedCause;

export interface PendingExtensionStart {
  /** One start identity; a consent answers this key only. */
  readonly key: string;
  readonly kind: PendingExtensionStartKind;
  /** Shown on the card and the notice. */
  readonly label: string;
  readonly cause: ExtensionStartUnconfinedCause;
  /** Re-runs the start after a yes; it picks the parked consent up by key. Absent: the owner's next start does. */
  readonly retry?: () => Promise<void>;
  /** Asked again before any card: the backend may have become ready since the start was refused. */
  readonly recheck?: () => ExtensionStartRecheck;
}

export const pluginChildStartKey = (pluginId: string): string => `plugin-child:${pluginId}`;
export const mcpStdioStartKey = (serverId: string): string => `mcp-stdio:${serverId}`;
export const workerStartKey = (pluginId: string, workerId: string): string => `worker:${pluginId}/${workerId}`;
export const pluginHookStartKey = (pluginId: string, hookId: string): string => `plugin-hook:${pluginId}/${hookId}`;

/** A plugin names itself, so its id is always shown beside the name it chose. */
export const pluginStartLabel = (pluginId: string, name?: string): string =>
  name === undefined || name === pluginId ? pluginId : `${name} (${pluginId})`;

export interface ExtensionStartSession {
  readonly sessionId: string;
  /** A person is at this session's approval surface. */
  readonly attended: boolean;
  readonly abortSignal?: AbortSignal;
}

/** The session of the turn this call runs in. Outside a turn, or in one no person watches, it is unattended. */
export function turnExtensionStartSession(sessionId: string): ExtensionStartSession {
  const turn = turnExtensionPolicyContext.getStore();
  const attended = turn !== undefined && turn.headless !== true && turn.ownerUnattended !== true
    && turn.approvalSurface !== "unavailable" && turn.remoteControllerAuthority === undefined && turn.withholdSessionAuthority !== true;
  return { sessionId, attended, ...(turn?.abortSignal ? { abortSignal: turn.abortSignal } : {}) };
}

type ExtensionStartNotice = "declined" | "unattended";

export interface ExtensionStartAsker {
  /** One card for one start. "no-approver": nobody answered. */
  ask(start: PendingExtensionStart, session: ExtensionStartSession): Promise<"yes" | "no" | "no-approver">;
  /** One install-hint notice per start and reason. */
  notify(start: PendingExtensionStart, why: ExtensionStartNotice): void;
  /** Audit row for a start that did not run, or that ran confined after waiting. */
  record?(event: "waiting" | "confined" | ExtensionStartNotice, start: PendingExtensionStart): void;
}

type Entry = PendingExtensionStart & { state: "pending" | "asking" | "declined" };

/** How long a consent waits for a start that has no retry of its own. */
export const EXTENSION_START_GRANT_TTL_MS = 5 * 60_000;

// A list, so one card could show every waiting start later; today each start gets its own card.
const entries = new Map<string, Entry>();
const parked = new Map<string, { authority: ExtensionStartAuthority; expiresAt: number }>();
const asking = new Set<string>();
const noticed = new Set<string>();
const recordedWaiting = new Set<string>();
// Bumped when an extension is removed: an answer that arrives afterwards starts nothing.
const removals = new Map<string, number>();
let asker: ExtensionStartAsker | undefined;

function record(event: Parameters<NonNullable<ExtensionStartAsker["record"]>>[0], start: PendingExtensionStart): void {
  try {
    asker?.record?.(event, start);
  } catch (error) {
    log.warn(`extension start audit failed (${start.kind}): %s`, errorMessage(error));
  }
}

function recordWaiting(entry: Entry): void {
  if (recordedWaiting.has(entry.key) || asker?.record === undefined) return;
  recordedWaiting.add(entry.key);
  record("waiting", entry);
}

function forget(key: string): void {
  entries.delete(key);
  recordedWaiting.delete(key);
}

export function setExtensionStartAsker(next: ExtensionStartAsker | undefined): void {
  asker = next;
  // Starts deferred during boot, before the sink existed, are recorded now.
  for (const entry of entries.values()) recordWaiting(entry);
}

export function listPendingExtensionStarts(): readonly (PendingExtensionStart & { readonly state: Entry["state"] })[] {
  return [...entries.values()].map((entry) => ({ ...entry }));
}

/** A sessionless site records its start here instead of running it. A declined start stays declined. */
export function deferExtensionStart(start: PendingExtensionStart): void {
  const existing = entries.get(start.key);
  // A start being asked about, or already declined, keeps its entry.
  if (existing !== undefined && existing.state !== "pending") return;
  const entry: Entry = { ...start, state: "pending" };
  entries.set(start.key, entry);
  recordWaiting(entry);
}

/** The consent a yes parked for this key, removed from the list; the caller threads it to its spawn. */
export function takeExtensionStartGrant(key: string): ExtensionStartAuthority | undefined {
  const grant = parked.get(key);
  if (grant === undefined) return undefined;
  parked.delete(key);
  if (Date.now() < grant.expiresAt) return grant.authority;
  burnExtensionStartConsent(grant.authority);
  return undefined;
}

/** The extension behind this key is gone or reconfigured: nothing waits for it and no answer starts it. */
export function dropExtensionStart(key: string): void {
  removals.set(key, (removals.get(key) ?? 0) + 1);
  forget(key);
  for (const why of ["declined", "unattended"]) noticed.delete(`${why}:${key}`);
  const grant = parked.get(key);
  parked.delete(key);
  if (grant !== undefined) burnExtensionStartConsent(grant.authority);
}

/**
 * Uninstall or disable: the plugin's child, workers and hooks. "generation" is a restart or upgrade: the workers and hooks
 * belonged to the code being replaced; the child start is the one this activation performs, so its answer stays.
 */
export function dropPluginExtensionStarts(pluginId: string, scope: "plugin" | "generation" = "plugin"): void {
  const child = scope === "plugin" ? pluginChildStartKey(pluginId) : undefined;
  const workers = workerStartKey(pluginId, "");
  const hooks = pluginHookStartKey(pluginId, "");
  for (const key of new Set([...entries.keys(), ...parked.keys(), ...asking])) {
    if (key === child || key.startsWith(workers) || key.startsWith(hooks)) dropExtensionStart(key);
  }
}

function notifyOnce(start: PendingExtensionStart, why: ExtensionStartNotice): void {
  if (noticed.has(`${why}:${start.key}`)) return;
  noticed.add(`${why}:${start.key}`);
  record(why, start);
  try {
    asker?.notify(start, why);
  } catch (error) {
    log.warn(`extension start notice failed (${start.kind}): %s`, errorMessage(error));
  }
}

async function answer(entry: Entry, session: ExtensionStartSession): Promise<ExtensionStartAuthority | undefined> {
  // One card per start at a time, whichever site asks.
  if (entry.state !== "pending" || asking.has(entry.key)) return undefined;
  if (!session.attended || asker === undefined) {
    notifyOnce(entry, "unattended");
    return undefined;
  }
  const waiting = entries.get(entry.key) === entry;
  const removal = removals.get(entry.key);
  asking.add(entry.key);
  entry.state = "asking";
  let outcome: "yes" | "no" | "no-approver";
  try {
    outcome = await asker.ask(entry, session);
  } catch (error) {
    log.warn(`extension start ask failed (${entry.kind}): %s`, errorMessage(error));
    outcome = "no-approver";
  } finally {
    asking.delete(entry.key);
  }
  entry.state = "pending";
  // Removed while the card was open: the answer is for something that is no longer there.
  if (removals.get(entry.key) !== removal) return undefined;
  if (outcome === "yes") {
    if (waiting) forget(entry.key);
    return mintAuthority(entry.key);
  }
  if (outcome === "no") {
    entry.state = "declined";
    notifyOnce(entry, "declined");
    return undefined;
  }
  notifyOnce(entry, "unattended");
  return undefined;
}

async function retryStart(entry: Entry): Promise<void> {
  try {
    await entry.retry?.();
  } catch (error) {
    log.warn(`waiting extension start failed (${entry.kind}): %s`, errorMessage(error));
  }
}

/**
 * A turn began in this session. A waiting start a backend now confines runs with no card. Each other one is asked once and
 * the approved ones run. Unattended: none of those starts. No session: only the confined ones run and nobody is asked or told.
 */
export async function settlePendingExtensionStarts(session?: ExtensionStartSession): Promise<void> {
  for (const waiting of [...entries.values()]) {
    if (entries.get(waiting.key) !== waiting || asking.has(waiting.key)) continue;
    let entry = waiting;
    const now = entry.recheck?.();
    if (now === "confined") {
      // A no refused an unconfined start; this one is confined, so it runs either way.
      forget(entry.key);
      record("confined", entry);
      await retryStart(entry);
      continue;
    }
    if (now === "refused" || session === undefined) continue;
    if (now !== undefined && now !== entry.cause) {
      entry = { ...entry, cause: now };
      entries.set(entry.key, entry);
    }
    const authority = await answer(entry, session);
    if (authority === undefined) continue;
    parked.set(entry.key, { authority, expiresAt: Date.now() + EXTENSION_START_GRANT_TTL_MS });
    if (entry.retry === undefined) continue;
    try {
      await retryStart(entry);
    } finally {
      // A retry that never reached its spawn leaves nothing behind for a later start.
      if (parked.get(entry.key)?.authority === authority) parked.delete(entry.key);
      burnExtensionStartConsent(authority);
    }
  }
}

/** A session-bound site (a hook, a worker inside a tool call) asks now. Its answer covers this run only. Undefined: do not start. */
export async function requestExtensionStartConsent(
  start: PendingExtensionStart,
  session: ExtensionStartSession,
): Promise<ExtensionStartAuthority | undefined> {
  return answer({ ...start, state: "pending" }, session);
}

/**
 * Runs one start with the consent waiting for it, if any. When nothing confines it and it has none:
 * a session asks now and the start runs with that answer; without a session it waits for the next attended turn and this call fails.
 */
export async function runExtensionStart<T>(
  pending: Omit<PendingExtensionStart, "cause">,
  session: ExtensionStartSession | undefined,
  run: (authority: ExtensionStartAuthority | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await run(takeExtensionStartGrant(pending.key));
  } catch (error) {
    if (!isExtensionStartConsentRequired(error)) throw error;
    const start = { ...pending, cause: error.unconfinedCause };
    if (session === undefined) {
      deferExtensionStart(start);
      throw error;
    }
    const authority = await requestExtensionStartConsent(start, session);
    if (authority === undefined) throw error;
    return run(authority);
  }
}

/** Test teardown only. */
export function __resetExtensionStartsForTest(): void {
  entries.clear();
  parked.clear();
  asking.clear();
  noticed.clear();
  recordedWaiting.clear();
  removals.clear();
  asker = undefined;
}
