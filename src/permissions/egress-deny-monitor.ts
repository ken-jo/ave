// Subscribe before proxy startup and audit every new refusal once, attributed to live invocations or unattributed after release. Never persist the client-controlled key; DLP-mask every parsed field because even host bytes are attacker-controlled. Keep every attempt without sampling; this observer never changes egress policy.
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import {
  buildSandboxEgressDenyAuditEntry,
  type SandboxEgressDecisionAuditEntry,
  type SandboxEgressDenyAuditEntry,
  type SandboxEgressDenyInvocation,
} from "../audit/sandbox-audit.js";
import type { SandboxCapability } from "./sandbox-capability.js";
import {
  decodeEgressAttributionKey,
  egressInvocationOwner,
  type EgressInvocationOwner,
} from "./egress-invocations.js";
import type { AsrtViolationRecord } from "./asrt-sandbox.js";

const log = createLogger("egress-deny-monitor");

// A proxy refusal parsed from one ASRT violation line.
export type ParsedEgressDeny = SandboxEgressDenyAuditEntry["deny"];

const NETWORK_OUTBOUND = /^deny network-outbound (\S+):(\d+) \((.*)\)$/;
const SOCKS_TUNNEL = /^deny socks-tunnel (\S+):(\d+) \((.*)\)$/;
const HTTP_REQUEST = /^deny http-request (\S+) (\S+) \((.*)\)$/;
// The three proxy refusals ASRT records; anything else is not a network deny.
const PROXY_DENY_PREFIX = /^deny (network-outbound|socks-tunnel|http-request) /;

// The reason a row carries when ASRT's line did not have the expected shape.
export const UNPARSED_DENY_REASON = "unparsed deny line";

function mask(text: string): string {
  return maskSensitiveData(text).masked;
}

function splitAuthority(authority: string): { host: string; port: number | null } {
  const match = /^(.*):(\d+)$/.exec(authority);
  if (match === null) return { host: authority, port: null };
  return { host: match[1]!, port: Number(match[2]) };
}

// Parse one violation line, or undefined for a line that is not a proxy deny (a Seatbelt or seccomp filesystem violation, for instance). ASRT has already reduced the line to one display-safe physical line. A proxy deny whose line does not have the expected shape is still a deny: ASRT records `malformed host` refusals with the host as the process sent it (empty, spaces, control characters it has replaced with spaces), so such a line becomes a row with the masked remainder as its host, no port, and UNPARSED_DENY_REASON, never nothing.
export function parseEgressDenyLine(line: string): ParsedEgressDeny | undefined {
  const prefix = PROXY_DENY_PREFIX.exec(line);
  if (prefix === null) return undefined;
  return parseShapedDeny(line) ?? {
    action: prefix[1] as ParsedEgressDeny["action"],
    host: mask(line.slice(prefix[0].length)),
    port: null,
    method: null,
    url: null,
    reason: UNPARSED_DENY_REASON,
  };
}

function parseShapedDeny(line: string): ParsedEgressDeny | undefined {
  const outbound = NETWORK_OUTBOUND.exec(line) ?? SOCKS_TUNNEL.exec(line);
  if (outbound !== null) {
    return {
      action: line.startsWith("deny network-outbound") ? "network-outbound" : "socks-tunnel",
      host: mask(outbound[1]!),
      port: Number(outbound[2]),
      method: null,
      url: null,
      reason: mask(outbound[3]!),
    };
  }
  const request = HTTP_REQUEST.exec(line);
  if (request === null) return undefined;
  const method = request[1]!;
  const target = request[2]!;
  if (method === "CONNECT") {
    // A refused CONNECT carries its authority, not a URL.
    const { host, port } = splitAuthority(target);
    return { action: "http-request", host: mask(host), port, method: mask(method), url: null, reason: mask(request[3]!) };
  }
  let host = target;
  let port: number | null = null;
  try {
    const url = new URL(target);
    host = url.hostname;
    port = url.port === "" ? null : Number(url.port);
  } catch {
    // Not an absolute URL: there is no host to separate, so the target stands in for it.
  }
  // ASRT already cut the query string to `?…`; the path can still carry a token (`/hooks/<secret>`), so the URL is DLP-masked as a whole.
  return { action: "http-request", host: mask(host), port, method: mask(method), url: mask(target), reason: mask(request[3]!) };
}

// The audit form of a live owner: the token is never part of it.
export function auditInvocationFor(owner: EgressInvocationOwner | undefined): SandboxEgressDenyInvocation {
  if (owner === undefined) return { kind: "unattributed" };
  switch (owner.kind) {
    case "shell":
      return { kind: "shell", toolName: owner.toolName, toolUseId: owner.toolUseId ?? null };
    case "terminal":
      return { kind: "terminal", tabId: owner.tabId };
    case "worker":
      return { kind: "worker", role: owner.role, pluginId: owner.pluginId ?? null, instanceId: owner.instanceId ?? null };
  }
}

// Decisions the ask callback made in the last minute, so the monitor writes an `egress-decision` row only for refusals the proxy made before asking it (each callback decision writes its own row). Keyed by attribution key, DLP-masked lower-case host and port, counted so concurrent connections to one destination each match once.
const CALLBACK_DECISION_TTL_MS = 60_000;
const recentCallbackDecisions = new Map<string, { count: number; at: number }>();

function decisionKey(attributionKey: string | undefined, host: string, port: number | null | undefined): string {
  return `${attributionKey ?? ""}\n${mask(String(host)).toLowerCase()}\n${port ?? ""}`;
}

function pruneCallbackDecisions(now: number): void {
  for (const [key, entry] of recentCallbackDecisions) {
    if (now - entry.at > CALLBACK_DECISION_TTL_MS) recentCallbackDecisions.delete(key);
  }
}

// Called by the ask callback for each decision it makes.
export function noteCallbackDecision(attributionKey: string | undefined, host: string, port: number | undefined): void {
  const now = Date.now();
  pruneCallbackDecisions(now);
  const key = decisionKey(attributionKey, host, port);
  const entry = recentCallbackDecisions.get(key);
  recentCallbackDecisions.set(key, { count: (entry?.count ?? 0) + 1, at: now });
}

function consumeCallbackDecision(attributionKey: string | undefined, host: string, port: number | null): boolean {
  pruneCallbackDecisions(Date.now());
  const key = decisionKey(attributionKey, host, port);
  const entry = recentCallbackDecisions.get(key);
  if (entry === undefined) return false;
  if (entry.count <= 1) recentCallbackDecisions.delete(key);
  else entry.count--;
  return true;
}

export interface EgressDenyMonitorDeps {
  // ASRT's violation store subscription (`subscribeAsrtViolations`).
  readonly subscribe: (listener: (violations: readonly AsrtViolationRecord[]) => void) => Promise<() => void>;
  // The audit sink (`emitSandboxAudit`).
  readonly emit: (entry: SandboxEgressDenyAuditEntry | SandboxEgressDecisionAuditEntry) => Promise<void>;
  // The active sandbox capability, recorded on every row.
  readonly capability: () => Pick<SandboxCapability, "kind" | "confidence">;
}

// Start recording proxy denies. Returns the unsubscribe function. The store hands its whole retained tail to the listener on every change and once at subscription; a record is handled once, recognised by identity (the store keeps the same objects while it retains them). Records already in the store when the monitor starts are handled too: they were refused in this process and are not in the audit log yet. The owner is looked up synchronously inside the listener, which the store calls from `addViolation`, while the refused process is still alive and its token still live.
export async function startEgressDenyMonitor(deps: EgressDenyMonitorDeps): Promise<() => void> {
  const seen = new WeakSet<AsrtViolationRecord>();
  return deps.subscribe((violations) => {
    for (const violation of violations) {
      if (seen.has(violation)) continue;
      seen.add(violation);
      const deny = parseEgressDenyLine(violation.line);
      if (deny === undefined) continue;
      const attributionKey = violation.encodedCommand === undefined
        ? undefined
        : decodeEgressAttributionKey(violation.encodedCommand);
      const owner = attributionKey === undefined ? undefined : egressInvocationOwner(attributionKey);
      const invocation = auditInvocationFor(owner);
      const entry = buildSandboxEgressDenyAuditEntry({
        timestamp: violation.timestamp,
        sandbox: deps.capability(),
        invocation,
        deny,
      });
      const report = (error: unknown): void => {
        // Audit failure must not break the proxy or the command; it is logged so a missing row has a visible cause.
        log.warn("could not record a proxy deny: %s", errorMessage(error));
      };
      deps.emit(entry).catch(report);
      // The callback wrote its own decision row; a refusal the proxy made before asking it gets one here.
      if (!consumeCallbackDecision(attributionKey, deny.host, deny.port)) {
        deps.emit({
          timestamp: violation.timestamp.toISOString(),
          entryKind: "egress-decision",
          invocation,
          destination: { host: deny.host, port: deny.port },
          decision: "deny",
          basis: "sandbox",
          scope: null,
          reason: deny.reason,
        }).catch(report);
      }
    }
  });
}
