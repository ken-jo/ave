import { randomUUID } from "node:crypto";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../../main/storage/feature-namespace.js";
import { maskSensitiveData, scrubDiagnosticSecretsStrict } from "../../shared/dlp.js";
import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import { isValidSessionId } from "../../shared/session-id.js";
import { normalizeRecentlyDeniedInvocationRef } from "./recently-denied-replay.js";
import type { RecentlyDeniedEntry, RecentlyDeniedInvocationRef, RecentlyDeniedRerunResult } from "../../shared/recently-denied.js";

const HISTORY_LIMIT = 100;
const SUMMARY_LIMIT = 2048;
const HISTORY_FILE = "recently-denied.json";
export type RecentlyDeniedReplayResolver = (entry: RecentlyDeniedEntry) => Promise<RecentlyDeniedRerunResult>;

type StoredDenial = Omit<RecentlyDeniedEntry, "rerunAvailable">;

function redact(value: string, limit = SUMMARY_LIMIT): string {
  return redactHomePathsInText(maskSensitiveData(scrubDiagnosticSecretsStrict(value), { pii: true }).masked).slice(0, limit);
}

/** Summaries survive restart; bounded one-use executor closures do not. */
export class RecentlyDeniedStore {
  private entries: StoredDenial[] | undefined;
  private loading: Promise<void> | undefined;
  private readonly reruns = new Map<string, () => Promise<unknown>>();
  private replayResolver: RecentlyDeniedReplayResolver | undefined;
  private readonly inFlight = new Set<string>();
  private readonly unavailableReplayIds = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly namespace: FeatureNamespaceHandle = openFeatureNamespace("permissions"),
    private readonly onChanged?: (summary: { total: number }) => void,
  ) {}

  setReplayResolver(resolver: RecentlyDeniedReplayResolver): void {
    this.replayResolver = resolver;
  }

  private load(): Promise<void> {
    if (this.entries) return Promise.resolve();
    return this.loading ??= this.hydrate();
  }

  private async hydrate(): Promise<void> {
    const raw = await this.namespace.readJson<unknown>(HISTORY_FILE, []);
    this.entries = Array.isArray(raw) ? raw.filter((row): row is StoredDenial => {
      if (!row || typeof row !== "object") return false;
      const item = row as Record<string, unknown>;
      return typeof item.id === "string" && /^[a-f0-9-]{36}$/.test(item.id)
        && typeof item.ts === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.ts)
        && Number.isFinite(Date.parse(item.ts)) && typeof item.toolName === "string"
        && ["builtin", "plugin", "mcp"].includes(String(item.source))
        && ["read", "write", "shell", "network", "meta"].includes(String(item.category))
        && typeof item.inputSummary === "string" && typeof item.reason === "string";
    }).slice(-HISTORY_LIMIT).map((row) => ({
      id: row.id, ts: row.ts, toolName: redact(row.toolName, 128), source: row.source,
      category: row.category, inputSummary: redact(row.inputSummary), reason: redact(row.reason),
      ...(typeof row.sessionId === "string" ? { sessionId: redact(row.sessionId, 128) } : {}),
      ...(normalizeRecentlyDeniedInvocationRef(row.invocationRef) ? { invocationRef: normalizeRecentlyDeniedInvocationRef(row.invocationRef) } : {}),
    })) : [];
  }

  async append(params: {
    sessionId?: string;
    toolName: RecentlyDeniedEntry["toolName"];
    source: RecentlyDeniedEntry["source"];
    category: RecentlyDeniedEntry["category"];
    inputSummary: string;
    reason?: string;
    verdict?: { reason: string };
    invocationRef?: RecentlyDeniedInvocationRef;
    /** Must enter the executor afresh with manualRerun and a user approver. */
    rerun?: () => Promise<unknown>;
  }): Promise<string> {
    const operation = this.pending.then(async () => {
      await this.load();
      const id = randomUUID();
      const entry: StoredDenial = {
        id, ts: new Date().toISOString(), toolName: redact(params.toolName, 128),
        source: params.source, category: params.category,
        inputSummary: redact(params.inputSummary), reason: redact(params.reason ?? params.verdict?.reason ?? "Denied"),
        ...(params.sessionId ? { sessionId: redact(params.sessionId, 128) } : {}),
        ...(normalizeRecentlyDeniedInvocationRef(params.invocationRef) ? { invocationRef: normalizeRecentlyDeniedInvocationRef(params.invocationRef) } : {}),
      };
      const next = [...this.entries!, entry].slice(-HISTORY_LIMIT);
      await this.namespace.writeJson(HISTORY_FILE, next);
      this.entries = next;
      if (params.rerun) this.reruns.set(id, params.rerun);
      const retained = new Set(next.map((item) => item.id));
      for (const key of this.reruns.keys()) if (!retained.has(key)) this.reruns.delete(key);
      for (const key of this.unavailableReplayIds) if (!retained.has(key)) this.unavailableReplayIds.delete(key);
      this.onChanged?.({ total: next.length });
      return id;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async list(): Promise<RecentlyDeniedEntry[]> {
    await this.pending;
    await this.load();
    return this.entries!.slice().reverse().map((entry) => ({ ...entry, rerunAvailable: !this.inFlight.has(entry.id)
      && (this.reruns.has(entry.id) || Boolean(isValidSessionId(entry.sessionId) && entry.invocationRef && this.replayResolver && !this.unavailableReplayIds.has(entry.id))) }));
  }

  async rerun(id: string): Promise<RecentlyDeniedRerunResult> {
    if (this.inFlight.has(id)) return { ok: false, error: "rerun-in-progress" };
    await this.pending;
    await this.load();
    if (this.inFlight.has(id)) return { ok: false, error: "rerun-in-progress" };
    const execute = this.reruns.get(id);
    const entry = this.entries!.find((row) => row.id === id);
    const resolver = isValidSessionId(entry?.sessionId) && entry?.invocationRef && !this.unavailableReplayIds.has(id) ? this.replayResolver : undefined;
    if (!execute && !resolver) return { ok: false, error: "rerun-unavailable" };
    this.reruns.delete(id);
    this.inFlight.add(id);
    this.onChanged?.({ total: this.entries?.length ?? 0 });
    try {
      if (execute) {
        await execute();
        return { ok: true };
      }
      const result = await resolver!({ ...entry!, rerunAvailable: true });
      if (!result.ok && result.error === "rerun-unavailable") {
        this.unavailableReplayIds.add(id);
        this.onChanged?.({ total: this.entries!.length });
      }
      return result;
    } catch {
      return { ok: false, error: "rerun-failed" };
    } finally {
      this.inFlight.delete(id);
      this.onChanged?.({ total: this.entries!.length });
    }
  }
}
