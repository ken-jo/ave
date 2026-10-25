/** Accept at most one reciprocally confirmed move from the build base; invalid policy fails closed.
 * Refresh failures clear telemetry and retain announcements only from the base still in force. */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingPathError, PRIVATE_DIR_MODE, writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { isAdminPolicyFileAbsent } from "../../lib/admin-policy-file.js";
import { createMarketplaceLogger } from "../log.js";
import { parseStrictJson } from "../../shared/strict-json.js";
import { parseMarketplaceAnnouncementRows, type MarketplaceAnnouncement } from "../../shared/marketplace-announcements.js";
import { isRecord } from "../../shared/is-record.js";

const log = createMarketplaceLogger("service-endpoint");

export const AVE_SERVICE_BASE_URL = "https://ave.agent-connector.ai";

const DOCUMENT_PATH = "/.well-known/ave-service.json";
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_ANNOUNCEMENTS_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const POLICY_LIMITS = { maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 200_000, maxObjectMembers: 10_000, maxArrayItems: 50_000 };

class ServiceEndpointError extends Error {
  override readonly name = "ServiceEndpointError";
}

export interface ServiceDocument {
  announcements: string | null;
  telemetry: string | null;
  movedTo: string | null;
  movedFrom: string | null;
}

export interface ResolvedService {
  base: string;
  source: "policy" | "moved" | "build";
  document: ServiceDocument;
}

interface OriginOptions {
  /** Loopback HTTP is allowed only in unpackaged development builds. */
  allowLoopbackHttp?: boolean;
}

/** Require an exact HTTPS origin without credentials, path, query or parser repairs. */
export function normalizeServiceBase(value: string, options: OriginOptions = {}): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceEndpointError(`service base is not a URL: ${value}`);
  }
  const https = url.protocol === "https:";
  const loopbackHttp = url.protocol === "http:" && options.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(url.hostname);
  if (!https && !loopbackHttp) throw new ServiceEndpointError(`service base must be https: ${value}`);
  if (value !== url.origin && value !== `${url.origin}/`) {
    throw new ServiceEndpointError(`service base must be an origin: ${value}`);
  }
  return url.origin;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** Move targets must be public DNS names; explicit local staging may use loopback. */
function assertPublicHost(origin: string, options: OriginOptions): void {
  const host = new URL(origin).hostname;
  if (options.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(host)) return;
  if (IPV4.test(host) || host.startsWith("[") || !host.includes(".") || host.endsWith(".")) {
    throw new ServiceEndpointError(`service move target must be a public host name: ${origin}`);
  }
}

/** Endpoints remain on the base origin; unknown fields are allowed until a schema-version break. */
export function parseServiceDocument(value: unknown, base: string, options: OriginOptions = {}): ServiceDocument {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new ServiceEndpointError(`${base}${DOCUMENT_PATH}: not a schemaVersion 1 service document`);
  const path = (key: "announcements" | "telemetry"): string | null => {
    const raw = value[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
      throw new ServiceEndpointError(`${base}${DOCUMENT_PATH}: ${key} must be a path on the service origin`);
    }
    const url = new URL(raw, base);
    if (url.origin !== base) throw new ServiceEndpointError(`${base}${DOCUMENT_PATH}: ${key} leaves the service origin`);
    return url.href;
  };
  const origin = (key: "movedTo" | "movedFrom"): string | null => {
    const raw = value[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw new ServiceEndpointError(`${base}${DOCUMENT_PATH}: ${key} must be a URL`);
    const normalized = normalizeServiceBase(raw, options);
    if (key === "movedTo") assertPublicHost(normalized, options);
    return normalized;
  };
  return { announcements: path("announcements"), telemetry: path("telemetry"), movedTo: origin("movedTo"), movedFrom: origin("movedFrom") };
}

/** Absent policy uses defaults; malformed service sections throw rather than fail open. */
export async function readPolicyServiceBase(policyPath: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(policyPath);
  } catch (error) {
    if (await isAdminPolicyFileAbsent(policyPath, error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    // Strict: a duplicated `baseUrl` must not resolve to whichever came last.
    parsed = parseStrictJson(bytes, POLICY_LIMITS);
  } catch (error) {
    throw new ServiceEndpointError(`${policyPath}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ServiceEndpointError(`${policyPath}: the policy file must be a JSON object`);
  const section = parsed.service;
  if (section === undefined) return null;
  if (!isRecord(section) || Object.keys(section).some((key) => key !== "baseUrl") || typeof section.baseUrl !== "string") {
    throw new ServiceEndpointError(`${policyPath}: service must be { "baseUrl": "<https origin>" }`);
  }
  return normalizeServiceBase(section.baseUrl);
}

interface MoveRecord {
  version: 1;
  buildBase: string;
  movedTo: string;
  acceptedAt: string;
}

async function readCappedJson(response: Response, url: string, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ServiceEndpointError(`${url}: larger than ${maxBytes} bytes`);
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceEndpointError(`${url}: empty response`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ServiceEndpointError(`${url}: larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ServiceEndpointError(`${url}: ${(error as Error).message}`);
  }
}

export interface ServiceClientOptions {
  /** Must not follow redirects (the host's single-hop fetch): a 3xx is a failure, so no request leaves the origin. */
  fetchImpl: typeof fetch;
  buildBase: string;
  /** Invalid managed policy throws. */
  policyBase: () => Promise<string | null>;
  /** Development overrides use separate move records to preserve production state. */
  statePath: string;
  appVersion: string;
  allowLoopbackHttp?: boolean;
  now?: () => Date;
  timeoutMs?: number;
}

export class ServiceClient {
  private resolved: ResolvedService | null = null;
  private attemptBase: string | null = null;
  private lastAnnouncements: { base: string; list: MarketplaceAnnouncement[] } | null = null;
  private inFlight: Promise<ResolvedService> | null = null;
  private lastFailureAt: number | null = null;
  private resolvedAt: number | null = null;

  constructor(private readonly options: ServiceClientOptions) {}

  /** Null means no collector; undefined means no valid document is currently in force. */
  telemetryEndpoint(): string | null | undefined {
    if (!this.resolved) return undefined;
    return this.resolved.document.telemetry;
  }

  /** Refresh stale documents even with announcements disabled so policy changes reach telemetry. */
  ensureResolved(): void {
    if (this.inFlight) return;
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (this.resolved && this.resolvedAt !== null && now - this.resolvedAt < REVALIDATE_AFTER_MS) return;
    if (!this.resolved && this.lastFailureAt !== null && now - this.lastFailureAt < RETRY_AFTER_MS) return;
    void this.refresh().catch((error: unknown) => {
      log.warn({ err: (error as Error).message }, "service document unavailable");
    });
  }

  async refresh(): Promise<ResolvedService> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const resolved = await this.resolve();
        this.resolved = resolved;
        this.resolvedAt = (this.options.now?.() ?? new Date()).getTime();
        this.lastFailureAt = null;
        return resolved;
      } catch (error) {
        this.resolved = null;
        this.lastFailureAt = (this.options.now?.() ?? new Date()).getTime();
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Failed announcement reads retain the session list only while its source base remains active. */
  async announcements(): Promise<MarketplaceAnnouncement[]> {
    try {
      const { base, document } = await this.refresh();
      const list = document.announcements
        ? parseMarketplaceAnnouncementRows(await this.getJson(document.announcements, MAX_ANNOUNCEMENTS_BYTES), this.options.appVersion)
        : [];
      this.lastAnnouncements = { base, list };
      return list;
    } catch (error) {
      const last = this.lastAnnouncements;
      if (last === null || last.base !== this.attemptBase) {
        this.lastAnnouncements = null;
        throw error;
      }
      log.warn({ err: (error as Error).message }, "announcements unavailable; keeping the last list read from this base");
      return last.list;
    }
  }

  private async resolve(): Promise<ResolvedService> {
    this.attemptBase = null;
    const policyBase = await this.options.policyBase();
    if (policyBase) {
      this.attemptBase = policyBase;
      return { base: policyBase, source: "policy", document: await this.fetchDocument(policyBase) };
    }

    const buildBase = normalizeServiceBase(this.options.buildBase, this.originOptions());
    const move = await this.readMove();
    if (move !== null && move !== "invalid" && move.buildBase === buildBase) {
      // One move per build constant: the moved base's own movedTo is not followed.
      this.attemptBase = move.movedTo;
      return { base: move.movedTo, source: "moved", document: await this.fetchDocument(move.movedTo) };
    }
    if (move !== null) await this.dropMove();
    this.attemptBase = buildBase;

    const document = await this.fetchDocument(buildBase);
    if (document.movedTo && document.movedTo !== buildBase) {
      try {
        const target = await this.fetchDocument(document.movedTo);
        if (target.movedFrom === buildBase) {
          await this.writeMove({ version: 1, buildBase, movedTo: document.movedTo, acceptedAt: (this.options.now?.() ?? new Date()).toISOString() });
          // Only a move that is recorded changes the base; a failed write stays on the build base.
          this.attemptBase = document.movedTo;
          log.info({ from: buildBase, to: document.movedTo }, "service base moved");
          return { base: document.movedTo, source: "moved", document: target };
        }
        log.warn({ from: buildBase, to: document.movedTo }, "service move not confirmed by movedFrom; staying");
      } catch (error) {
        log.warn({ to: document.movedTo, err: (error as Error).message }, "service move target unavailable; staying");
      }
    }
    return { base: buildBase, source: "build", document };
  }

  private originOptions(): OriginOptions {
    return { allowLoopbackHttp: this.options.allowLoopbackHttp === true };
  }

  private async fetchDocument(base: string): Promise<ServiceDocument> {
    return parseServiceDocument(await this.getJson(`${base}${DOCUMENT_PATH}`, MAX_DOCUMENT_BYTES), base, this.originOptions());
  }

  private async getJson(url: string, maxBytes: number): Promise<unknown> {
    const response = await this.options.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ServiceEndpointError(`${url}: HTTP ${response.status}`);
    }
    return readCappedJson(response, url, maxBytes);
  }

  /** Unreadable move records are ignored; malformed readable records are dropped. */
  private async readMove(): Promise<MoveRecord | "invalid" | null> {
    let text: string;
    try {
      text = await readFile(this.options.statePath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) {
        log.warn({ path: this.options.statePath, err: (error as Error).message }, "service move record cannot be read; ignored");
      }
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed) && parsed.version === 1 && typeof parsed.buildBase === "string" && typeof parsed.movedTo === "string" && typeof parsed.acceptedAt === "string") {
        return {
          version: 1,
          buildBase: normalizeServiceBase(parsed.buildBase, this.originOptions()),
          movedTo: normalizeServiceBase(parsed.movedTo, this.originOptions()),
          acceptedAt: parsed.acceptedAt,
        };
      }
    } catch (error) {
      log.warn({ path: this.options.statePath, err: (error as Error).message }, "service move record unreadable; dropped");
      return "invalid";
    }
    log.warn({ path: this.options.statePath }, "service move record has the wrong shape; dropped");
    return "invalid";
  }

  private async dropMove(): Promise<void> {
    try {
      await rm(this.options.statePath, { force: true });
    } catch (error) {
      log.warn({ path: this.options.statePath, err: (error as Error).message }, "service move record could not be removed");
    }
  }

  private async writeMove(record: MoveRecord): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    writeUtf8FileAtomicSync(this.options.statePath, `${JSON.stringify(record, null, 2)}\n`);
  }
}
