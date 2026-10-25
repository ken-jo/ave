/** Every target passes policy and address checks; metadata and unroutable answers are always refused.
 * Bind checked addresses to connections and recheck redirects without forwarding cross-origin credentials. */
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
import { folderPolicyBlock, policyBlock, type MarketplacePolicy, type PolicySource } from "../sources/policy.js";
import type { SourceWarning } from "../sources/warnings.js";
import { createMarketplaceLogger } from "../log.js";
import type { FolderNetwork } from "./source-input.js";
import { normalizeDownloadPath, normalizeSourceHost, type NormalizedSourceUrl, type PatternTarget } from "./source-url.js";

export interface NetworkGateOptions {
  /** Read policy at each check so changes affect the next operation. */
  policy: PolicySource;
  /** Explicit unpackaged development builds exempt entered loopback targets from confirmation. */
  allowLoopback: boolean;
  transport: AddressCheckedFetch;
}

/** Whose target this is: an unreadable policy still lets the official source through. */
export interface GateSubject {
  official: boolean;
}

export interface RemoteSubject extends GateSubject {
  acknowledged: ReadonlySet<SourceWarning>;
}

export interface RemoteVerdict {
  /** HTTP is allowed only for a listed, acknowledged or explicitly exempt source. */
  allowHttp: boolean;
  /** HTTP credentials require token-unencrypted consent; HTTPS and SSH do not. */
  credentialsAllowed: boolean;
  addressPolicy: AddressPolicy;
}

export interface CatalogSource {
  id: string;
  label: string;
  url: NormalizedSourceUrl;
  acknowledged: ReadonlySet<SourceWarning>;
}

export interface GatedFetchInit extends GateSubject {
  /** Null for host-chosen targets rather than catalog downloads. */
  catalog: CatalogSource | null;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Observe immutable snapshots of accepted hops; observer failures cannot alter transport or policy. */
  onHop?: (hop: string) => void;
}

const log = createMarketplaceLogger("marketplace-network-gate");

const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie"];

/** When all answers fail, report the most restrictive refusal. */
const RANK: Record<Exclude<AddressClass, "public">, number> = {
  metadata: 4,
  unroutable: 3,
  "this-computer": 2,
  internal: 1,
};

function hostListedBy(policy: MarketplacePolicy): Set<string> {
  const hosts = new Set(policy.allowHttpHosts);
  for (const pattern of policy.allow ?? []) {
    if (pattern.kind === "path") continue;
    hosts.add(pattern.kind === "exact" ? pattern.url.host : pattern.host);
  }
  for (const spec of policy.additional) if (spec.transport === "git") hosts.add(spec.url.host);
  return hosts;
}

/** Queries do not participate in policy URL matching. */
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

function literalAddress(host: string): string | null {
  const bare = bareHost(host);
  return isIP(bare) !== 0 ? bare : null;
}

function isLoopbackName(host: string): boolean {
  const literal = literalAddress(host);
  return literal !== null ? classifyAddress(literal) === "this-computer" : host === "localhost";
}

/** Release URLs derived from SSH sources use HTTPS port 443. */
function webPort(url: NormalizedSourceUrl | URL): number {
  if (url instanceof URL) return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (url.scheme === "ssh") return 443;
  return url.port ?? (url.scheme === "https" ? 443 : 80);
}

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

  /** Metadata and unroutable answers are refused even for policy-listed targets. */
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

  /** Private-network policy blocks override consent; other internal targets require listing or confirmation. */
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

  /** Check lexical policy and known warnings before lookup; the connection must enforce the returned address rule. */
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

  /** Recheck preview policy when adding the source. */
  checkSourcePolicy(url: NormalizedSourceUrl, subject: GateSubject): void {
    this.checkPolicy(url, subject, "repository");
  }

  /** Check lexical and canonical folder paths; unreadable policy blocks every folder before access. */
  checkFolderPolicy(path: string): void {
    const load = this.options.policy.load;
    if (!load.ok) {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the managed marketplace policy is invalid: ${load.error}`, {
        detail: { reason: "policy-invalid", error: load.error },
      });
    }
    const block = folderPolicyBlock(load.policy, path);
    if (!block) return;
    const message = block.reason === "local-sources-blocked" ? `managed policy allows no folder sources: ${path}` : `blocked by managed policy: ${path}`;
    throw new MarketplaceError("SOURCE_POLICY_BLOCKED", message, {
      detail: block.reason === "blocked-by-pattern"
        ? { reason: block.reason, target: path, pattern: block.pattern, policyPath: this.policyPath }
        : { reason: block.reason, target: path, policyPath: this.policyPath },
    });
  }

  /** Require network-folder consent before any access; managed folders obtain it from policy entries. */
  checkFolder(path: string, network: FolderNetwork, acknowledged: ReadonlySet<SourceWarning>): void {
    this.checkFolderPolicy(path);
    if (network.network && !acknowledged.has("network-folder")) {
      throw new ConfirmationRequiredError(`${path} is a folder on another computer; the source needs the network-folder confirmation`, [
        { warning: "network-folder", host: network.server, address: path },
      ]);
    }
  }

  /** Direct-install policy applies to git and folder previews, additions and installs, failing closed. */
  checkDirectInstall(target: string): void {
    const load = this.options.policy.load;
    if (!load.ok) {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the managed marketplace policy is invalid: ${load.error}`, {
        detail: { reason: "policy-invalid", error: load.error },
      });
    }
    if (load.policy.allowDirectInstall) return;
    throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `managed policy allows installs from marketplaces only: ${target}`, {
      detail: { reason: "direct-install-blocked", target, policyPath: this.policyPath },
    });
  }

  /** Host-chosen downloads have no inherited confirmations; catalog downloads use source consent. */
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
      // Refuse other local services before exemptions; listing one port cannot authorize every port.
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

  /** Tokenized release API requests remain governed by their source repository policy. */
  checkDownloadPolicy(rawUrl: string, subject: GateSubject): void {
    this.checkPolicy(downloadUrlForPolicy(new URL(rawUrl)), subject, "download");
  }

  async fetch(rawUrl: string, init: GatedFetchInit): Promise<Response> {
    let start: URL;
    try {
      start = new URL(rawUrl);
    } catch {
      throw new MarketplaceError("SOURCE_URL_REJECTED", "download URL is malformed");
    }
    const { official, catalog, method = "GET", headers = {}, signal, timeoutMs, maxRedirects, onHop } = init;
    // Policy first, so a blocked host is reported as blocked, not as a DNS failure.
    this.checkPolicy(downloadUrlForPolicy(start), { official }, "download");
    const origin = start.origin;
    const transport: AddressCheckedFetch = async (input, hopInit, select) => {
      const hop = new URL(input);
      this.checkPolicy(downloadUrlForPolicy(hop), { official }, "download");
      // Catalog HTTP bytes require a pinned hash; host-chosen HTTP targets have no inherited consent.
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
      const requested = hop.href;
      const response = await this.options.transport(requested, { ...hopInit, headers: hopHeaders }, select);
      if (onHop) observeHop(onHop, requested);
      return response;
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

/** Observer failures cannot affect downloads; diagnostics use only the origin and a fixed thrown-kind label. */
function observeHop(onHop: (hop: string) => void, hop: string): void {
  try {
    onHop(hop);
  } catch (error) {
    try {
      log.warn(`download hop observer failed for ${new URL(hop).origin}: ${thrownKind(error)}`);
    } catch {
    }
  }
}

/** Never read observer-controlled error text; it may contain credentials. */
type ThrownKind = "error" | "non-error-object" | "primitive" | "unreadable";

function thrownKind(error: unknown): ThrownKind {
  if (typeof error !== "object" && typeof error !== "function") return "primitive";
  if (error === null) return "primitive";
  try {
    // A Proxy's getPrototypeOf trap runs here, and may throw.
    return error instanceof Error ? "error" : "non-error-object";
  } catch {
    return "unreadable";
  }
}

const DNS_ERROR_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "ENODATA"]);
const REFUSED_ERROR_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "EPIPE"]);

function isTlsError(code: string | undefined): boolean {
  return code !== undefined && (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
}

/** Preserve address-policy verdicts; map connection failures to unreachable with a stable reason. */
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
