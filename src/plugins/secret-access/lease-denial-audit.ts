import { logPermissionEvent, permissionLogId } from "../../lib/permission-log.js";

type LeaseDenialCode = "lease-unavailable" | "lease-audience-denied" | "credential-conflict";

interface Bucket { count: number; timer: ReturnType<typeof setTimeout> | null }

/** Coalesces refused calls by trusted identity and fixed code, never by caller input. */
export class LeaseDenialAudit {
  private readonly buckets = new Map<string, Bucket>();

  record(pluginId: string, method: "hostFetch", error: {
    code: LeaseDenialCode;
    detail?: Record<string, string | number>;
  }): void {
    const key = `${pluginId}\0${method}\0${error.code}`;
    const existing = this.buckets.get(key);
    if (existing) { existing.count += 1; return; }
    const bucket: Bucket = { count: 0, timer: null };
    this.buckets.set(key, bucket);
    this.write(pluginId, method, error.code, 1, error.detail);
    const summarize = () => {
      if (bucket.count > 0) this.write(pluginId, method, error.code, bucket.count);
      bucket.count = 0;
      bucket.timer = null;
      this.buckets.delete(key);
    };
    bucket.timer = setTimeout(summarize, 60_000);
    bucket.timer.unref?.();
  }

  private write(
    pluginId: string,
    method: "hostFetch",
    code: LeaseDenialCode,
    count: number,
    detail?: Record<string, string | number>,
  ): void {
    const stage = detail?.stage;
    const hop = detail?.hop;
    const header = detail?.header;
    logPermissionEvent("plugin_secret_lease_denied", {
      pluginId: permissionLogId(pluginId), method, code, count,
      stage: code === "lease-unavailable" && (stage === "before-send" || stage === "redirect" || stage === "after-await") ? stage : undefined,
      hop: code === "lease-audience-denied" && typeof hop === "number" && Number.isInteger(hop) && hop >= 0 && hop <= 10 ? hop : undefined,
      header: code === "credential-conflict" && typeof header === "string"
        && ["authorization", "proxy-authorization", "cookie", "api-key", "x-api-key", "ocp-apim-subscription-key"].includes(header) ? header : undefined,
    }, "warn");
  }
}
