import { createHash, randomUUID, webcrypto } from "node:crypto";

const DPOP_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const NONCE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;

export class DpopError extends Error {
  constructor(readonly code: "oauth-dpop-unsupported" | "oauth-dpop-failed" | "oauth-dpop-key-invalid") {
    super(code === "oauth-dpop-unsupported" ? "Authorization server does not support the required proof algorithm"
      : code === "oauth-dpop-key-invalid" ? "Proof credential key cannot be read" : "Proof authorization failed");
    this.name = "DpopError";
  }
}

interface PublicKeyJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

function publicKeyJwk(value: unknown): PublicKeyJwk {
  if (!value || typeof value !== "object") throw new DpopError("oauth-dpop-key-invalid");
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x) || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.y) || "d" in jwk) {
    throw new DpopError("oauth-dpop-key-invalid");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** Only host credential storage may consume the serialization; live signing keys cannot be exported. */
export class DpopKey {
  readonly #privateKey: webcrypto.CryptoKey;
  readonly #publicKey: PublicKeyJwk;
  readonly #serialized: string;

  private constructor(privateKey: webcrypto.CryptoKey, publicKey: PublicKeyJwk, serialized: string) {
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.#serialized = serialized;
  }

  static async create(): Promise<DpopKey> {
    const pair = await webcrypto.subtle.generateKey(DPOP_ALGORITHM, true, ["sign", "verify"]);
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
    try {
      const publicKey = publicKeyJwk(await webcrypto.subtle.exportKey("jwk", pair.publicKey));
      const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, DPOP_ALGORITHM, false, ["sign"]);
      const serialized = JSON.stringify({ version: 1, pkcs8: Buffer.from(pkcs8).toString("base64url"), publicKey });
      return new DpopKey(privateKey, publicKey, serialized);
    } finally {
      new Uint8Array(pkcs8).fill(0);
    }
  }

  static async restore(serialized: string): Promise<DpopKey> {
    try {
      if (serialized.length > 8192) throw new DpopError("oauth-dpop-key-invalid");
      const saved = JSON.parse(serialized) as Record<string, unknown>;
      if (saved.version !== 1 || typeof saved.pkcs8 !== "string" || saved.pkcs8.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(saved.pkcs8)) {
        throw new DpopError("oauth-dpop-key-invalid");
      }
      const publicKey = publicKeyJwk(saved.publicKey);
      const bytes = Buffer.from(saved.pkcs8, "base64url");
      try {
        const privateKey = await webcrypto.subtle.importKey("pkcs8", bytes, DPOP_ALGORITHM, false, ["sign"]);
        const verificationKey = await webcrypto.subtle.importKey("jwk", publicKey, DPOP_ALGORITHM, false, ["verify"]);
        const challenge = webcrypto.getRandomValues(new Uint8Array(32));
        const signature = await webcrypto.subtle.sign(SIGN_ALGORITHM, privateKey, challenge);
        if (!await webcrypto.subtle.verify(SIGN_ALGORITHM, verificationKey, signature, challenge)) {
          throw new DpopError("oauth-dpop-key-invalid");
        }
        return new DpopKey(privateKey, publicKey, serialized);
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw new DpopError("oauth-dpop-key-invalid");
    }
  }

  serialize(): string { return this.#serialized; }

  async thumbprint(): Promise<string> {
    const { crv, kty, x, y } = this.#publicKey;
    return createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
  }

  async proof(url: string, method: string, options: { nonce?: string; accessToken?: string } = {}): Promise<string> {
    let target: URL;
    try { target = new URL(url); }
    catch { throw new DpopError("oauth-dpop-failed"); }
    if (target.username || target.password || (target.protocol !== "https:" &&
      !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))) {
      throw new DpopError("oauth-dpop-failed");
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(method) ||
      (options.nonce !== undefined && !NONCE_PATTERN.test(options.nonce)) ||
      (options.accessToken !== undefined && !TOKEN_PATTERN.test(options.accessToken))) {
      throw new DpopError("oauth-dpop-failed");
    }
    target.search = "";
    target.hash = "";
    const payload = { jti: randomUUID(), htm: new Request(target.href, { method }).method, htu: target.href, iat: Math.floor(Date.now() / 1000),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
      ...(options.accessToken === undefined ? {} : {
        ath: createHash("sha256").update(options.accessToken, "ascii").digest("base64url"),
      }) };
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.#publicKey };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = await webcrypto.subtle.sign(SIGN_ALGORITHM, this.#privateKey, Buffer.from(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  }
}

/** A present capability never silently falls back to bearer credentials. */
export function negotiateDpop(metadata: unknown, required: boolean): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new DpopError("oauth-dpop-failed");
  const algorithms = (metadata as Record<string, unknown>).dpop_signing_alg_values_supported;
  if (algorithms === undefined) {
    if (required) throw new DpopError("oauth-dpop-unsupported");
    return false;
  }
  if (!Array.isArray(algorithms) || !algorithms.every(algorithm => typeof algorithm === "string" && algorithm.length > 0)) {
    throw new DpopError("oauth-dpop-failed");
  }
  if (!algorithms.includes("ES256")) throw new DpopError("oauth-dpop-unsupported");
  return true;
}

type ProofError = "use_dpop_nonce" | "invalid_dpop_proof";

function resourceProofError(header: string | null): ProofError | undefined {
  if (!header) return undefined;
  // Commas within quoted values are parameters, rather than new challenges.
  const parts = header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/gu);
  if (!parts) return undefined;
  let scheme = "";
  let error: string | undefined;
  const matches = (): ProofError | undefined => scheme.toLowerCase() === "dpop" &&
    (error === "use_dpop_nonce" || error === "invalid_dpop_proof") ? error : undefined;
  const attributePattern = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))$/u;
  for (const part of parts) {
    let attribute = attributePattern.exec(part.trim());
    // Parameter whitespace is allowed around '=' and must not mint a new scheme.
    if (!attribute) {
      const challenge = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]+(.*))?$/u.exec(part.trim());
      if (!challenge) continue;
      const matched = matches();
      if (matched) return matched;
      scheme = challenge[1];
      error = undefined;
      attribute = attributePattern.exec(challenge[2] ?? "");
    }
    if (attribute?.[1].toLowerCase() === "error") {
      if (error !== undefined) return undefined;
      error = (attribute[2] ?? attribute[3]).replace(/\\(.)/gu, "$1");
    }
  }
  return matches();
}

async function tokenProofError(response: Response): Promise<ProofError | undefined> {
  if (response.status !== 400) return undefined;
  try {
    const body: unknown = await response.clone().json();
    const error = body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).error : undefined;
    return error === "use_dpop_nonce" || error === "invalid_dpop_proof" ? error : undefined;
  } catch {
    throw new DpopError("oauth-dpop-failed");
  }
}

/** One fetch wrapper owns one nonce domain; token and resource wrappers must remain separate. */
export function createDpopFetch(key: DpopKey, fetchFn: typeof fetch, kind: "token" | "resource", accessToken?: string): typeof fetch {
  if (kind === "resource" && (accessToken === undefined || !TOKEN_PATTERN.test(accessToken))) {
    throw new DpopError("oauth-dpop-failed");
  }
  const nonces = new Map<string, string>();
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const origin = new URL(request.url).origin;
    if (kind === "token" && request.method !== "POST") throw new DpopError("oauth-dpop-failed");
    const send = async (): Promise<Response> => {
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.set("DPoP", await key.proof(request.url, request.method, {
        nonce: nonces.get(origin), ...(kind === "resource" ? { accessToken } : {}),
      }));
      if (kind === "resource") headers.set("Authorization", `DPoP ${accessToken}`);
      request.signal.throwIfAborted();
      return fetchFn(new Request(request.clone(), { headers, redirect: "error" }));
    };
    const retainNonce = (response: Response): string | undefined => {
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce === null) return undefined;
      if (!NONCE_PATTERN.test(nonce)) throw new DpopError("oauth-dpop-failed");
      nonces.set(origin, nonce);
      return nonce;
    };
    let response = await send();
    const responseProofError = (candidate: Response): Promise<ProofError | undefined> => kind === "resource"
      ? Promise.resolve(candidate.status === 401 ? resourceProofError(candidate.headers.get("WWW-Authenticate")) : undefined)
      : tokenProofError(candidate);
    const error = await responseProofError(response);
    if (error === "invalid_dpop_proof") {
      await response.body?.cancel();
      throw new DpopError("oauth-dpop-failed");
    }
    if (error === "use_dpop_nonce") {
      let nonce: string | undefined;
      try { nonce = retainNonce(response); }
      finally { await response.body?.cancel(); }
      if (!nonce) throw new DpopError("oauth-dpop-failed");
      response = await send();
      if (await responseProofError(response)) {
        await response.body?.cancel();
        throw new DpopError("oauth-dpop-failed");
      }
    }
    if (response.ok) retainNonce(response);
    return response;
  }) as typeof fetch;
}
