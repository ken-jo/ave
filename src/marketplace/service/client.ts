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
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingPathError, PRIVATE_DIR_MODE, writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { createLogger } from "../../lib/logger.js";
import { parseMarketplaceAnnouncementRows, type MarketplaceAnnouncement } from "../../shared/marketplace-announcements.js";

const log = createLogger("service-endpoint");

/** The build constant: changing it ships with an app update, which drops a move accepted under the old one. */
export const AVE_SERVICE_BASE_URL = "https://former-site.invalid";

const DOCUMENT_PATH = "/.well-known/former-service.json";
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_ANNOUNCEMENTS_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

/** An https origin (no path, query, fragment or credentials), as `scheme://host[:port]`. */
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
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ServiceEndpointError(`service base must be an origin: ${value}`);
  }
  return url.origin;
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
    return normalizeServiceBase(raw, options);
  };
  return { announcements: path("announcements"), telemetry: path("telemetry"), movedTo: origin("movedTo"), movedFrom: origin("movedFrom") };
}

/**
 * `service.baseUrl` from the managed policy file (design §12): null when the
 * file or the section is absent. A section that is not exactly
 * `{ baseUrl: <https origin> }` throws, so a typo does not fail open.
 */
export async function readPolicyServiceBase(policyPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(policyPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  /** Where the accepted move is stored. */
  statePath: string;
  /** Gates announcement actions by `minAppVersion`. */
  appVersion: string;
  allowLoopbackHttp?: boolean;
  now?: () => Date;
}

export class ServiceClient {
  private resolved: ResolvedService | null = null;
  private lastAnnouncements: MarketplaceAnnouncement[] | null = null;

  constructor(private readonly options: ServiceClientOptions) {}

  /** The telemetry endpoint of the last document read; undefined before one is read or while it names none. */
  telemetryEndpoint(): string | undefined {
    return this.resolved?.document.telemetry ?? undefined;
  }

  /** Resolve the base and read its document, following at most one confirmed move from the build constant. */
  async refresh(): Promise<ResolvedService> {
    this.resolved = await this.resolve();
    return this.resolved;
  }

  /**
   * The active announcements. A failed read returns the last list read in
   * this session, so a transient outage does not clear the banner; with
   * nothing read yet it throws.
   */
  async announcements(): Promise<MarketplaceAnnouncement[]> {
    try {
      const { document } = await this.refresh();
      const announcements = document.announcements
        ? parseMarketplaceAnnouncementRows(await this.getJson(document.announcements, MAX_ANNOUNCEMENTS_BYTES), this.options.appVersion)
        : [];
      this.lastAnnouncements = announcements;
      return announcements;
    } catch (error) {
      if (this.lastAnnouncements === null) throw error;
      log.warn({ err: (error as Error).message }, "announcements unavailable; keeping the last list read");
      return this.lastAnnouncements;
    }
  }

  private async resolve(): Promise<ResolvedService> {
    const policyBase = await this.options.policyBase();
    if (policyBase) return { base: policyBase, source: "policy", document: await this.fetchDocument(policyBase) };

    const buildBase = normalizeServiceBase(this.options.buildBase, this.originOptions());
    const move = await this.readMove();
    if (move !== null && move !== "unreadable" && move.buildBase === buildBase) {
      // One move per build constant: the moved base's own movedTo is not followed.
      return { base: move.movedTo, source: "moved", document: await this.fetchDocument(move.movedTo) };
    }
    // A move made under another build constant, or a record that cannot be read, is dropped.
    if (move !== null) await rm(this.options.statePath, { force: true });

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ServiceEndpointError(`${url}: HTTP ${response.status}`);
    }
    return readCappedJson(response, url, maxBytes);
  }

  private async readMove(): Promise<MoveRecord | "unreadable" | null> {
    let text: string;
    try {
      text = await readFile(this.options.statePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
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
      return "unreadable";
    }
    log.warn({ path: this.options.statePath }, "service move record has the wrong shape; dropped");
    return "unreadable";
  }

  private async writeMove(record: MoveRecord): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    writeUtf8FileAtomicSync(this.options.statePath, `${JSON.stringify(record, null, 2)}\n`);
  }
}
