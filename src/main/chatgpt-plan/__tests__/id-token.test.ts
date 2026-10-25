import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { CHATGPT_PLAN_JWKS_URL } from "../endpoints.js";
import { ChatGptPlanIdTokenVerifier } from "../id-token.js";

const NOW_SECONDS = 1_790_032_532;
const CLIENT_ID = "oaiapp_test";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let primary: KeyPair;
let rotated: KeyPair;
let primaryJwk: JWK;
let rotatedJwk: JWK;

beforeAll(async () => {
  primary = await generateKeyPair("RS256");
  rotated = await generateKeyPair("RS256");
  primaryJwk = { ...(await exportJWK(primary.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  rotatedJwk = { ...(await exportJWK(rotated.publicKey)), kid: "k2", alg: "RS256", use: "sig" };
});

async function idToken(overrides: {
  key?: KeyPair;
  kid?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  nonce?: string;
  sub?: string;
} = {}): Promise<string> {
  return new SignJWT({ nonce: overrides.nonce ?? "n1", email: "user@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "k1" })
    .setIssuer(overrides.iss ?? "https://auth.openai.com")
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(overrides.sub ?? "user-sub")
    .setIssuedAt(NOW_SECONDS - 10)
    .setExpirationTime(overrides.exp ?? NOW_SECONDS + 3600)
    .sign((overrides.key ?? primary).privateKey);
}

function jwksFetch(sets: JWK[][]): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const keys = sets[Math.min(urls.length - 1, sets.length - 1)]!;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, urls };
}

function verifier(sets: JWK[][], now = NOW_SECONDS * 1000) {
  const fetched = jwksFetch(sets);
  return { verifier: new ChatGptPlanIdTokenVerifier(fetched.fetch, () => now), urls: fetched.urls };
}

describe("plan-usage ID token validation", () => {
  it("accepts a token signed by a published key for this client and nonce", async () => {
    const { verifier: v, urls } = verifier([[primaryJwk]]);
    await expect(v.verify(await idToken(), { clientId: CLIENT_ID, nonce: "n1" })).resolves.toEqual({
      issuer: "https://auth.openai.com",
      subject: "user-sub",
      email: "user@example.com",
    });
    expect(urls).toEqual([CHATGPT_PLAN_JWKS_URL]);
  });

  it.each([
    ["signature", { key: "rotated-as-k1" }],
    ["issuer", { iss: "https://auth.example.com" }],
    ["audience", { aud: "oaiapp_other" }],
    ["expired", { exp: NOW_SECONDS - 60 }],
    ["nonce", { nonce: "n2" }],
  ] as const)("rejects a token with a bad %s", async (failure, override) => {
    const { verifier: v } = verifier([[primaryJwk]]);
    const token = "key" in override
      ? await idToken({ key: rotated, kid: "k1" })
      : await idToken(override as Parameters<typeof idToken>[0]);
    await expect(v.verify(token, { clientId: CLIENT_ID, nonce: "n1" })).rejects.toMatchObject({ failure });
  });

  it("refetches the key set once when a token names an unknown key", async () => {
    const { verifier: v, urls } = verifier([[primaryJwk], [primaryJwk, rotatedJwk]]);
    await v.verify(await idToken(), { clientId: CLIENT_ID, nonce: "n1" });
    await expect(v.verify(await idToken({ key: rotated, kid: "k2" }), { clientId: CLIENT_ID, nonce: "n1" }))
      .resolves.toMatchObject({ subject: "user-sub" });
    expect(urls).toHaveLength(2);
  });

  it("accepts only RS256, even from a key the issuer publishes", async () => {
    const ecKey = await generateKeyPair("ES256");
    const ecJwk: JWK = { ...(await exportJWK(ecKey.publicKey)), kid: "ec1", use: "sig" };
    const { verifier: v } = verifier([[primaryJwk, ecJwk]]);
    const token = await new SignJWT({ nonce: "n1" })
      .setProtectedHeader({ alg: "ES256", kid: "ec1" })
      .setIssuer("https://auth.openai.com")
      .setAudience(CLIENT_ID)
      .setSubject("user-sub")
      .setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 3600)
      .sign(ecKey.privateKey);
    await expect(v.verify(token, { clientId: CLIENT_ID, nonce: "n1" })).rejects.toMatchObject({ failure: "signature" });
  });

  it("requires the stored subject on a refreshed token", async () => {
    const { verifier: v } = verifier([[primaryJwk]]);
    await expect(v.verify(await idToken({ sub: "someone-else" }), { clientId: CLIENT_ID, subject: "user-sub" }))
      .rejects.toMatchObject({ failure: "subject" });
  });
});
