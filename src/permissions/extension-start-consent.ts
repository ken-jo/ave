/** Per-start human consent for an extension start that nothing confines, and the starts waiting for it. */
import { createHash } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { errorMessage } from "../shared/error-message.js";
import { turnExtensionPolicyContext, unattendedApprovalDenial } from "../shared/turn-extension-policy.js";

const log = createLogger("extension-start-consent");

export const EXTENSION_START_CONSENT_REQUIRED_CODE = "extension-start-consent-required";

/** Why the start would run without OS isolation. "readiness-deadline" is the no-backend case whose backend check ran out of time. */
export type ExtensionStartUnconfinedCause = "no-backend" | "readiness-deadline" | "home-privacy-unverified";

/** One start as its spawn site names it: the key says which extension, the identity says exactly what would run. */
export interface ExtensionStartIdentity { readonly key: string; readonly identity: string }

/** The identity of a start: a digest of the host-held facts its spawn runs from. Any change to them is another start. */
export function extensionStartIdentity(facts: unknown): string {
  return createHash("sha256").update(canonicalStringify(facts)).digest("hex");
}

export class ExtensionStartConsentRequiredError extends Error {
  readonly code = EXTENSION_START_CONSENT_REQUIRED_CODE;
  /** `start` is the start the refused crossing presented; a probe presents none. */
  constructor(readonly unconfinedCause: ExtensionStartUnconfinedCause, readonly start?: ExtensionStartIdentity) {
    super(`Extension start needs approval: it would run without OS isolation (${unconfinedCause}; ${EXTENSION_START_CONSENT_REQUIRED_CODE})`);
    this.name = "ExtensionStartConsentRequiredError";
  }
}

export function isExtensionStartConsentRequired(error: unknown): error is ExtensionStartConsentRequiredError {
  return error instanceof ExtensionStartConsentRequiredError;
}

declare const EXTENSION_START_CONSENT: unique symbol;
/** Opaque, single-use, bound to one start key and the identity the person was shown. Minted only by a human answer in this module. */
interface ExtensionStartConsent { readonly [EXTENSION_START_CONSENT]: true }
export interface ExtensionStartAuthority extends ExtensionStartIdentity { readonly consent: ExtensionStartConsent }

const liveConsents = new WeakMap<ExtensionStartConsent, ExtensionStartIdentity>();

function mintAuthority(start: ExtensionStartIdentity): ExtensionStartAuthority {
  const consent = Object.freeze({}) as ExtensionStartConsent;
  const bound = Object.freeze({ key: start.key, identity: start.identity });
  liveConsents.set(consent, bound);
  return Object.freeze({ ...bound, consent });
}

/** What a start shows the gate: its own key and identity, the consent threaded to it, and whether this crossing is the spawn. */
export interface ExtensionStartPresentation extends ExtensionStartIdentity {
  readonly authority: ExtensionStartAuthority | undefined;
  /** The spawn crossing spends the consent; earlier crossings of the same start leave it live. */
  readonly spend?: boolean;
}

function isConsentObject(authority: ExtensionStartAuthority | undefined): authority is ExtensionStartAuthority {
  return typeof authority === "object" && authority !== null && typeof authority.consent === "object" && authority.consent !== null;
}

/**
 * True when the consent is live for exactly this start: the same key and the identity the person answered for.
 * A start whose identity changed since the card presents another identity and is refused. A spend burns it whether it matched or not.
 */
export function presentExtensionStartConsent(start: ExtensionStartPresentation | undefined): boolean {
  if (start === undefined || !isConsentObject(start.authority)) return false;
  const bound = liveConsents.get(start.authority.consent);
  const live = typeof start.identity === "string" && start.identity.length > 0 && bound !== undefined
    && bound.key === start.key && bound.identity === start.identity
    && start.authority.key === start.key && start.authority.identity === start.identity;
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
  /** Which extension starts; one waiting start per key. */
  readonly key: string;
  /** Exactly what would run, as the spawn site presents it. A consent answers this key and this identity only. */
  readonly identity: string;
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
/** What a person agrees to or declines when asked about an unconfined server start: an edited command, args, env or cwd is another start. */
// apiKeyEnv and apiKey stay out of the identity: governance pins apiKeyEnv to an admin-approved value, so they cannot repoint an agreed start.
export function mcpStdioStartIdentity(config: {
  readonly id: string; readonly command?: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string;
}): string {
  return extensionStartIdentity({ id: config.id, command: config.command ?? null, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? null });
}
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
  const attended = !unattendedApprovalDenial() && turn !== undefined && turn.headless !== true && turn.ownerUnattended !== true
    && turn.approvalSurface !== "unavailable" && turn.remoteControllerAuthority === undefined && turn.withholdSessionAuthority !== true;
  return { sessionId, attended, ...(turn?.abortSignal ? { abortSignal: turn.abortSignal } : {}) };
}

type ExtensionStartNotice = "declined" | "unattended";

/** Who a card is shown to. The card is withdrawn only when every start on it was cancelled. */
interface ExtensionStartCardSession {
  readonly sessionId: string;
  readonly abortSignal?: AbortSignal;
}

/** The person's answer for each start on one card, by start key. A start with no entry was not answered. */
type ExtensionStartAnswers = ReadonlyMap<string, "yes" | "no">;

export interface ExtensionStartAsker {
  /** One card for every start waiting in one session; each start gets its own yes or no. "no-approver": nobody answered. */
  ask(starts: readonly PendingExtensionStart[], session: ExtensionStartCardSession): Promise<ExtensionStartAnswers | "no-approver">;
  /** One install-hint notice per start and reason. */
  notify(start: PendingExtensionStart, why: ExtensionStartNotice): void;
  /** Audit row for a start that did not run, or that ran confined after waiting. */
  record?(event: "waiting" | "confined" | ExtensionStartNotice, start: PendingExtensionStart): void;
}

type Entry = PendingExtensionStart & { state: "pending" | "asking" | "declined" };

/** How long a consent waits for a start that has no retry of its own. */
export const EXTENSION_START_GRANT_TTL_MS = 5 * 60_000;

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

/**
 * A sessionless site records its start here instead of running it. A declined start stays declined while it is the same start;
 * another identity under the same key is another start, so no earlier answer, open card or waiting consent covers it.
 */
export function deferExtensionStart(start: PendingExtensionStart): void {
  if (unattendedApprovalDenial()) return;
  if (differentStartWaits(start)) dropExtensionStart(start.key);
  const existing = entries.get(start.key);
  // A start being asked about, or already declined, keeps its entry.
  if (existing !== undefined && existing.state !== "pending") return;
  const entry: Entry = { ...start, state: "pending" };
  entries.set(start.key, entry);
  recordWaiting(entry);
}

function differentStartWaits(start: ExtensionStartIdentity): boolean {
  const known = entries.get(start.key)?.identity ?? parked.get(start.key)?.authority.identity;
  return known !== undefined && known !== start.identity;
}

/** The consent a yes parked for this key, removed from the list; the caller threads it to its spawn. */
export function takeExtensionStartGrant(key: string): ExtensionStartAuthority | undefined {
  if (unattendedApprovalDenial()) return undefined;
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

type AskOutcome = { readonly authority: ExtensionStartAuthority } | "confined" | undefined;

/** One start waiting for its session's card. */
interface Asked {
  readonly entry: Entry;
  readonly session: ExtensionStartSession;
  /** The entry is in the waiting list: a yes takes it off, and its consent is parked for the retry. */
  readonly waiting: boolean;
  readonly removal: number | undefined;
  readonly resolve: (outcome: AskOutcome) => void;
}

// One card at a time per session. A start that arrives while a card is open goes on that session's next card.
const cards = new Map<string, Asked[]>();

/** A signal that fires only when every start on the card was cancelled; one cancelled start leaves the card for the others. */
function cardAbortSignal(batch: readonly Asked[]): AbortSignal | undefined {
  const signals = batch.map((asked) => asked.session.abortSignal);
  if (signals.some((signal) => signal === undefined)) return undefined;
  const controller = new AbortController();
  const check = () => { if (signals.every((signal) => signal?.aborted)) controller.abort(); };
  for (const signal of signals) signal?.addEventListener("abort", check, { once: true });
  check();
  return controller.signal;
}

/** Applies one start's answer in the tick the card was answered, so a removal or an edit after it still finds the consent to burn. */
function settleAsked(asked: Asked, outcome: "yes" | "no" | "no-approver" | "confined"): void {
  const { entry } = asked;
  asking.delete(entry.key);
  entry.state = "pending";
  // Removed or replaced while it waited: the answer is for something that is no longer there.
  if (removals.get(entry.key) !== asked.removal) {
    asked.resolve(undefined);
  } else if (outcome === "confined") {
    asked.resolve("confined");
  } else if (outcome === "yes") {
    const authority = mintAuthority(entry);
    if (asked.waiting) {
      forget(entry.key);
      parked.set(entry.key, { authority, expiresAt: Date.now() + EXTENSION_START_GRANT_TTL_MS });
    }
    asked.resolve({ authority });
  } else {
    if (outcome === "no") entry.state = "declined";
    notifyOnce(entry, outcome === "no" ? "declined" : "unattended");
    asked.resolve(undefined);
  }
}

async function showCards(sessionId: string, waitingForCard: Asked[]): Promise<void> {
  // Starts asked in the same tick share the first card.
  await Promise.resolve();
  try {
    for (;;) {
      const queued = waitingForCard.splice(0);
      if (queued.length === 0) return;
      const batch: Asked[] = [];
      for (const asked of queued) {
        // What changed while this start waited behind an open card is read again before it is shown.
        if (removals.get(asked.entry.key) !== asked.removal) settleAsked(asked, "no-approver");
        else if (asked.session.abortSignal?.aborted || asker === undefined) settleAsked(asked, "no-approver");
        else {
          const now = asked.waiting ? asked.entry.recheck?.() : undefined;
          if (now === "confined") settleAsked(asked, "confined");
          else if (now === "refused") { asking.delete(asked.entry.key); asked.entry.state = "pending"; asked.resolve(undefined); }
          else batch.push(asked);
        }
      }
      if (batch.length === 0 || asker === undefined) continue;
      const signal = cardAbortSignal(batch);
      let answers: ExtensionStartAnswers | "no-approver";
      try {
        answers = await asker.ask(batch.map((asked) => asked.entry), { sessionId, ...(signal ? { abortSignal: signal } : {}) });
      } catch (error) {
        log.warn(`extension start ask failed (${batch.length} starts): %s`, errorMessage(error));
        answers = "no-approver";
      }
      for (const asked of batch) {
        // A start cancelled while the card was open was not answered, whatever the card says.
        const answer = answers === "no-approver" || asked.session.abortSignal?.aborted ? undefined : answers.get(asked.entry.key);
        settleAsked(asked, answer === "yes" || answer === "no" ? answer : "no-approver");
      }
    }
  } finally {
    if (cards.get(sessionId) === waitingForCard) cards.delete(sessionId);
  }
}

function answer(entry: Entry, session: ExtensionStartSession): Promise<AskOutcome> {
  // One question per start at a time, whichever site asks.
  if (entry.state !== "pending" || asking.has(entry.key)) return Promise.resolve(undefined);
  const unattended = unattendedApprovalDenial();
  if (unattended) {
    log.info("Extension start denied (%s): %s", entry.kind, unattended);
    return Promise.resolve(undefined);
  }
  if (!session.attended || asker === undefined) {
    notifyOnce(entry, "unattended");
    return Promise.resolve(undefined);
  }
  const waiting = entries.get(entry.key) === entry;
  asking.add(entry.key);
  entry.state = "asking";
  return new Promise<AskOutcome>((resolve) => {
    const asked: Asked = { entry, session, waiting, removal: removals.get(entry.key), resolve };
    const queue = cards.get(session.sessionId);
    if (queue !== undefined) {
      queue.push(asked);
      return;
    }
    const waitingForCard = [asked];
    cards.set(session.sessionId, waitingForCard);
    void showCards(session.sessionId, waitingForCard);
  });
}

async function retryStart(entry: Entry): Promise<void> {
  try {
    await entry.retry?.();
  } catch (error) {
    log.warn(`waiting extension start failed (${entry.kind}): %s`, errorMessage(error));
  }
}

async function runConfined(entry: Entry): Promise<void> {
  // A no refused an unconfined start; this one is confined, so it runs either way.
  forget(entry.key);
  record("confined", entry);
  await retryStart(entry);
}

/**
 * A turn began in this session. A waiting start a backend now confines runs with no card. The others share one card, on which each
 * gets its own yes or no, and the approved ones run, each with its own consent. Unattended: none of those starts.
 * No session: only the confined ones run and nobody is asked or told.
 */
export async function settlePendingExtensionStarts(session?: ExtensionStartSession): Promise<void> {
  const asked: { entry: Entry; answered: Promise<AskOutcome> }[] = [];
  const confined: Entry[] = [];
  // Every waiting start is sorted before anything is awaited, so the ones that need a person all reach the same card.
  for (const waiting of [...entries.values()]) {
    if (asking.has(waiting.key)) continue;
    let entry = waiting;
    const now = entry.recheck?.();
    if (now === "confined") {
      confined.push(entry);
      continue;
    }
    if (now === "refused" || session === undefined) continue;
    if (now !== undefined && now !== entry.cause) {
      entry = { ...entry, cause: now };
      entries.set(entry.key, entry);
    }
    asked.push({ entry, answered: answer(entry, session) });
  }
  for (const entry of confined) {
    // An earlier start's run may have removed or replaced this one.
    if (entries.get(entry.key) === entry) await runConfined(entry);
  }
  for (const { entry, answered } of asked) {
    const outcome = await answered;
    if (outcome === undefined) continue;
    if (outcome === "confined") {
      if (entries.get(entry.key) === entry) await runConfined(entry);
      continue;
    }
    // Parked when the card was answered, so a removal or an edit while an earlier start ran has already burned it.
    const { authority } = outcome;
    if (entry.retry === undefined) continue;
    try {
      if (parked.get(entry.key)?.authority === authority) await retryStart(entry);
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
  const outcome = await answer({ ...start, state: "pending" }, session);
  return typeof outcome === "object" ? outcome.authority : undefined;
}

/**
 * Runs one start with the consent waiting for it, if any. When nothing confines it and it has none:
 * a session asks now and the start runs with that answer; without a session it waits for the next attended turn and this call fails.
 */
export async function runExtensionStart<T>(
  pending: Omit<PendingExtensionStart, "cause" | "identity">,
  session: ExtensionStartSession | undefined,
  run: (authority: ExtensionStartAuthority | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await run(takeExtensionStartGrant(pending.key));
  } catch (error) {
    // The spawn site names what it would run; the question and the consent are for exactly that.
    if (!isExtensionStartConsentRequired(error) || error.start?.key !== pending.key) throw error;
    const unattended = unattendedApprovalDenial();
    if (unattended) throw new Error(unattended);
    const start = { ...pending, identity: error.start.identity, cause: error.unconfinedCause };
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
  cards.clear();
  parked.clear();
  asking.clear();
  noticed.clear();
  recordedWaiting.clear();
  removals.clear();
  asker = undefined;
}
