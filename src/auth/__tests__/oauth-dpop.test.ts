import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDpopFetch, DpopError, DpopKey, negotiateDpop } from "../oauth-dpop.js";

interface Proof {
  header: { typ: string; alg: string; jwk: webcrypto.JsonWebKey };
  payload: { jti: string; htm: string; htu: string; iat: number; nonce?: string; ath?: string };
  input: string;
  signature: Buffer;
}

function readProof(jwt: string): Proof {
  const [header, payload, signature] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    input: `${header}.${payload}`, signature: Buffer.from(signature, "base64url") };
}

function verifyProof(proof: Proof): boolean {
  return verify("sha256", Buffer.from(proof.input), {
    key: createPublicKey({ key: proof.header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, proof.signature);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function transport(...responses: Response[]): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  return { requests, fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch };
}

function requestProof(request: Request): Proof {
  const proof = request.headers.get("DPoP");
  if (!proof) throw new Error("Missing proof");
  return readProof(proof);
}

afterEach(() => vi.restoreAllMocks());

describe("proof credential keys", () => {
  it("signs independently verifiable ES256 proofs with only public key material", async () => {
    const key = await DpopKey.create();
    const proof = readProof(await key.proof("https://resource.example.test/mcp?secret=query#fragment", "post", {
      nonce: "server-nonce", accessToken: "access-token",
    }));
    expect(verifyProof(proof)).toBe(true);
    expect(proof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    expect(proof.header.jwk).not.toHaveProperty("d");
    expect(proof.payload).toMatchObject({ htm: "POST", htu: "https://resource.example.test/mcp", nonce: "server-nonce",
      ath: createHash("sha256").update("access-token").digest("base64url") });
    expect(proof.payload.iat).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 1);
    expect(proof.signature).toHaveLength(64);
    const another = readProof(await key.proof("https://resource.example.test/mcp", "POST"));
    expect(another.payload.jti).not.toBe(proof.payload.jti);
    expect(another.payload).not.toHaveProperty("nonce");
    expect(another.payload).not.toHaveProperty("ath");
  });

  it("uses a non-exportable private key for every live signing operation", async () => {
    const sign = webcrypto.subtle.sign.bind(webcrypto.subtle);
    const keys: webcrypto.CryptoKey[] = [];
    vi.spyOn(webcrypto.subtle, "sign").mockImplementation(async (algorithm, key, data) => {
      keys.push(key);
      return sign(algorithm, key, data);
    });
    const key = await DpopKey.create();
    await key.proof("https://issuer.example.test/token", "POST");
    await (await DpopKey.restore(key.serialize())).proof("https://issuer.example.test/token", "POST");
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const privateKey of keys) {
      expect(privateKey.extractable).toBe(false);
      await expect(webcrypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
    }
  });

  it("restores the same binding and keeps separate credentials independent", async () => {
    const key = await DpopKey.create();
    const restored = await DpopKey.restore(key.serialize());
    expect(await restored.thumbprint()).toBe(await key.thumbprint());
    expect(await (await DpopKey.create()).thumbprint()).not.toBe(await key.thumbprint());
    const proof = readProof(await restored.proof("https://issuer.example.test/token", "POST"));
    expect(verifyProof(proof)).toBe(true);
    const { crv, kty, x, y } = proof.header.jwk;
    expect(await key.thumbprint()).toBe(createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url"));
    expect(JSON.stringify(key)).toBe("{}");
  });

  it.each(["{}", "null", "malformed", '{"version":1,"pkcs8":"invalid","publicKey":{}}'])("rejects unreadable persistence without revealing its contents (%s)", async serialized => {
    await expect(DpopKey.restore(serialized)).rejects.toMatchObject({ code: "oauth-dpop-key-invalid", message: "Proof credential key cannot be read" });
  });

  it("rejects a public key that does not belong to the persisted private key", async () => {
    const one = JSON.parse((await DpopKey.create()).serialize());
    one.publicKey = JSON.parse((await DpopKey.create()).serialize()).publicKey;
    await expect(DpopKey.restore(JSON.stringify(one))).rejects.toMatchObject({ code: "oauth-dpop-key-invalid" });
  });

  it.each([
    ["http://issuer.example.test/token", "POST", {}],
    ["https://name:password@issuer.example.test/token", "POST", {}],
    ["https://issuer.example.test/token", "POST\r\n", {}],
    ["https://issuer.example.test/token", "POST", { nonce: 'bad"nonce' }],
    ["https://issuer.example.test/token", "POST", { accessToken: "bad token" }],
  ] as const)("rejects unsafe signing inputs", async (url, method, options) => {
    await expect((await DpopKey.create()).proof(url, method, options)).rejects.toBeInstanceOf(DpopError);
  });
});

describe("proof metadata negotiation", () => {
  it("retains bearer mode only when no capability is advertised or required", () => {
    expect(negotiateDpop({}, false)).toBe(false);
    expect(() => negotiateDpop({}, true)).toThrow("required proof algorithm");
    expect(negotiateDpop({ dpop_signing_alg_values_supported: ["ES256"] }, false)).toBe(true);
    expect(negotiateDpop({ dpop_signing_alg_values_supported: ["RS256", "ES256"] }, true)).toBe(true);
  });

  it.each([[], ["RS256"], ["none"], ["HS256"]].map(algorithms => ({ algorithms })))("never downgrades incompatible advertised algorithms ($algorithms)", ({ algorithms }) => {
    expect(() => negotiateDpop({ dpop_signing_alg_values_supported: algorithms }, false)).toThrow("required proof algorithm");
  });

  it.each([null, "ES256", [1], [""], {}].map(algorithms => ({ algorithms })))("rejects malformed capabilities ($algorithms)", ({ algorithms }) => {
    expect(() => negotiateDpop({ dpop_signing_alg_values_supported: algorithms }, false)).toThrow("Proof authorization failed");
  });
});

describe("proof token requests", () => {
  it("retries a nonce challenge once with fresh proof and the same request body", async () => {
    const wire = transport(json(400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": "as-nonce" }), json(200, { token_type: "DPoP" }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "token");
    expect((await fetch("https://issuer.example.test/token", { method: "POST", body: "grant_type=refresh_token&refresh_token=refresh-value",
      headers: { Authorization: "Basic client-auth" } })).status).toBe(200);
    expect(wire.requests).toHaveLength(2);
    const first = requestProof(wire.requests[0]);
    const second = requestProof(wire.requests[1]);
    expect(first.payload).not.toHaveProperty("nonce");
    expect(second.payload.nonce).toBe("as-nonce");
    expect(first.payload.jti).not.toBe(second.payload.jti);
    expect(second.payload).not.toHaveProperty("ath");
    expect(second.header.jwk).toEqual(first.header.jwk);
    expect(verifyProof(second)).toBe(true);
    for (const request of wire.requests) {
      expect(request.redirect).toBe("error");
      expect(request.headers.get("Authorization")).toBe("Basic client-auth");
      expect(await request.text()).toBe("grant_type=refresh_token&refresh_token=refresh-value");
    }
  });

  it("does not loop on a second nonce challenge", async () => {
    const wire = transport(json(400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": "one" }), json(400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": "two" }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "token");
    await expect(fetch("https://issuer.example.test/token", { method: "POST" })).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(2);
  });

  it.each(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "server_error"])("does not retry %s", async error => {
    const wire = transport(json(400, { error }, { "DPoP-Nonce": "unused" }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "token");
    expect((await fetch("https://issuer.example.test/token", { method: "POST" })).status).toBe(400);
    expect(wire.requests).toHaveLength(1);
  });

  it.each([undefined, 'bad"nonce', "bad\\nonce"])("rejects missing or malformed nonce challenges (%s)", async nonce => {
    const wire = transport(json(400, { error: "use_dpop_nonce" }, nonce === undefined ? {} : { "DPoP-Nonce": nonce }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "token");
    await expect(fetch("https://issuer.example.test/token", { method: "POST" })).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(1);
  });

  it("retains successful nonce rotation per origin", async () => {
    const wire = transport(json(200, {}, { "DPoP-Nonce": "one" }), json(200, {}, { "DPoP-Nonce": "two" }), json(200, {}), json(200, {}));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "token");
    await fetch("https://issuer.example.test/token", { method: "POST" });
    await fetch("https://issuer.example.test/token", { method: "POST" });
    await fetch("https://issuer.example.test/refresh", { method: "POST" });
    await fetch("https://other.example.test/token", { method: "POST" });
    expect(wire.requests.map(request => requestProof(request).payload.nonce)).toEqual([undefined, "one", "two", undefined]);
  });

  it("sanitizes malformed nonce error bodies", async () => {
    const wire = transport(new Response("secret-controlled-response", { status: 400 }));
    await expect(createDpopFetch(await DpopKey.create(), wire.fetch, "token")("https://issuer.example.test/token", { method: "POST" })).rejects.toMatchObject({ code: "oauth-dpop-failed", message: "Proof authorization failed" });
    expect(wire.requests).toHaveLength(1);
  });

  it("does not retry failed transport requests", async () => {
    const failure = vi.fn(async () => { throw new Error("Network unavailable"); });
    const fetch = createDpopFetch(await DpopKey.create(), failure as typeof globalThis.fetch, "token");
    await expect(fetch("https://issuer.example.test/token", { method: "POST" })).rejects.toThrow("Network unavailable");
    expect(failure).toHaveBeenCalledTimes(1);
  });
});

describe("proof resource requests", () => {
  it("binds the access token and retries only a matching resource nonce challenge", async () => {
    const wire = transport(json(401, {}, { "WWW-Authenticate": 'Bearer realm="legacy", DPoP realm="tools, resources", error="use_dpop_nonce"',
      "DPoP-Nonce": "resource-nonce" }), json(200, {}, { "DPoP-Nonce": "next-nonce" }), json(200, {}));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token");
    await fetch("https://resource.example.test/mcp?cursor=1", { method: "POST", body: "request body", headers: { Authorization: "Bearer forbidden" } });
    await fetch("https://resource.example.test/mcp", { method: "DELETE" });
    expect(wire.requests).toHaveLength(3);
    expect(wire.requests.map(request => requestProof(request).payload.nonce)).toEqual([undefined, "resource-nonce", "next-nonce"]);
    for (const request of wire.requests) {
      expect(request.headers.get("Authorization")).toBe("DPoP access-token");
      expect(requestProof(request).payload.ath).toBe(createHash("sha256").update("access-token").digest("base64url"));
      expect(verifyProof(requestProof(request))).toBe(true);
    }
    expect(await wire.requests[1].text()).toBe("request body");
  });

  it.each([
    [401, 'Bearer error="use_dpop_nonce"'],
    [401, 'DPoP error="invalid_token"'],
    [403, 'DPoP error="insufficient_scope"'],
    [400, 'DPoP error="use_dpop_nonce"'],
    [401, 'Bearer realm="DPoP error=use_dpop_nonce"'],
  ])("does not retry unrelated resource errors (%s %s)", async (status, challenge) => {
    const wire = transport(json(status, {}, { "WWW-Authenticate": challenge, "DPoP-Nonce": "unused" }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token");
    expect((await fetch("https://resource.example.test/mcp")).status).toBe(status);
    expect(wire.requests).toHaveLength(1);
  });

  it("does not share token and resource nonces even on the same origin", async () => {
    const key = await DpopKey.create();
    const tokenWire = transport(json(200, {}, { "DPoP-Nonce": "token-only" }));
    const resourceWire = transport(json(200, {}));
    await createDpopFetch(key, tokenWire.fetch, "token")("https://issuer.example.test/token", { method: "POST" });
    await createDpopFetch(key, resourceWire.fetch, "resource", "access-token")("https://issuer.example.test/mcp");
    expect(requestProof(resourceWire.requests[0]).payload).not.toHaveProperty("nonce");
  });

  it("preserves case-sensitive extension method spelling", async () => {
    const wire = transport(json(200, {}));
    await createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token")("https://resource.example.test/mcp", { method: "CUSTOMmethod" });
    expect(requestProof(wire.requests[0]).payload.htm).toBe("CUSTOMmethod");
  });

  it("stops after one resource nonce retry", async () => {
    const response = () => json(401, {}, { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "nonce" });
    const wire = transport(response(), response());
    await expect(createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token")("https://resource.example.test/mcp")).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(2);
  });

  it("rejects resource nonce challenges without a nonce", async () => {
    const wire = transport(json(401, {}, { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' }));
    await expect(createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token")("https://resource.example.test/mcp")).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(1);
  });

  it("requires a valid access token before resource egress", async () => {
    const key = await DpopKey.create();
    const wire = transport();
    expect(() => createDpopFetch(key, wire.fetch, "resource")).toThrow("Proof authorization failed");
    expect(() => createDpopFetch(key, wire.fetch, "resource", "invalid token")).toThrow("Proof authorization failed");
    expect(wire.requests).toHaveLength(0);
  });

  it("honors caller cancellation before egress", async () => {
    const controller = new AbortController();
    controller.abort();
    const wire = transport();
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, "resource", "access-token");
    await expect(fetch("https://resource.example.test/mcp", { signal: controller.signal })).rejects.toThrow();
    expect(wire.requests).toHaveLength(0);
  });
});

describe("terminal proof validation failures", () => {
  it.each(["token", "resource"] as const)("refuses invalid_dpop_proof without exposing a refresh recovery path (%s)", async kind => {
    const wire = transport(kind === "token" ? json(400, { error: "invalid_dpop_proof" }) : json(401, {}, { "WWW-Authenticate": 'DPoP error="invalid_dpop_proof"' }));
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, kind, kind === "resource" ? "access-token" : undefined);
    await expect(fetch("https://issuer.example.test/endpoint", { method: "POST" })).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(1);
  });

  it.each(["token", "resource"] as const)("refuses invalid_dpop_proof following a nonce retry (%s)", async kind => {
    const first = kind === "token" ? json(400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": "one" }) : json(401, {}, { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "one" });
    const second = kind === "token" ? json(400, { error: "invalid_dpop_proof" }) : json(401, {}, { "WWW-Authenticate": 'DPoP error="invalid_dpop_proof"' });
    const wire = transport(first, second);
    const fetch = createDpopFetch(await DpopKey.create(), wire.fetch, kind, kind === "resource" ? "access-token" : undefined);
    await expect(fetch("https://issuer.example.test/endpoint", { method: "POST" })).rejects.toMatchObject({ code: "oauth-dpop-failed" });
    expect(wire.requests).toHaveLength(2);
  });
});
