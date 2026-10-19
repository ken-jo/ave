/**
 * Proxy-deny visibility: every connection the ASRT proxy refuses becomes one
 * audit row naming the tool call, terminal tab or plugin worker that opened it.
 *
 * ASRT records each refusal in its violation store as a line such as
 * `deny network-outbound example.com:443 (domain not allowed)`, keyed by the
 * invocation's `commandId` (`egress-invocations.ts`). Nothing read that store
 * before, so a denied host was visible to nobody: not the user, not the audit
 * log, not the model. The monitor subscribes once at boot, after the sandbox
 * is initialized, maps each new deny line to a
 * `SandboxEvent { type: "egress_attempted", blocked: true }`, looks its key up
 * among the live invocations, and appends one row to the sandbox audit
 * channel. A key no live invocation holds is recorded as "unattributed"; the
 * key itself is never written, because it arrived over a carrier the confined
 * process can write.
 *
 * This is observation only. Which hosts are allowed is still the strict
 * allow-list set at boot; no ask callback is involved.
 */
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import {
  buildSandboxEgressDenyAuditEntry,
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

/** A proxy refusal parsed from one ASRT violation line. */
export type ParsedEgressDeny = SandboxEgressDenyAuditEntry["deny"];

const NETWORK_OUTBOUND = /^deny network-outbound (\S+):(\d+) \((.*)\)$/;
const SOCKS_TUNNEL = /^deny socks-tunnel (\S+):(\d+) \((.*)\)$/;
const HTTP_REQUEST = /^deny http-request (\S+) (\S+) \((.*)\)$/;

function mask(text: string): string {
  return maskSensitiveData(text).masked;
}

function splitAuthority(authority: string): { host: string; port: number | null } {
  const match = /^(.*):(\d+)$/.exec(authority);
  if (match === null) return { host: authority, port: null };
  return { host: match[1]!, port: Number(match[2]) };
}

/**
 * Parse one violation line, or undefined for a line that is not a proxy deny
 * (a Seatbelt or seccomp filesystem violation, for instance). ASRT has already
 * reduced the line to one display-safe physical line.
 */
export function parseEgressDenyLine(line: string): ParsedEgressDeny | undefined {
  const outbound = NETWORK_OUTBOUND.exec(line) ?? SOCKS_TUNNEL.exec(line);
  if (outbound !== null) {
    return {
      action: line.startsWith("deny network-outbound") ? "network-outbound" : "socks-tunnel",
      host: outbound[1]!,
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
    return { action: "http-request", host, port, method, url: null, reason: mask(request[3]!) };
  }
  let host = target;
  let port: number | null = null;
  try {
    const url = new URL(target);
    host = url.hostname;
    port = url.port === "" ? null : Number(url.port);
  } catch {
    // Not an absolute URL: there is no host to separate, so the masked target
    // stands in for it.
    host = mask(target);
  }
  // ASRT already cut the query string to `?…`; the path can still carry a
  // token (`/hooks/<secret>`), so the URL is DLP-masked as a whole.
  return { action: "http-request", host, port, method, url: mask(target), reason: mask(request[3]!) };
}

/** The audit form of a live owner: the token is never part of it. */
function auditInvocationFor(owner: EgressInvocationOwner | undefined): SandboxEgressDenyInvocation {
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

export interface EgressDenyMonitorDeps {
  /** ASRT's violation store subscription (`subscribeAsrtViolations`). */
  readonly subscribe: (listener: (violations: readonly AsrtViolationRecord[]) => void) => Promise<() => void>;
  /** The audit sink (`emitSandboxAudit`). */
  readonly emit: (entry: SandboxEgressDenyAuditEntry) => Promise<void>;
  /** The active sandbox capability, recorded on every row. */
  readonly capability: () => Pick<SandboxCapability, "kind" | "confidence">;
}

/**
 * Start recording proxy denies. Returns the unsubscribe function.
 *
 * The store hands its whole retained tail to the listener on every change and
 * once at subscription; a record is handled once, recognised by identity
 * (the store keeps the same objects while it retains them). Records already in
 * the store when the monitor starts are handled too: they were refused in this
 * process and are not in the audit log yet.
 *
 * The owner is looked up synchronously inside the listener, which the store
 * calls from `addViolation`, while the refused process is still alive and its
 * token still live.
 */
export async function startEgressDenyMonitor(deps: EgressDenyMonitorDeps): Promise<() => void> {
  const seen = new WeakSet<AsrtViolationRecord>();
  return deps.subscribe((violations) => {
    for (const violation of violations) {
      if (seen.has(violation)) continue;
      seen.add(violation);
      const deny = parseEgressDenyLine(violation.line);
      if (deny === undefined) continue;
      const owner = violation.encodedCommand === undefined
        ? undefined
        : egressInvocationOwner(decodeEgressAttributionKey(violation.encodedCommand));
      const entry = buildSandboxEgressDenyAuditEntry({
        timestamp: violation.timestamp,
        sandbox: deps.capability(),
        invocation: auditInvocationFor(owner),
        deny,
      });
      deps.emit(entry).catch((error: unknown) => {
        // Audit failure must not break the proxy or the command; it is logged
        // so a missing row has a visible cause.
        log.warn("could not record a proxy deny: %s", errorMessage(error));
      });
    }
  });
}
