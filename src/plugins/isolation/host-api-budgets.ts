import type { HostApiPath, HostApiWireErrorCode } from "./host-api-wire.js";

const AUDIT_WINDOW_MS = 60_000;

export const DISPATCH_IN_FLIGHT_MAX = 64;
export const DISPATCH_SUBSCRIPTIONS_MAX = 256;
export const DISPATCH_SUBSCRIPTION_KIND_MAX: Partial<Record<HostApiPath, number>> = {
  onEvent: 64,
  "config.onChange": 16,
  onPluginsChanged: 4,
  spawnWorker: 8,
  startAudioCapture: 2,
  attachFloatingPanel: 1,
  resolveApiKey: 32,
};

type BucketName = "default" | "hostFetch" | "resolveApiKey" | "emitEvent" | "logEvent";

const BUCKETS: Record<BucketName, { readonly perSecond: number; readonly burst: number }> = {
  default: { perSecond: 50, burst: 200 },
  hostFetch: { perSecond: 20, burst: 60 },
  resolveApiKey: { perSecond: 10, burst: 30 },
  emitEvent: { perSecond: 50, burst: 200 },
  logEvent: { perSecond: 100, burst: 500 },
};

export interface HostApiBudgetAudit {
  readonly type: "plugin_hostapi_denied" | "plugin_rate_limited";
  readonly pluginId: string;
  readonly method: string;
  readonly code: HostApiWireErrorCode;
  readonly count: number;
  readonly bucket?: string;
  readonly summary: boolean;
}

interface BucketState {
  units: number;
  at: number;
}

interface AuditState {
  pending: number;
  timer: ReturnType<typeof setTimeout>;
  report: Omit<HostApiBudgetAudit, "count" | "summary">;
}

/** One incarnation's bounded token buckets and denial diagnostics. */
export class HostApiBudgets {
  private readonly buckets = new Map<string, BucketState>();
  private readonly audits = new Map<string, AuditState>();

  constructor(
    private readonly pluginId: string,
    private readonly report: (entry: HostApiBudgetAudit) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Return milliseconds until the next token, or zero after consuming one. */
  take(method: HostApiPath | "notifications/ave/log"): number {
    const name: BucketName = method === "hostFetch" || method === "resolveApiKey"
      ? method
      : method === "emitEvent" ? "emitEvent"
      : method === "logEvent" || method === "notifications/ave/log" ? "logEvent"
      : "default";
    // Log requests and context.log share one plugin budget. All other request
    // buckets are per method, with the same default capacity.
    const key = name === "logEvent" ? "logEvent" : method;
    const limit = BUCKETS[name];
    const now = Math.trunc(this.now());
    const capacity = limit.burst * 1000;
    const current = this.buckets.get(key) ?? { units: capacity, at: now };
    current.units = Math.min(
      capacity,
      current.units + Math.max(0, now - current.at) * limit.perSecond,
    );
    current.at = Math.max(current.at, now);
    this.buckets.set(key, current);
    if (current.units < 1000) {
      return Math.min(5000, Math.max(1, Math.ceil((1000 - current.units) / limit.perSecond)));
    }
    current.units -= 1000;
    return 0;
  }

  deny(method: HostApiPath | "<unknown>" | "notifications/ave/log", code: HostApiWireErrorCode, bucket?: string): void {
    const key = `${method}\u0000${code}`;
    const existing = this.audits.get(key);
    if (existing) {
      existing.pending += 1;
      return;
    }
    const report: AuditState["report"] = {
      type: code === "rate-limited" ? "plugin_rate_limited" : "plugin_hostapi_denied",
      pluginId: this.pluginId,
      method,
      code,
      ...(bucket === undefined ? {} : { bucket }),
    };
    this.emit({ ...report, count: 1, summary: false });
    const state: AuditState = {
      pending: 0,
      report,
      timer: setTimeout(() => this.flush(key), AUDIT_WINDOW_MS),
    };
    state.timer.unref?.();
    this.audits.set(key, state);
  }

  private flush(key: string): void {
    const state = this.audits.get(key);
    if (!state) return;
    if (state.pending === 0) {
      this.audits.delete(key);
      return;
    }
    this.emit({ ...state.report, count: state.pending, summary: true });
    state.pending = 0;
    state.timer = setTimeout(() => this.flush(key), AUDIT_WINDOW_MS);
    state.timer.unref?.();
  }

  end(): void {
    for (const state of this.audits.values()) clearTimeout(state.timer);
    this.audits.clear();
    this.buckets.clear();
  }

  private emit(entry: HostApiBudgetAudit): void {
    try {
      this.report(entry);
    } catch {
      // A diagnostic sink cannot turn a refusal into a failed transport call.
    }
  }
}
