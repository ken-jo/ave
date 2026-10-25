/** Keep free-text feedback separate from security audit, with 90-day retention. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { parseJsonlLines } from "../audit/jsonl-reader.js";

export interface FeedbackEntry {
  id: string;
  sessionId: string;
  messageIndex: number;
  rating: "up" | "down";
  /** Free-text reasons stay here and must never enter audit logs. */
  reason?: string;
  timestamp: string;
}

export interface FeedbackStoreOptions {
  filePath?: string;
  retentionDays?: number;
}

export class FeedbackStore {
  private readonly filePath: string;
  private readonly retentionDays: number;

  constructor(options?: FeedbackStoreOptions) {
    const resolvedPath = resolve(options?.filePath ?? join(aveHome(), "feedback.jsonl"));
    const aveDir = resolve(aveHome());
    if (!resolvedPath.startsWith(aveDir + sep) && resolvedPath !== aveDir) {
      throw new Error(`feedback-store: path confinement violation — ${resolvedPath} is outside ${aveDir}`);
    }
    this.filePath = resolvedPath;
    this.retentionDays = options?.retentionDays ?? 90;
  }

  add(entry: Omit<FeedbackEntry, "id" | "timestamp"> & { id?: string; timestamp?: string }): FeedbackEntry {
    const record: FeedbackEntry = {
      id: entry.id ?? crypto.randomUUID(),
      sessionId: entry.sessionId,
      messageIndex: entry.messageIndex,
      rating: entry.rating,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    // Refuse linked parents before storing feedback.
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`feedback-store: symlink detected on storage directory ${dir}`);
    }
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600, flag: "a" });
    return record;
  }

  list(sessionId?: string): FeedbackEntry[] {
    if (!existsSync(this.filePath)) return [];
    const entries: FeedbackEntry[] = [];
    for (const line of parseJsonlLines(readFileSync(this.filePath, "utf-8"))) {
      try {
        const e = JSON.parse(line) as FeedbackEntry;
        if (!sessionId || e.sessionId === sessionId) entries.push(e);
      } catch {
      }
    }
    return entries;
  }

  /** Pruning is non-fatal and should run periodically. */
  prune(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      const kept = this.list().filter((e) => new Date(e.timestamp).getTime() >= cutoff);
      writeFileSync(this.filePath, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf-8");
    } catch {
    }
  }
}
