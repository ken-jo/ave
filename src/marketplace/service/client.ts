/**
 * The service endpoint (design §11): one static document on the service base
 * names where announcements and telemetry live, and can move the base to a new
 * domain.
 *
 * The base is the managed policy's `service.baseUrl`, else the move accepted
 * for this build's constant, else the build constant. A move is followed only
 * from the build constant, only when the new base's own document names the old
 * one in `movedFrom`, and at most once per build constant: the accepted move is
 * stored with the constant it was made under and dropped when an update ships
 * another constant. An invalid policy section fails closed — the service is
 * then unavailable rather than silently falling back to the public base.
 *
 * What the client holds follows the last refresh: a failed refresh leaves no
 * telemetry endpoint, and the last announcements are kept only while the base
 * they came from is still the base in force, so a policy that changes during
 * a session never leaves the previous base in use.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingPathError, PRIVATE_DIR_MODE, writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { createLogger } from "../../lib/logger.js";
import { parseStrictJson } from "../../shared/strict-json.js";
import { parseMarketplaceAnnouncementRows, type MarketplaceAnnouncement } from "../../shared/marketplace-announcements.js";

const log = createLogger("service-endpoint");

/** The build constant: changing it ships with an app update, which drops a move accepted under the old one. */
export const AVE_SERVICE_BASE_URL = "https://former-site.invalid";

const DOCUMENT_PATH = "/.well-known/former-service.json";
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_ANNOUNCEMENTS_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** How soon {@link ServiceClient.ensureResolved} tries again after a failed refresh. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const POLICY_LIMITS = { maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 200_000, maxObjectMembers: 10_000, maxArrayItems: 50_000 };

class ServiceEndpointError extends Error {
  override readonly name = "ServiceEndpointError";
}

export interface ServiceDocument {
  /** Absolute URL on the base's origin, or null. */
  announcements: string | null;
  /** Absolute URL on the base's origin, or null while there is no collector. */
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
  /** Plain http to a loopback host: unpackaged builds only (a local staging base). */
  allowLoopbackHttp?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An https origin written exactly as `scheme://host[:port]` (a trailing `/` is
 * allowed): no path, query, fragment, credentials or spelling the URL parser
 * would have to repair.
 */
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

/**
 * A move target is a public DNS name: not an IP literal and not a single-label
 * host, so a document on a compromised base cannot point the app at a private
 * address. (Loopback stays allowed for a local staging base.)
 */
function assertPublicHost(origin: string, options: OriginOptions): void {
  const host = new URL(origin).hostname;
  if (options.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(host)) return;
  if (IPV4.test(host) || host.startsWith("[") || !host.includes(".") || host.endsWith(".")) {
    throw new ServiceEndpointError(`service move target must be a public host name: ${origin}`);
  }
}

/**
 * Parse a service document fetched from `base`. `announcements` and
 * `telemetry` must be paths on the base's own origin; `movedTo` and
 * `movedFrom` are origins. Unknown keys are ignored (a later document may add
 * fields); `schemaVersion` gates a breaking change.
 */
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

/**
 * `service.baseUrl` from the managed policy file (design §12): null when the
 * file or the section is absent. A section that is not exactly
 * `{ baseUrl: <https origin> }` throws, so a typo does not fail open.
 */
export async function readPolicyServiceBase(policyPath: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(policyPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
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
  /** {@link AVE_SERVICE_BASE_URL}, or a development override. */
  buildBase: string;
  /** The managed policy's base; throws when the policy section is invalid. */
  policyBase: () => Promise<string | null>;
  /** Where the accepted move is stored. A development override keeps its own file, so it never drops a production move. */
  statePath: string;
  /** Gates announcement actions by `minAppVersion`. */
  appVersion: string;
  allowLoopbackHttp?: boolean;
  now?: () => Date;
  /** Per-request timeout; tests shorten it. */
  timeoutMs?: number;
}

export class ServiceClient {
  private resolved: ResolvedService | null = null;
  /** The base the current refresh is reading, known before its document arrives. */
  private attemptBase: string | null = null;
  private lastAnnouncements: { base: string; list: MarketplaceAnnouncement[] } | null = null;
  private inFlight: Promise<ResolvedService> | null = null;
  private lastFailureAt: number | null = null;

  constructor(private readonly options: ServiceClientOptions) {}

  /**
   * The telemetry endpoint of the document in force: a URL, null while the
   * document names none, or undefined when no document is in force (none read
   * yet, or the last refresh failed).
   */
  telemetryEndpoint(): string | null | undefined {
    if (!this.resolved) return undefined;
    return this.resolved.document.telemetry;
  }

  /**
   * Start a refresh when no document is in force, none is running and the
   * last failure is older than the retry interval. For callers that need the
   * document only once the user has allowed what it is for.
   */
  ensureResolved(): void {
    if (this.resolved || this.inFlight) return;
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (this.lastFailureAt !== null && now - this.lastFailureAt < RETRY_AFTER_MS) return;
    void this.refresh().catch((error: unknown) => {
      log.warn({ err: (error as Error).message }, "service document unavailable");
    });
  }

  /** Resolve the base and read its document, following at most one confirmed move from the build constant. */
  async refresh(): Promise<ResolvedService> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const resolved = await this.resolve();
        this.resolved = resolved;
        this.lastFailureAt = null;
        return resolved;
      } catch (error) {
        // Nothing from an earlier base stays in force.
        this.resolved = null;
        this.lastFailureAt = (this.options.now?.() ?? new Date()).getTime();
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * The active announcements. A failed read returns the last list read in
   * this session only when it came from the base still in force, so a
   * transient outage does not clear the banner; otherwise it throws.
   */
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
    // A move made under another build constant, or a record with the wrong shape, is dropped.
    if (move !== null) await this.dropMove();
    this.attemptBase = buildBase;

    const document = await this.fetchDocument(buildBase);
    if (document.movedTo && document.movedTo !== buildBase) {
      try {
        const target = await this.fetchDocument(document.movedTo);
        if (target.movedFrom === buildBase) {
          await this.writeMove({ version: 1, buildBase, movedTo: document.movedTo, acceptedAt: (this.options.now?.() ?? new Date()).toISOString() });
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

  /**
   * The accepted move: null when there is none or the file cannot be read (it
   * is then ignored, never trusted and never allowed to stop the service);
   * "invalid" when it reads but does not hold a move record, which is dropped.
   */
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
