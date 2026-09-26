import type { AuditLogger } from "../../audit/audit-logger.js";

interface Bucket { count: number; timer: ReturnType<typeof setTimeout> | null }

/** Coalesces refused calls by trusted identity and fixed code, never by caller input. */
export class LeaseDenialAudit {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly audit: Pick<AuditLogger, "log">) {}

  record(pluginId: string, method: string, error: { code: "lease-unavailable" | "lease-audience-denied" | "credential-conflict" }): void {
    const key = `${pluginId}\0${method}\0${error.code}`;
    const existing = this.buckets.get(key);
    if (existing) { existing.count += 1; return; }
    const bucket: Bucket = { count: 0, timer: null };
    this.buckets.set(key, bucket);
    this.write(pluginId, method, error.code, 1);
    const summarize = () => {
      if (bucket.count > 0) this.write(pluginId, method, error.code, bucket.count);
      bucket.count = 0;
      bucket.timer = null;
      this.buckets.delete(key);
    };
    bucket.timer = setTimeout(summarize, 60_000);
    bucket.timer.unref?.();
  }

  private write(pluginId: string, method: string, code: string, count: number): void {
    try {
      this.audit.log({
        timestamp: new Date().toISOString(), sessionId: "plugin", type: "plugin_hostapi_denied",
        input: `plugin=${pluginId} method=${method} code=${code} count=${count}`,
      });
    } catch { /* audit failure cannot change the refusal */ }
  }
}
