/**
 * The one network gate every marketplace target passes (design §7.4, §18.2):
 * git remotes, release and archive downloads, and the managed git archive.
 *
 *   1. normalize (§7.1; a download URL keeps its query, which policy ignores);
 *   2. managed policy (§12, §18.6): `block` wins, then `allow` when present,
 *      then `requireHttps`. An unreadable policy blocks every source but the
 *      official one;
 *   3. the target's class (§18.2.1) and who chose it:
 *      - an entered target (a source's own address, a build constant) is
 *        accepted, warned about, or refused (§18.2.2). A warning the source
 *        does not hold is SOURCE_CONFIRMATION_REQUIRED; a policy-listed host
 *        needs none of `unencrypted`, `internal-network` and `this-computer`,
 *        and an unpackaged build with AVE_DEV=1 none for this computer;
 *      - a catalog-supplied download, and every redirect hop of one, follows
 *        §18.2.3: the source's own host inherits its confirmations, another
 *        internal host needs `internal-downloads`, another service on this
 *        computer is refused (§18.3 #4);
 *      - metadata and unroutable addresses are refused for every target,
 *        policy-listed hosts included (§18.3 #3); `blockPrivateNetworks`
 *        makes internal and this-computer targets a policy block;
 *   4. the address rule is bound to the connection (§18.2.4): this gate does
 *      not resolve. It hands an {@link AddressPolicy} to the git runner (one
 *      lookup per git call, pinned with `http.curloptResolve`, or the ssh
 *      preflight) and to the pinned download transport (one lookup per hop);
 *   5. downloads follow a redirect only after steps 1–4 pass for the new URL,
 *      and never carry `Authorization` or `Cookie` to a different origin. Git
 *      never follows redirects (`http.followRedirects=false`, run-git.ts).
 */
import { isIP } from "node:net";
import {
  NetworkGuardError,
  classifyAddress,
  fetchAddressCheckedResponse,
  type AddressCheckedFetch,
  type AddressClass,
  type AddressPolicy,
} from "../../core/network-guard.js";
import { ConfirmationRequiredError, MarketplaceError, isMarketplaceError, type EnteredTargetWarningView } from "../errors.js";
import { policyBlock, type MarketplacePolicy, type PolicySource } from "../sources/policy.js";
import type { SourceWarning } from "../sources/warnings.js";
import { normalizeDownloadPath, normalizeSourceHost, type NormalizedSourceUrl, type PatternTarget } from "./source-url.js";

export interface NetworkGateOptions {
  /** Read at each check, so a policy change applies to the next operation (§18.6). */
  policy: PolicySource;
  /**
   * An unpackaged build with AVE_DEV=1: entered this-computer targets, and
   * plain http to them, need no confirmation (§18.2.2).
   */
  allowLoopback: boolean;
  /** The pinned download transport (`pinned-fetch.ts`). */
  transport: AddressCheckedFetch;
}

/** Whose target this is: an unreadable policy still lets the official source through. */
export interface GateSubject {
  official: boolean;
}

/** A source's own address, and the confirmations the source holds (§18.5). */
export interface RemoteSubject extends GateSubject {
  acknowledged: ReadonlySet<SourceWarning>;
}

/** What the git runner needs to reach a remote under the gate. */
export interface RemoteVerdict {
  /** `GIT_ALLOW_PROTOCOL` may name `http`: the source is http and was listed, acknowledged or exempt. */
  allowHttp: boolean;
  /** Credentials may answer: always over https and ssh, over http only with `token-unencrypted` (§18.2.2). */
  credentialsAllowed: boolean;
  /** The rule each resolved address of the remote's host is judged by. */
  addressPolicy: AddressPolicy;
}

/** The source whose catalog named a download (§18.2.3). */
export interface CatalogSource {
  id: string;
  /** How messages name the source. */
  label: string;
  url: NormalizedSourceUrl;
  acknowledged: ReadonlySet<SourceWarning>;
}

export interface GatedFetchInit extends GateSubject {
  /** The source whose catalog named the URL; null for an address Ave itself chose (an entered target). */
  catalog: CatalogSource | null;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
}

const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie"];

/**
 * How restrictive a dropped answer's refusal is: when every answer is
 * refused, the hop fails with the highest (`selectAnswers`).
 */
const RANK: Record<Exclude<AddressClass, "public">, number> = {
  metadata: 4,
  unroutable: 3,
  "this-computer": 2,
  internal: 1,
};

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

/** The host as an address when it is an IP literal, else null. */
function literalAddress(host: string): string | null {
  const bare = bareHost(host);
  return isIP(bare) !== 0 ? bare : null;
}

/** A this-computer host known without a lookup: a loopback or unspecified literal, or `localhost`. */
function isLoopbackName(host: string): boolean {
  const literal = literalAddress(host);
  return literal !== null ? classifyAddress(literal) === "this-computer" : host === "localhost";
}

/** The port a URL's web server listens on: an ssh source's derived release URL is https on 443 (§6.2). */
function webPort(url: NormalizedSourceUrl | URL): number {
  if (url instanceof URL) return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (url.scheme === "ssh") return 443;
  return url.port ?? (url.scheme === "https" ? 443 : 80);
}

/** A refusal or block carried through the guard as one answer's verdict. */
function verdict(error: MarketplaceError, rank: number, fatal = false): NetworkGuardError {
  return new NetworkGuardError(error.message, { cause: error, rank, fatal });
}

export class NetworkGate {
  constructor(private readonly options: NetworkGateOptions) {}

  private get policy(): MarketplacePolicy | null {
    const load = this.options.policy.load;
    return load.ok ? load.policy : null;
  }

  private get policyPath(): string {
    return this.options.policy.load.path;
  }

  private listed(host: string): boolean {
    const policy = this.policy;
    return policy !== null && hostListedBy(policy).has(host);
  }

  /** Step 2 for one normalized target: block, allow, `requireHttps`. */
  private checkPolicy(url: NormalizedSourceUrl, subject: GateSubject, target: PatternTarget): void {
    const load = this.options.policy.load;
    if (!load.ok) {
      if (!subject.official) {
        throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the managed marketplace policy is invalid: ${load.error}`, {
          detail: { reason: "policy-invalid", error: load.error },
        });
      }
      return;
    }
    const block = policyBlock(load.policy, url, target);
    if (block) {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `blocked by managed policy: ${url.url}`, {
        detail: block.reason === "blocked-by-pattern"
          ? { reason: block.reason, target: url.url, pattern: block.pattern, policyPath: this.policyPath }
          : { reason: block.reason, target: url.url, policyPath: this.policyPath },
      });
    }
    if (url.scheme === "http" && load.policy.requireHttps && !load.policy.allowHttpHosts.has(url.host)) {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `managed policy requires https: ${url.url}`, {
        detail: { reason: "https-required", target: url.url, policyPath: this.policyPath },
      });
    }
  }

  /** Metadata and unroutable answers: refused for every target, listed or not (§18.3 #3). */
  private refusal(kind: "metadata" | "unroutable", host: string, address: string): NetworkGuardError {
    const reason = kind === "metadata" ? "address-metadata" : "address-unroutable";
    return verdict(new MarketplaceError("SOURCE_URL_REJECTED", `${host} resolves to ${address}, a ${kind} address`, { detail: { reason, host, address } }), RANK[kind]);
  }

  private privateBlock(kind: "internal" | "this-computer", target: string, address: string): NetworkGuardError {
    return verdict(
      new MarketplaceError("SOURCE_POLICY_BLOCKED", `managed policy blocks ${kind} targets: ${target} resolves to ${address}`, {
        detail: { reason: "private-network-blocked", target, address, policyPath: this.policyPath },
      }),
      RANK[kind],
    );
  }

  /**
   * The rule for an entered target's addresses (§18.2.2): public accepted;
   * internal and this-computer accepted when listed, blocked under
   * `blockPrivateNetworks`, else accepted with the source's confirmation
   * (this computer also in a dev build) or failing the connection with
   * SOURCE_CONFIRMATION_REQUIRED.
   */
  private enteredPolicy(host: string, target: string, acknowledged: ReadonlySet<SourceWarning>): AddressPolicy {
    const listed = this.listed(host);
    return (address) => {
      const kind = classifyAddress(address);
      switch (kind) {
        case "public":
          return "allow";
        case "metadata":
        case "unroutable":
          return this.refusal(kind, host, address);
        case "internal":
        case "this-computer": {
          if (listed) return "allow";
          if (this.policy?.blockPrivateNetworks) return this.privateBlock(kind, target, address);
          if (kind === "this-computer" && this.options.allowLoopback) return "allow";
          const warning = kind === "internal" ? "internal-network" : "this-computer";
          if (acknowledged.has(warning)) return "allow";
          return verdict(new ConfirmationRequiredError(`${host} resolves to ${address} (${kind}); the source needs the ${warning} confirmation`, [{ warning, host, address }]), RANK[kind], true);
        }
      }
    };
  }

  /**
   * Steps 1–3 for a git remote, without any lookup: policy, the lexical
   * warnings (`unencrypted`, a literal address's class) and the address rule
   * the runner judges every answer by. Throws SOURCE_CONFIRMATION_REQUIRED
   * listing every warning the source does not hold that is known now.
   */
  checkRemote(url: NormalizedSourceUrl, subject: RemoteSubject): RemoteVerdict {
    this.checkPolicy(url, subject, "repository");
    const addressPolicy = this.enteredPolicy(url.host, url.url, subject.acknowledged);
    const missing: EnteredTargetWarningView[] = [];
    if (url.scheme === "http" && !this.listed(url.host) && !(this.options.allowLoopback && isLoopbackName(url.host)) && !subject.acknowledged.has("unencrypted")) {
      missing.push({ warning: "unencrypted", host: url.host, address: null });
    }
    const literal = literalAddress(url.host);
    if (literal !== null) {
      const judged = addressPolicy(literal, new URL(`https://${url.host}/`));
      if (judged !== "allow") {
        const cause = judged.cause;
        if (cause instanceof ConfirmationRequiredError) missing.push(...cause.warnings);
        else throw cause instanceof MarketplaceError ? cause : judged;
      }
    }
    if (missing.length > 0) throw new ConfirmationRequiredError(`${url.url} needs ${missing.map((item) => item.warning).join(", ")}`, missing);
    return {
      allowHttp: url.scheme === "http",
      credentialsAllowed: url.scheme !== "http" || subject.acknowledged.has("token-unencrypted"),
      addressPolicy,
    };
  }

  /** Step 2 alone for the policy view of `url`: an add re-checks the policy it was previewed under (§18.6). */
  checkSourcePolicy(url: NormalizedSourceUrl, subject: GateSubject): void {
    this.checkPolicy(url, subject, "repository");
  }

  /**
   * The rule for a download's addresses at one hop (§18.2.3). An entered
   * download (`catalog` null) follows §18.2.2 with no confirmations.
   */
  private downloadPolicy(catalog: CatalogSource | null): AddressPolicy {
    return (address, hop) => {
      const kind = classifyAddress(address);
      const host = normalizeSourceHost(hop.href, hop.hostname);
      if (kind === "public") return "allow";
      if (kind === "metadata" || kind === "unroutable") return this.refusal(kind, host, address);
      if (catalog === null) return this.enteredPolicy(host, hop.href, new Set())(address, hop);
      // The source's own host inherits the source's confirmations; on this computer only at its own port.
      const ownHost = host === catalog.url.host && (kind !== "this-computer" || webPort(hop) === webPort(catalog.url));
      if (ownHost) return this.enteredPolicy(host, hop.href, catalog.acknowledged)(address, hop);
      // A hard refusal (§18.3 #4) comes before every exemption: listing one service on this
      // computer must not let any catalog reach the others.
      if (kind === "this-computer") {
        return verdict(
          new MarketplaceError("SOURCE_URL_REJECTED", `${catalog.label} points a download at this computer (${host}, ${address})`, {
            detail: { reason: "catalog-this-computer", source: catalog.label, host },
          }),
          RANK[kind],
        );
      }
      if (this.listed(host)) return "allow";
      if (this.policy?.blockPrivateNetworks) return this.privateBlock(kind, hop.href, address);
      if (catalog.acknowledged.has("internal-downloads")) return "allow";
      return verdict(
        new MarketplaceError("SOURCE_CONFIRMATION_REQUIRED", `${catalog.label} names ${host} (${address}), another internal host; the source needs internal-downloads`, {
          detail: { reason: "internal-downloads", source: catalog.label, host },
        }),
        RANK[kind],
        true,
      );
    };
  }

  /**
   * Policy and scheme for a download that is fetched under another URL: a
   * GitHub release asset a token fetches through api.github.com is governed
   * by the rules for its github.com repository.
   */
  checkDownloadPolicy(rawUrl: string, subject: GateSubject): void {
    this.checkPolicy(downloadUrlForPolicy(new URL(rawUrl)), subject, "download");
  }

  /** A download under steps 1–5, over the pinned transport. */
  async fetch(rawUrl: string, init: GatedFetchInit): Promise<Response> {
    let start: URL;
    try {
      start = new URL(rawUrl);
    } catch {
      throw new MarketplaceError("SOURCE_URL_REJECTED", "download URL is malformed");
    }
    const { official, catalog, method = "GET", headers = {}, signal, timeoutMs, maxRedirects } = init;
    // Policy first, so a blocked host is reported as blocked, not as a DNS failure.
    this.checkPolicy(downloadUrlForPolicy(start), { official }, "download");
    const origin = start.origin;
    const transport: AddressCheckedFetch = async (input, hopInit, select) => {
      const hop = new URL(input);
      this.checkPolicy(downloadUrlForPolicy(hop), { official }, "download");
      // A catalog's http download is verified by its pinned sha256 (§18.2.3); an address Ave chose holds no confirmation for http.
      if (catalog === null && hop.protocol === "http:") {
        const host = normalizeSourceHost(hop.href, hop.hostname);
        if (!this.listed(host) && !(this.options.allowLoopback && isLoopbackName(host))) {
          throw new ConfirmationRequiredError(`${hop.href} is plain http`, [{ warning: "unencrypted", host, address: null }]);
        }
      }
      const hopHeaders = new Headers(hopInit.headers);
      if (hop.origin !== origin) {
        for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) hopHeaders.delete(name);
      }
      return this.options.transport(hop.href, { ...hopInit, headers: hopHeaders }, select);
    };
    try {
      return await fetchAddressCheckedResponse(rawUrl, {
        addressPolicy: this.downloadPolicy(catalog),
        fetchImpl: transport,
        method,
        headers,
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxRedirects !== undefined ? { maxRedirects } : {}),
      });
    } catch (error) {
      throw mapGuardError(error, start.host);
    }
  }
}

/** `getaddrinfo` failures: the name has no address, or no resolver answered. */
const DNS_ERROR_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "ENODATA"]);
const REFUSED_ERROR_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "EPIPE"]);

function isTlsError(code: string | undefined): boolean {
  return code !== undefined && (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
}

/**
 * A failure of the gate's fetch as a marketplace error: an answer's verdict
 * carries its refusal, block or confirmation; a connection failure becomes
 * SOURCE_UNREACHABLE with its reason when the error names one.
 */
export function mapGuardError(error: unknown, host: string): MarketplaceError {
  if (isMarketplaceError(error)) return error;
  if (error instanceof NetworkGuardError && isMarketplaceError(error.cause)) return error.cause;
  const code = (error as NodeJS.ErrnoException).code;
  const message = `${host}: ${(error as Error).message}`;
  if (code !== undefined && DNS_ERROR_CODES.has(code)) return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error, detail: { reason: "dns", host } });
  if (code === "ENETUNREACH") return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error, detail: { reason: "offline" } });
  if (code === "ETIMEDOUT") return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error, detail: { reason: "timeout", host } });
  if (code !== undefined && REFUSED_ERROR_CODES.has(code)) return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error, detail: { reason: "refused", host } });
  if (isTlsError(code)) return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error, detail: { reason: "tls", host } });
  return new MarketplaceError("SOURCE_UNREACHABLE", message, { cause: error });
}
