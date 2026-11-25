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

export interface PendingExtensionStart {
  /** One start identity; a consent answers this key only. */
  readonly key: string;
  readonly kind: PendingExtensionStartKind;
  /** Shown on the card and the notice. */
  readonly label: string;
  readonly cause: ExtensionStartUnconfinedCause;
  /** Re-runs the start after a yes; it picks the parked consent up by key. Absent: the owner's next start does. */
  readonly retry?: () => Promise<void>;
}

export const pluginChildStartKey = (pluginId: string): string => `plugin-child:${pluginId}`;
export const mcpStdioStartKey = (serverId: string): string => `mcp-stdio:${serverId}`;
export const workerStartKey = (pluginId: string, workerId: string): string => `worker:${pluginId}/${workerId}`;
export const pluginHookStartKey = (pluginId: string, hookId: string): string => `plugin-hook:${pluginId}/${hookId}`;

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

export interface ExtensionStartAsker {
  /** One card for one start. "no-approver": nobody could answer. */
  ask(start: PendingExtensionStart, session: ExtensionStartSession): Promise<"yes" | "no" | "no-approver">;
  /** One install-hint notice per start. */
  notify(start: PendingExtensionStart, why: "declined" | "unattended"): void;
}

type Entry = PendingExtensionStart & { state: "pending" | "asking" | "declined" };

// A list, so one card could show every waiting start later; today each start gets its own card.
const entries = new Map<string, Entry>();
const parked = new Map<string, ExtensionStartAuthority>();
const noticed = new Set<string>();
let asker: ExtensionStartAsker | undefined;

export function setExtensionStartAsker(next: ExtensionStartAsker | undefined): void {
  asker = next;
}

export function listPendingExtensionStarts(): readonly (PendingExtensionStart & { readonly state: Entry["state"] })[] {
  return [...entries.values()].map((entry) => ({ ...entry }));
}

function queue(start: PendingExtensionStart): Entry {
  const existing = entries.get(start.key);
  // A start being asked about, or already declined, keeps its entry.
  if (existing !== undefined && existing.state !== "pending") return existing;
  const entry: Entry = { ...start, state: "pending" };
  entries.set(start.key, entry);
  return entry;
}

/** A sessionless site records its start here instead of running it. A declined start stays declined. */
export function deferExtensionStart(start: PendingExtensionStart): void {
  queue(start);
}

/** The consent a yes parked for this key, removed from the list; the caller threads it to its spawn. */
export function takeExtensionStartGrant(key: string): ExtensionStartAuthority | undefined {
  const authority = parked.get(key);
  parked.delete(key);
  return authority;
}

function notifyOnce(start: PendingExtensionStart, why: "declined" | "unattended"): void {
  if (noticed.has(start.key)) return;
  noticed.add(start.key);
  try {
    asker?.notify(start, why);
  } catch (error) {
    log.warn(`extension start notice failed (${start.kind}): %s`, errorMessage(error));
  }
}

async function answer(entry: Entry, session: ExtensionStartSession): Promise<ExtensionStartAuthority | undefined> {
  if (entry.state !== "pending") return undefined;
  if (!session.attended || asker === undefined) {
    notifyOnce(entry, "unattended");
    return undefined;
  }
  // Claimed before the await: a concurrent turn never shows a second card for this start.
  entry.state = "asking";
  let outcome: "yes" | "no" | "no-approver";
  try {
    outcome = await asker.ask(entry, session);
  } catch (error) {
    log.warn(`extension start ask failed (${entry.kind}): %s`, errorMessage(error));
    outcome = "no-approver";
  }
  if (outcome === "yes") {
    entries.delete(entry.key);
    noticed.delete(entry.key);
    return mintAuthority(entry.key);
  }
  if (outcome === "no") {
    entry.state = "declined";
    notifyOnce(entry, "declined");
    return undefined;
  }
  entry.state = "pending";
  notifyOnce(entry, "unattended");
  return undefined;
}

/** A turn began in this session: ask once per waiting start, then run the ones approved. Unattended: none starts. */
export async function settlePendingExtensionStarts(session: ExtensionStartSession): Promise<void> {
  for (const entry of [...entries.values()]) {
    if (entries.get(entry.key) !== entry) continue;
    const authority = await answer(entry, session);
    if (authority === undefined) continue;
    parked.set(entry.key, authority);
    if (entry.retry === undefined) continue;
    try {
      await entry.retry();
    } catch (error) {
      log.warn(`approved extension start failed (${entry.kind}): %s`, errorMessage(error));
    } finally {
      // A retry that never reached its spawn leaves nothing behind for a later start.
      if (parked.get(entry.key) === authority) parked.delete(entry.key);
      burnExtensionStartConsent(authority);
    }
  }
}

/** A session-bound site (a hook, a worker inside a tool call) asks now. Undefined: do not start. */
export async function requestExtensionStartConsent(
  start: PendingExtensionStart,
  session: ExtensionStartSession,
): Promise<ExtensionStartAuthority | undefined> {
  const authority = await answer(queue(start), session);
  // Unattended leaves nothing queued for this session-bound start: its next run asks for itself.
  if (authority === undefined && entries.get(start.key)?.state === "pending") entries.delete(start.key);
  return authority;
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
  noticed.clear();
  asker = undefined;
}
