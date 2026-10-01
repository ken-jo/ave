/**
 * The one network gate every marketplace target passes (design §7.4): git
 * remotes, release and archive downloads, and the service endpoint.
 *
 *   1. normalize (§7.1; a download URL keeps its query, which policy ignores);
 *   2. managed policy: `block` wins, then `allow` when present. An unreadable
 *      policy blocks every source but the official one (policy.ts);
 *   3. plain http only for `allowHttpHosts`, or loopback when a dev build
 *      allows it;
 *   4. the shared SSRF guard (`src/core/network-guard.ts`): loopback,
 *      link-local, private and metadata addresses are refused unless the host
 *      is policy-listed (private and CGNAT ranges only) or a dev build allows
 *      loopback;
 *   5. downloads follow a redirect only after steps 1–4 pass for the new URL,
 *      and never carry `Authorization` or `Cookie` to a different origin. Git
 *      never follows redirects (`http.followRedirects=false`, run-git.ts).
 *
 * Git resolves the host again when it connects, so the address check for a
 * git remote is a pre-flight, not a pin; what a remote can reach through git
 * is bounded by the protocol allow-list and the no-redirect rule instead.
 */
import {
  NetworkGuardError,
  ensurePublicHttpUrl,
  fetchPublicHttpResponse,
  resolvesToLoopbackOnly,
} from "../../core/network-guard.js";
import { MarketplaceError } from "../errors.js";
import { policyBlock, type MarketplacePolicy, type PolicyLoad } from "../sources/policy.js";
import { normalizeDownloadPath, normalizeSourceHost, type NormalizedSourceUrl, type PatternTarget } from "./source-url.js";

export interface NetworkGateOptions {
  policy: PolicyLoad;
  /** Dev and test builds: loopback targets (and plain http to them) are allowed. */
  allowLoopback: boolean;
}

/** Whose target this is: an unreadable policy still lets the official source through. */
export interface GateSubject {
  official: boolean;
}

export interface GatedFetchInit extends GateSubject {
  fetchImpl: typeof fetch;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
}

const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie"];

function hostListedBy(policy: MarketplacePolicy): Set<string> {
  const hosts = new Set(policy.allowHttpHosts);
  for (const pattern of policy.allow ?? []) {
    hosts.add(pattern.kind === "exact" ? pattern.url.host : pattern.host);
  }
  for (const spec of policy.additional) hosts.add(spec.url.host);
  return hosts;
}

/** The policy view of a download URL: same host and path rules as a source URL, query ignored. */
export function downloadUrlForPolicy(url: URL): NormalizedSourceUrl {
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
  if (!scheme || url.username || url.password) {
    throw new MarketplaceError("SOURCE_URL_REJECTED", `download URL rejected: ${url.origin}${url.pathname}`);
  }
  const host = normalizeSourceHost(url.href, url.hostname);
  const port = url.port === "" ? null : Number(url.port);
  const path = normalizeDownloadPath(url.href, url.pathname);
  const authority = port === null ? host : `${host}:${port}`;
  return { scheme, user: null, host, port, path, url: `${scheme}://${authority}${path}` };
}

function bareHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export class NetworkGate {
  private readonly policy: MarketplacePolicy | null;
  private readonly policyPath: string;
  private readonly listedHosts: ReadonlySet<string>;

  constructor(private readonly options: NetworkGateOptions) {
    this.policy = options.policy.ok ? options.policy.policy : null;
    this.policyPath = options.policy.path;
    this.listedHosts = this.policy ? hostListedBy(this.policy) : new Set();
  }

  /** Steps 2–3 for one normalized target. Returns whether plain http is permitted for it. */
  private async checkPolicyAndScheme(url: NormalizedSourceUrl, subject: GateSubject, target: PatternTarget): Promise<{ allowHttp: boolean }> {
    const load = this.options.policy;
    if (!load.ok) {
      if (!subject.official) {
        throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the managed marketplace policy is invalid: ${load.error}`, {
          detail: { reason: "policy-invalid", error: load.error },
        });
      }
    } else {
      const block = policyBlock(load.policy, url, target);
      if (block) {
        throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `blocked by managed policy: ${url.url}`, {
          detail: block.reason === "blocked-by-pattern"
            ? { reason: block.reason, target: url.url, pattern: block.pattern, policyPath: this.policyPath }
            : { reason: block.reason, target: url.url, policyPath: this.policyPath },
        });
      }
    }
    if (url.scheme !== "http") return { allowHttp: false };
    if (this.policy?.allowHttpHosts.has(url.host)) return { allowHttp: true };
    if (this.options.allowLoopback && (await resolvesToLoopbackOnly(bareHost(url.host)))) return { allowHttp: true };
    throw new MarketplaceError("SOURCE_URL_REJECTED", `plain http is not allowed for ${url.host}`);
  }

  private guardScope(): Parameters<typeof ensurePublicHttpUrl>[1] {
    const listed = (target: URL) => this.listedHosts.has(normalizeSourceHost(target.href, target.hostname));
    return {
      allowPrivateNetworks: listed,
      allowCarrierGradeNat: listed,
      allowLoopback: this.options.allowLoopback,
    };
  }

  /** Pre-flight for a git remote. Resolves to the `allowHttp` flag run-git needs. */
  async checkRemote(url: NormalizedSourceUrl, subject: GateSubject): Promise<{ allowHttp: boolean }> {
    const verdict = await this.checkPolicyAndScheme(url, subject, "repository");
    const port = url.port === null ? "" : `:${url.port}`;
    try {
      // Any http(s) spelling of the host works: only its addresses are checked.
      await ensurePublicHttpUrl(`https://${url.host}${port}/`, this.guardScope());
    } catch (error) {
      throw mapGuardError(error, url.host);
    }
    return verdict;
  }

  /**
   * Policy and scheme for a download that is fetched under another URL: a
   * GitHub release asset a token fetches through api.github.com is governed
   * by the rules for its github.com repository.
   */
  async checkDownloadPolicy(rawUrl: string, subject: GateSubject): Promise<void> {
    await this.checkPolicyAndScheme(downloadUrlForPolicy(new URL(rawUrl)), subject, "download");
  }

  /** A download or service call under steps 1–5. */
  async fetch(rawUrl: string, init: GatedFetchInit): Promise<Response> {
    let start: URL;
    try {
      start = new URL(rawUrl);
    } catch {
      throw new MarketplaceError("SOURCE_URL_REJECTED", "download URL is malformed");
    }
    const { fetchImpl, official, method = "GET", headers = {}, signal, timeoutMs, maxRedirects } = init;
    // Policy first, so a blocked host is reported as blocked, not as a DNS failure.
    await this.checkPolicyAndScheme(downloadUrlForPolicy(start), { official }, "download");
    const origin = start.origin;
    const gatedFetch: typeof fetch = async (input, hopInit) => {
      const hop = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      await this.checkPolicyAndScheme(downloadUrlForPolicy(hop), { official }, "download");
      const hopHeaders = new Headers(hopInit?.headers);
      if (hop.origin !== origin) {
        for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) hopHeaders.delete(name);
      }
      return fetchImpl(hop.href, { ...hopInit, headers: hopHeaders });
    };
    try {
      return await fetchPublicHttpResponse(rawUrl, {
        ...this.guardScope(),
        method,
        headers,
        fetchImpl: gatedFetch,
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxRedirects !== undefined ? { maxRedirects } : {}),
      });
    } catch (error) {
      if (error instanceof MarketplaceError) throw error;
      throw mapGuardError(error, start.host);
    }
  }
}

/** `getaddrinfo` failures: the name has no address, or no resolver answered. */
const DNS_ERROR_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "ENODATA"]);

function mapGuardError(error: unknown, host: string): MarketplaceError {
  if (error instanceof MarketplaceError) return error;
  if (error instanceof NetworkGuardError && /non-public address/u.test(error.message)) {
    return new MarketplaceError("SOURCE_URL_REJECTED", `${host}: ${error.message}`, { cause: error });
  }
  const code = (error as NodeJS.ErrnoException).code;
  const resolved = code !== undefined && DNS_ERROR_CODES.has(code);
  return new MarketplaceError("SOURCE_UNREACHABLE", `${host}: ${(error as Error).message}`, {
    cause: error,
    ...(resolved ? { detail: { reason: "dns", host } } : {}),
  });
}
