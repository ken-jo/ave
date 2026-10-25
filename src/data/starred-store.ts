



import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { adoptLegacyRootFileSync } from "../main/storage/feature-namespace.js";
const log = createLogger("starred-store");

export interface StarredMessage {
  id: string;
  sessionId: string;
  /** Message index is zero-based at star time. */
  messageIndex: number;
  role: string;
  /** Store a text snapshot independent of later session edits. */
  text: string;
  starredAt: string;
}

export interface StarredStoreOptions {
  filePath?: string;
}

const FEATURE_ID = "sessions";
const FILE_NAME = "starred.json";
const LEGACY_ROOT_FILE = "starred.json";

/** Store stars beside sessions so clearing sessions also removes their indexes; session enumeration excludes starred.json. */
export class StarredStore {
  private readonly filePath: string;
  private cache: StarredMessage[] = [];

  constructor(options?: StarredStoreOptions) {
    const defaultPath = resolve(join(aveHome(), FEATURE_ID, FILE_NAME));
    this.filePath = resolve(options?.filePath ?? defaultPath);
    // Migrate only the default path; custom callers must not touch a real user's store.
    if (this.filePath === defaultPath) {
      adoptLegacyRootFileSync(FEATURE_ID, FILE_NAME, LEGACY_ROOT_FILE);
    }
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.cache = [];
        return;
      }
      const raw = readFileSync(this.filePath, "utf-8").trim();
      if (!raw) {
        this.cache = [];
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid: StarredMessage[] = [];
        for (const item of parsed) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as StarredMessage).id === "string" &&
            typeof (item as StarredMessage).sessionId === "string" &&
            typeof (item as StarredMessage).messageIndex === "number" &&
            typeof (item as StarredMessage).role === "string" &&
            typeof (item as StarredMessage).text === "string" &&
            typeof (item as StarredMessage).starredAt === "string"
          ) {
            valid.push(item as StarredMessage);
          } else {
            log.warn({ item }, "skipping invalid entry");
          }
        }
        this.cache = valid;
      } else {
        this.cache = [];
      }
    } catch {
      this.cache = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
  }

  list(): StarredMessage[] {
    return [...this.cache].sort((a, b) => b.starredAt.localeCompare(a.starredAt));
  }

  listBySession(sessionId: string): StarredMessage[] {
    return this.cache.filter((m) => m.sessionId === sessionId);
  }

  add(entry: Omit<StarredMessage, "id" | "starredAt"> & { id?: string; starredAt?: string }): StarredMessage {
    const id = entry.id ?? crypto.randomUUID();
    const starredAt = entry.starredAt ?? new Date().toISOString();
    const existing = this.cache.find(
      (m) => m.sessionId === entry.sessionId && m.messageIndex === entry.messageIndex,
    );
    if (existing) return existing;
    const record: StarredMessage = {
      id,
      sessionId: entry.sessionId,
      messageIndex: entry.messageIndex,
      role: entry.role,
      text: entry.text,
      starredAt,
    };
    this.cache.push(record);
    this.persist();
    return record;
  }

  remove(id: string): boolean {
    const prev = this.cache.length;
    this.cache = this.cache.filter((m) => m.id !== id);
    if (this.cache.length !== prev) {
      this.persist();
      return true;
    }
    return false;
  }

  removeBySessionAndIndex(sessionId: string, messageIndex: number): boolean {
    const prev = this.cache.length;
    this.cache = this.cache.filter(
      (m) => !(m.sessionId === sessionId && m.messageIndex === messageIndex),
    );
    if (this.cache.length !== prev) {
      this.persist();
      return true;
    }
    return false;
  }

  clear(): void {
    this.cache = [];
    this.persist();
  }
}
