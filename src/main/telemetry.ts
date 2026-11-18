// Opt-in telemetry contains event names, numeric metrics, and hashed session IDs only.
import { randomUUID } from "node:crypto";
import { telemetryLevel, telemetryEndpointHosts, validateTelemetryEndpoint } from "../shared/telemetry-policy.js";
export { DEFAULT_TELEMETRY_ALLOWLIST, validateTelemetryEndpoint } from "../shared/telemetry-policy.js";
import type { TelemetrySettings } from "../data/settings-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
const log = createLogger("telemetry");

// Endpoint settings cannot widen this operator-owned bound.
export function telemetryAllowedHosts(env: NodeJS.ProcessEnv = process.env, isPackaged = false): readonly string[] {
  return telemetryEndpointHosts(env.AVE_TELEMETRY_ALLOWLIST, isPackaged);
}

// Remove URL credentials, query, and fragment before audit; keep only scheme, host, and path.
// Bound non-URL diagnostics separately.
export function sanitizeUrlForAudit(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not a URL — strip obvious separators and truncate.
    return `[unparseable] ${raw.slice(0, 80)}`;
  }
}

export type TelemetryEventName =
  | "app_start"
  | "chat_turn"
  | "tool_call"
  | "plugin_load"
  | "crash"
  | "error";

export interface TelemetryEvent {
  v: 1;
  name: TelemetryEventName;
  sid: string;
  t: number;
  durMs?: number;
  count?: number;
  appVersion?: string;
}

export interface TelemetryDeps {
  // Settings accessor — invoked on every track()/flush() so a user toggle takes effect immediately. A snapshot object would go stale and keep accepting
  // events after the user opted out.
  settings: () => TelemetrySettings;
  appVersion?: string;
  // The transport this client's uploads run on. REQUIRED: the ambient `fetch` is Node's, which reads neither the machine's proxy configuration nor its
  // trust store, so defaulting to it sent telemetry out on a path the user never chose — and, on an intercepted network, nowhere at all.
  fetchImpl: typeof fetch;
  flushIntervalMs?: number;
  // Reject localhost endpoints in packaged builds.
  isPackaged?: boolean;
  auditLogger?: Pick<AuditLogger, "log">;
  allowlistEnv?: string;
}

const DEFAULT_FLUSH_MS = 24 * 60 * 60 * 1000;

export class TelemetryService {
  private readonly queue: TelemetryEvent[] = [];
  private readonly sid: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private rejectedEndpoint: string | undefined;
  private inFlight: AbortController | undefined;

  constructor(private readonly deps: TelemetryDeps) {
    this.sid = sha256Hex(randomUUID()).slice(0, 16);
    this.fetchImpl = deps.fetchImpl;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  }

  private currentSettings(): TelemetrySettings {
    return this.deps.settings();
  }

  // Audit each rejected endpoint once; a corrected setting is effective immediately.
  private endpointAllowed(endpoint: string | undefined): boolean {
    const result = validateTelemetryEndpoint(endpoint, {
      isPackaged: this.deps.isPackaged ?? false,
      allowlistEnv: this.deps.allowlistEnv ?? process.env.AVE_TELEMETRY_ALLOWLIST,
    });
    if (!result.valid) {
      if (this.rejectedEndpoint === endpoint) return false;
      this.rejectedEndpoint = endpoint;
      try {
        this.deps.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "telemetry",
          // Endpoint rejection is a configuration warning; a later valid setting can resume reporting.
          type: "warn",
          input: `[telemetry] endpoint rejected: ${result.reason}`,
          // Sanitize: never log raw URL — may contain userinfo (user:pass@), query-string secrets, or fragment tokens. Keep only protocol+host+path.
          output: sanitizeUrlForAudit(endpoint),
        });
      } catch {
        // audit failure must not break app
      }
      log.warn(`endpoint rejected (${result.reason})`);
      return false;
    }
    this.rejectedEndpoint = undefined;
    return true;
  }

  isActive(): boolean {
    const s = this.currentSettings();
    if (telemetryLevel(s) === "off") return false;
    return this.endpointAllowed(s.endpoint);
  }

  track(name: TelemetryEventName, extra: { durMs?: number; count?: number } = {}): void {
    if (!this.eventAllowed(name) || !this.isActive()) return;
    const ev: TelemetryEvent = {
      v: 1,
      name,
      sid: this.sid,
      t: Date.now(),
      appVersion: this.deps.appVersion,
      ...extra,
    };
    this.queue.push(ev);
  }

  private eventAllowed(name: TelemetryEventName): boolean {
    const level = telemetryLevel(this.currentSettings());
    return level === "all" || (level === "error" && (name === "error" || name === "crash")) || (level === "crash" && name === "crash");
  }

  settingsChanged(): void {
    const retained = this.queue.filter((event) => this.eventAllowed(event.name));
    this.queue.splice(0, this.queue.length, ...retained);
    this.inFlight?.abort();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    const retained = this.queue.filter((event) => this.eventAllowed(event.name));
    this.queue.splice(0, this.queue.length, ...retained);
    if (this.queue.length === 0 || !this.isActive()) return;
    // Snapshot the batch but DO NOT dequeue until after a confirmed 2xx. On error or non-ok HTTP we leave events in the queue so they retry on the next
    // flush instead of being silently lost.
    const batch = this.queue.slice(0);
    const batchLen = batch.length;
    const endpoint = this.currentSettings().endpoint!;
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const res = await this.fetchImpl(endpoint, {
        signal: controller.signal,
        method: "POST",
        // The endpoint was checked against the allow-list; a redirect would carry the batch to a host that was never checked.
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        log.warn(`flush non-ok HTTP ${res.status}; re-queued ${batchLen} event(s)`);
        return;
      }
      if (!controller.signal.aborted) this.queue.splice(0, batchLen);
    } catch (err) {
      if (!controller.signal.aborted) log.warn("flush failed (re-queued): %s", (err as Error).message);
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }
}
