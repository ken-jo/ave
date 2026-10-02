/**
 * Sprint E §3 — redactForLLM pattern coverage (email / phone / CC).
 * Also covers redactFsPath + redactAuditPayload (audit log PII redact, #449).
 */
import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  initDlpAudit,
  redactAuditPayload,
  redactForLLM,
  redactFsPath,
  redactHomePathsInText,
  scrubSecretsForLLM,
} from "../dlp-filter.js";
import { scrubDiagnosticSecrets, scrubDiagnosticSecretsStrict } from "../../shared/dlp.js";
import { fixtureSecret } from "./secret-fixtures.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../shared/__tests__/fixtures/diagnostic-secret-probes.js";

describe("redactForLLM", () => {
  it("redacts emails", () => {
    const r = redactForLLM("ping me at foo.bar+baz@example.com please");
    expect(r.redacted).toContain("[REDACTED:EMAIL]");
    expect(r.redacted).not.toContain("foo.bar+baz@example.com");
    expect(r.counts.EMAIL).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("redacts Korean mobile phone numbers (with and without hyphens)", () => {
    const r1 = redactForLLM("내 번호 010-1234-5678");
    expect(r1.redacted).toContain("[REDACTED:PHONE]");
    expect(r1.counts.PHONE_KR).toBe(1);
    const r2 = redactForLLM("01098765432");
    expect(r2.redacted).toContain("[REDACTED:PHONE]");
    expect(r2.counts.PHONE_KR).toBe(1);
  });

  it("redacts US phone numbers", () => {
    const r = redactForLLM("Call 415-555-1234 or (415) 555-9876");
    expect(r.counts.PHONE_US).toBe(2);
    expect(r.redacted).not.toMatch(/415-555-1234/);
  });

  it("redacts credit card numbers that pass Luhn, preserves fakes", () => {
    // Visa test number 4111111111111111 passes Luhn
    const r = redactForLLM("card 4111 1111 1111 1111 vs 1234 5678 9012 3456");
    expect(r.counts.CREDIT_CARD).toBe(1);
    expect(r.redacted).toContain("[REDACTED:CC]");
    expect(r.redacted).toContain("1234 5678 9012 3456");
  });

  it("redacts Korean SSN (RRN)", () => {
    const r = redactForLLM("주민번호 900101-1234567 입니다");
    expect(r.counts.SSN_KR).toBe(1);
    expect(r.redacted).toContain("[REDACTED:SSN]");
  });

  it("returns zero counts on clean text", () => {
    const r = redactForLLM("안녕하세요, Ave 입니다.");
    expect(r.totalCount).toBe(0);
    expect(r.redacted).toBe("안녕하세요, Ave 입니다.");
  });

  it("attributes audit rows to the session resolved at each redaction", () => {
    const auditSessionIds: string[] = [];
    let currentSessionId = "session-before-transition";
    initDlpAudit(
      { log: ({ sessionId }) => auditSessionIds.push(sessionId) },
      () => currentSessionId,
    );
    try {
      redactForLLM("first@example.com");
      currentSessionId = "session-after-transition";
      redactForLLM("second@example.com");

      expect(auditSessionIds).toEqual([
        "session-before-transition",
        "session-after-transition",
      ]);
    } finally {
      // DLP audit state is module-global; do not leak this test sink to other files.
      initDlpAudit(null, "unknown");
    }
  });
});

describe("scrubDiagnosticSecrets — token shapes, not prefixes (design §18.8)", () => {
  // Real token lengths and charsets, assembled here so no whole token sits in the source.
  const mixed = (length: number) => "A1b2C3d4E5f6G7h8".repeat(Math.ceil(length / 16)).slice(0, length);
  const TOKENS: ReadonlyArray<readonly [string, string]> = [
    ["GitHub classic", fixtureSecret("gh", "p_", mixed(36))],
    ["GitHub OAuth", fixtureSecret("gh", "o_", mixed(36))],
    ["GitHub fine-grained", fixtureSecret("github", "_pat_", mixed(22), "_", mixed(59))],
    ["Slack bot", fixtureSecret("xo", "xb-", "123456789012-123456789012-", mixed(24))],
    ["Slack app", fixtureSecret("xa", "pp-", "1-A0123ABC-1234567890123-", mixed(32))],
    ["AWS key id", fixtureSecret("AK", "IA", "IOSFODNN7EXAMPL3")],
    ["Google API key", fixtureSecret("AI", "za", mixed(35))],
    ["OpenAI", fixtureSecret("sk", "-", mixed(48))],
    ["OpenAI project", fixtureSecret("sk", "-proj-", mixed(64), "_", mixed(40))],
    ["Anthropic", fixtureSecret("sk", "-ant-api03-", mixed(93), "AA")],
  ];

  it.each(TOKENS)("masks a %s token in a host, a path, an id and a URL", (_kind, token) => {
    for (const text of [
      `${token}.example.com`,
      `${token.toLowerCase()}.example.com`,
      `/srv/markets/${token}/plugins`,
      `C:\\work\\${token}\\market`,
      `market-${token}`,
      `https://example.com/acme/${token}/market.git`,
      `ssh://git@${token.toLowerCase()}.example/acme/market`,
    ]) {
      const scrubbed = scrubDiagnosticSecrets(text);
      expect(scrubbed, text).not.toContain(token);
      expect(scrubbed.toLowerCase(), text).not.toContain(token.toLowerCase());
      expect(scrubbed).toContain("[REDACTED:");
    }
  });

  it("masks a JSON Web Token in a path and a URL", () => {
    const jwt = fixtureSecret("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", mixed(43));
    for (const text of [`/srv/${jwt}/x`, `https://example.com/cb?state=${jwt}`]) expect(scrubDiagnosticSecrets(text)).not.toContain(jwt);
  });

  it.each([
    // Hosts.
    "test-server01.corp.example",
    "live-db-replica-0001.internal",
    "proj-alpha.example.com",
    "sk-learn.example.org",
    "aizawa-shop-production-europe-west1.example",
    "akiaprojectserverab.example",
    "xapp-launcher.example.com",
    // Package names and source ids.
    "live-captions",
    "sk-learn-utils",
    "test-runner",
    "pk-tools",
    "rk-deploy-helper",
    "proj-template-react",
    "test-marketplace",
    "live-feed-2024",
    // Paths and addresses.
    "/Users/example/test-fixtures01/market",
    "C:\\work\\live-dashboard-2024\\plugins",
    "/opt/sk-learn-utils/v2",
    "ssh://git@github.com/acme/market",
    "https://github.com/acme/live-captions",
    // Hashes.
    "0123456789abcdef0123456789abcdef01234567",
    "local-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ])("keeps %s as it is", (text) => {
    expect(scrubDiagnosticSecrets(text)).toBe(text);
  });

  it("leaves the model-bound scrubber's broad prefix rule as it was", () => {
    // Text bound for a model masks a name by mistake rather than miss a key.
    expect(scrubSecretsForLLM("endpoint live-captions-service")).toContain("[REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("host test-server01.corp")).toContain("[REDACTED:TOKEN]");
  });
});

describe("scrubSecretsForLLM — credential-class SOT (#1499 E2 M1)", () => {
  it("redacts prefixed API keys (sk-/pk-/live-)", () => {
    expect(scrubSecretsForLLM("key sk-ant-ABCDEFGH1234")).not.toContain("sk-ant-ABCDEFGH1234");
    expect(scrubSecretsForLLM("key sk-ant-ABCDEFGH1234")).toContain("[REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("key SK-ANT-ABCDEFGH1234")).not.toContain("SK-ANT-ABCDEFGH1234");
  });

  it("redacts GitHub and Slack vendor-prefixed tokens case-insensitively", () => {
    const githubPat = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    const githubOauth = fixtureSecret("GH", "O_", "1234567890ABCDEFGHIJKLMNOPQRSTUV");
    const githubUser = fixtureSecret("gh", "u_", "1234567890abcdefghijklmnopqrstuv");
    const githubServer = fixtureSecret("gh", "s_", "1234567890abcdefghijklmnopqrstuv");
    const githubRefresh = fixtureSecret("gh", "r_", "1234567890abcdefghijklmnopqrstuv");
    const githubFineGrained = fixtureSecret("github", "_pat_", "1234567890abcdefghijklmnopqrstuv_1234567890");
    const slackBot = fixtureSecret("xo", "xb-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const slackUser = fixtureSecret("XO", "XP-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const slackApp = fixtureSecret("xa", "pp-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const out = scrubSecretsForLLM(
      `tokens ${githubPat} ${githubOauth} ${githubUser} ${githubServer} ${githubRefresh} ${githubFineGrained} ${slackBot} ${slackUser} ${slackApp}`,
    );

    expect(out).not.toContain(githubPat);
    expect(out).not.toContain(githubOauth);
    expect(out).not.toContain(githubUser);
    expect(out).not.toContain(githubServer);
    expect(out).not.toContain(githubRefresh);
    expect(out).not.toContain(githubFineGrained);
    expect(out).not.toContain(slackBot);
    expect(out).not.toContain(slackUser);
    expect(out).not.toContain(slackApp);
    expect(out.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(9);
  });

  it("redacts AWS and Google vendor-prefixed tokens", () => {
    const awsAccessKeyId = fixtureSecret("AK", "IA", "1234567890ABCDEF");
    const awsSecret = fixtureSecret("wJalrXUtn", "FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    const labeledAwsSecret = fixtureSecret("WJalrXUtn", "FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    const googleApiKey = fixtureSecret("AI", "za", "SyD1234567890abcdefghijklmnopqrstu");
    const out = scrubSecretsForLLM(
      `aws ${awsAccessKeyId} ${awsSecret} AWS_SECRET_ACCESS_KEY=${labeledAwsSecret} google ${googleApiKey}`,
    );

    expect(out).not.toContain(awsAccessKeyId);
    expect(out).not.toContain(awsSecret);
    expect(out).not.toContain(labeledAwsSecret);
    expect(out).not.toContain(googleApiKey);
    expect(out.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(4);

    const paddedSecret = "A".repeat(39) + "=";
    const paddedOut = scrubSecretsForLLM(`aws ${awsAccessKeyId} ${paddedSecret}`);
    expect(paddedOut).not.toContain(paddedSecret);
    expect(paddedOut.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(2);
  });

  it("redacts bearer tokens and auth headers", () => {
    expect(scrubSecretsForLLM("Bearer abcXYZ12345token")).not.toContain("abcXYZ12345token");
    expect(scrubSecretsForLLM("BEARER abcXYZ12345token")).toBe("Bearer [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("Authorization: Bearer abcXYZ12345token")).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("Authorization: Bearer [REDACTED:TOKEN] status=200")).toBe(
      "Authorization: Bearer [REDACTED:TOKEN] status=200",
    );
    expect(scrubSecretsForLLM("x-api-key: myheaderSECRET99")).not.toContain("myheaderSECRET99");
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42")).not.toContain("rawSecretHeader42");
    const basicSecret = fixtureSecret("Basic ", "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(scrubSecretsForLLM(`Authorization: ${basicSecret}`)).toBe("Authorization: [REDACTED:TOKEN]");
    const embedded = scrubSecretsForLLM(`{"level":30,"msg":"Authorization: ${basicSecret}","status":200}`);
    expect(embedded).not.toContain(basicSecret);
    expect(embedded).toContain("Authorization: [REDACTED:TOKEN]");
    expect(embedded).toContain('"status":200');
    const digest = scrubSecretsForLLM('Authorization: Digest username="user", response="secret-response-token" status=200');
    expect(digest).not.toContain('username="user"');
    expect(digest).not.toContain('response="secret-response-token"');
    expect(digest).toBe("Authorization: [REDACTED:TOKEN] status=200");
    const embeddedDigest = scrubSecretsForLLM(
      '{"level":30,"msg":"Authorization: Digest username=\\"user\\", response=\\"secret-response-token\\"","status":200}',
    );
    expect(embeddedDigest).not.toContain('response=\\"secret-response-token\\"');
    expect(embeddedDigest).toContain("Authorization: [REDACTED:TOKEN]");
    expect(embeddedDigest).toContain('","status":200');
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42 status=200")).toBe(
      "Authorization: [REDACTED:TOKEN] status=200",
    );
    expect(scrubSecretsForLLM("x-api-key: myheaderSECRET99 status=200")).toBe("x-api-key: [REDACTED:TOKEN] status=200");
    expect(scrubSecretsForLLM("x-auth-token: rawHeaderToken42 status=200")).toBe(
      "x-auth-token: [REDACTED:TOKEN] status=200",
    );
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(scrubSecretsForLLM(`token ${jwt}`)).not.toContain(jwt);
    expect(scrubSecretsForLLM(`token ${jwt}`)).toContain("[REDACTED:JWT]");
  });

  it("redacts token/api_key query params", () => {
    const out = scrubSecretsForLLM("https://x.example/mcp?api_key=SECRETVALUE123&x=1");
    expect(out).not.toContain("SECRETVALUE123");
  });

  it("does NOT slice — a secret late in a long line is still caught", () => {
    // The mcp-client scrubSecrets 120-char slice previously masked this class of
    // gap. The slice-free SOT must catch a token after 200 chars.
    const line = "x".repeat(200) + " Bearer LATElineSECRETtoken777";
    const out = scrubSecretsForLLM(line);
    expect(out).not.toContain("LATElineSECRETtoken777");
    expect(out.length).toBeGreaterThan(120); // whole line preserved, not truncated
  });

  it("does not redact unprefixed high-entropy hashes without credential context", () => {
    // #1511 reviewed bare high-entropy heuristics. Redacting every 40-hex or
    // base64-ish blob would mask common commit SHAs and artifact hashes in
    // diagnostic bundles, so the scrubber stays prefix/context driven.
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const base64Blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo1234567890";
    const out = scrubSecretsForLLM(`commit ${commitSha} artifact ${base64Blob}`);

    expect(out).toContain(commitSha);
    expect(out).toContain(base64Blob);
  });
});

describe("scrubDiagnosticSecrets — marketplace diagnostics behind Copy details", () => {
  it("redacts a password in any scheme's userinfo, up to the authority's last @", () => {
    const out = scrubDiagnosticSecrets(
      "fatal: unable to access 'https://alice:verifier-secret@example.com/owner/repo/'; ssh://deploy:hunter2@git.example/x; https://a:p@ss@host/y",
    );
    expect(out).not.toMatch(/verifier-secret|hunter2|p@ss/u);
    expect(out).toContain("https://[REDACTED:CREDENTIALS]@example.com/owner/repo/");
    expect(out).toContain("ssh://[REDACTED:CREDENTIALS]@git.example/x");
  });

  it("redacts a lone http(s) user name, which is a token, and keeps an ssh account name", () => {
    const token = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    expect(scrubDiagnosticSecrets(`https://${token}@github.com/acme/tools`)).toBe("https://[REDACTED:CREDENTIALS]@github.com/acme/tools");
    expect(scrubDiagnosticSecrets("ssh://git@github.com/acme/tools")).toBe("ssh://git@github.com/acme/tools");
  });

  it("treats a scheme over http(s) like http(s), and redacts encoded or scheme-less passwords, keeping ssh account names", () => {
    const token = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    expect(scrubDiagnosticSecrets(`pip install git+https://${token}@github.com/acme/tools`)).toBe("pip install git+https://[REDACTED:CREDENTIALS]@github.com/acme/tools");
    expect(scrubDiagnosticSecrets("svn+http://deploy@svn.example/x")).toBe("svn+http://[REDACTED:CREDENTIALS]@svn.example/x");
    expect(scrubDiagnosticSecrets("ssh://alice%3Averifier-secret@git.example/x")).toBe("ssh://[REDACTED:CREDENTIALS]@git.example/x");
    expect(scrubDiagnosticSecrets("ssh://alice%40corp@git.example/x")).toBe("ssh://[REDACTED:CREDENTIALS]@git.example/x");
    expect(scrubDiagnosticSecrets("ssh://alice%3averifier-secret@git.example/x")).toBe("ssh://[REDACTED:CREDENTIALS]@git.example/x");
    expect(scrubDiagnosticSecrets("ssh://alice%ZZverifier-secret@git.example/x")).toBe("ssh://[REDACTED:CREDENTIALS]@git.example/x");
    expect(scrubDiagnosticSecrets("ssh://%67it@git.example/x")).toBe("ssh://%67it@git.example/x");
    expect(scrubDiagnosticSecrets("alice:verifier-secret@github.com:acme/tools")).toBe("[REDACTED:CREDENTIALS]@github.com:acme/tools");
    const kept = "ssh://deploy-bot.1@git.example:2222/x, git@github.com:acme/tools, Host key for [git.example]:2222 has changed";
    expect(scrubDiagnosticSecrets(kept)).toBe(kept);
  });

  it("redacts a quoted secret inside a line up to its closing quote", () => {
    expect(scrubDiagnosticSecrets('helper failed: token="canarypass"; retry')).toBe("helper failed: token=[REDACTED:TOKEN]; retry");
    expect(scrubDiagnosticSecrets("helper failed: secret='canary pass' then")).toBe("helper failed: secret=[REDACTED:TOKEN] then");
    expect(scrubDiagnosticSecrets('askpass: password = "canary never closed')).toBe("askpass: password = [REDACTED:TOKEN]");
  });

  it.each(DIAGNOSTIC_SECRET_PROBES)("redacts the $id spelling", ({ text, secret, kept }) => {
    expect(scrubDiagnosticSecrets(text)).not.toContain(secret);
    if (kept !== undefined) expect(scrubDiagnosticSecrets(text)).toContain(kept);
  });

  it.each(DIAGNOSTIC_KEPT)("keeps %s", (text) => {
    expect(scrubDiagnosticSecrets(text)).toBe(text);
  });

  it("judges scp-form userinfo as an ssh:// one: decoded, an account name kept, anything else redacted", () => {
    for (const userinfo of ["user:canarypass", "user%3Acanarypass", "user%3acanarypass", "user%40canarypass", "user%ZZcanarypass"]) {
      expect(scrubDiagnosticSecrets(`${userinfo}@host:org/repo`)).toBe("[REDACTED:CREDENTIALS]@host:org/repo");
      expect(scrubDiagnosticSecrets(`ssh://${userinfo}@host/org/repo`)).toBe("ssh://[REDACTED:CREDENTIALS]@host/org/repo");
    }
  });

  it("reads a quoted value through its escapes, after = or a JSON colon, up to the closing quote or the text's end", () => {
    expect(scrubDiagnosticSecrets('helper: token="prefix\\"canarypass"; retry')).toBe("helper: token=[REDACTED:TOKEN]; retry");
    expect(scrubDiagnosticSecrets("helper: token='prefix\\'canarypass' then")).toBe("helper: token=[REDACTED:TOKEN] then");
    expect(scrubDiagnosticSecrets('{"token": "prefix\\"canarypass", "api_key":"canarypass","n":1}')).toBe('{"token": [REDACTED:TOKEN], "api_key":[REDACTED:TOKEN],"n":1}');
    expect(scrubDiagnosticSecrets('helper: token="prefix\\"canarypass\nnext line')).toBe("helper: token=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("token:\nnext line")).toBe("token:\nnext line");
  });

  it("reads a quoted key whole, a separator inside it included", () => {
    expect(scrubDiagnosticSecrets('{"prefix:token":"canarypass","n":"1"}')).toBe('{"prefix:token":[REDACTED:TOKEN],"n":"1"}');
    expect(scrubDiagnosticSecrets(`x: "a=token" = canarypass; 'x:password': 'canarypass' then`)).toBe(`x: "a=token" = [REDACTED:TOKEN] 'x:password': [REDACTED:TOKEN] then`);
    expect(scrubDiagnosticSecrets('{"a:b":"kept","token":"canarypass"}')).toBe('{"a:b":"kept","token":[REDACTED:TOKEN]}');
    // A quoted string that no separator follows is text: an assignment inside it is still read.
    expect(scrubDiagnosticSecrets(`msg "token=canarypass" sent; it's fine`)).toBe(`msg "token=[REDACTED:TOKEN] sent; it's fine`);
  });

  it("keeps the scanner's invariant on ordinary JSON, and on its own output", () => {
    for (const text of ['{"host":"::1","port":443}', '{"op":"=","value":3}', '"a":":x"', `x "a 'b "c": 1' : 2" : 3`]) {
      expect(scrubDiagnosticSecretsStrict(text)).toBe(text);
    }
    expect(scrubDiagnosticSecretsStrict('{"password":"=hunter2"}')).toBe('{"password":[REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecretsStrict('{" --token ": "x"}')).toBe('{" --token ": [REDACTED:TOKEN]}');
    // `token":` names a token although its opening quote went unrecognized.
    const once = scrubDiagnosticSecretsStrict('msg: "a":token":"canarypass"');
    expect(once).toBe('msg: "a":token":[REDACTED:TOKEN]');
    expect(scrubDiagnosticSecretsStrict(once)).toBe(once);
  });

  it("fails closed: a scrubber that breaks its own contract hides the whole text, and logs only its length", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = breakDiagnosticScrubberOn("canarysentinel");
    try {
      expect(() => scrubDiagnosticSecretsStrict("token=canarysentinel")).toThrow("injected diagnostic scrubber failure");
      expect(scrubDiagnosticSecrets("token=canarysentinel")).toBe("[REDACTED:DIAGNOSTIC]");
    } finally {
      restore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("(20 chars)");
    expect(String(warn.mock.calls[0]![0])).not.toContain("canarysentinel");
    warn.mockRestore();
  });

  it("never throws for a caller that passes no string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(scrubDiagnosticSecrets(undefined as unknown as string)).toBe("[REDACTED:DIAGNOSTIC]");
    expect(scrubDiagnosticSecrets(null as unknown as string)).toBe("[REDACTED:DIAGNOSTIC]");
    expect(String(warn.mock.calls[0]![0])).toContain("(undefined)");
    expect(String(warn.mock.calls[1]![0])).toContain("(object)");
    warn.mockRestore();
  });

  it("redacts an Authorization value quoted or after `=`, through the credentials after its scheme", () => {
    expect(scrubDiagnosticSecrets('Authorization: "Basic dXNlcjpwYXNz" next')).toBe("Authorization: [REDACTED:TOKEN] next");
    expect(scrubDiagnosticSecrets("authorization='Basic dXNlcjpwYXNz' next")).toBe("authorization=[REDACTED:TOKEN] next");
    expect(scrubDiagnosticSecrets("x: Authorization=Basic dXNlcjpwYXNz next\nkept")).toBe("x: Authorization=[REDACTED:TOKEN]\nkept");
    // Opening a line with `=`, it is a credential-protocol line, redacted to the line's end.
    expect(scrubDiagnosticSecrets("Authorization=Basic dXNlcjpwYXNz next\nkept")).toBe("Authorization=[REDACTED:TOKEN]\nkept");
    expect(scrubDiagnosticSecrets("x: token=Negotiate YIIabc next")).toBe("x: token=[REDACTED:TOKEN] next");
    expect(scrubDiagnosticSecrets("x: password=basic next")).toBe("x: password=[REDACTED:TOKEN]");
    // An Authorization header's scheme takes the rest of its line; another key's, the next word only.
    expect(scrubDiagnosticSecrets('x: Authorization: Digest username="u", realm="r", nonce="n", uri="/", response="6629fae4"\nnext')).toBe("x: Authorization: [REDACTED:TOKEN]\nnext");
    expect(scrubDiagnosticSecrets('Proxy-Authorization: Digest username="u", response="6629fae4"')).toBe("Proxy-Authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: Authorization: Bearer abc def\nkept")).toBe("x: Authorization: [REDACTED:TOKEN]\nkept");
    expect(scrubDiagnosticSecrets("helper --authorization Bearer abc def")).toBe("helper --authorization [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: token=Basic abc def")).toBe("x: token=[REDACTED:TOKEN] def");
    expect(scrubDiagnosticSecrets('x: authorization: "Basic abc" kept')).toBe("x: authorization: [REDACTED:TOKEN] kept");
    // Accepted: a key holding `authorization` takes its value even when it is not a secret.
    expect(scrubDiagnosticSecrets("x: authorization_url=https://idp.example/x kept")).toBe("x: authorization_url=[REDACTED:TOKEN] kept");
  });

  it("reads JSON carried in a JSON string inside a key, and past a stray \\\" earlier on the line", () => {
    expect(scrubDiagnosticSecrets('"{\\"token\\": \\"canarypass\\"}": 1')).toBe('"{\\"token\\": [REDACTED:TOKEN]}": [REDACTED:TOKEN]');
    expect(scrubDiagnosticSecrets('\n "{\\"token\\": \\"canarypass\\"}"\n\n=')).toBe('\n "{\\"token\\": [REDACTED:TOKEN]}"\n\n=');
    expect(scrubDiagnosticSecrets('path C:\\"dir x \\"token\\": \\"canarypass\\" end')).toBe('path C:\\"dir x \\"token\\": [REDACTED:TOKEN] end');
  });

  it("reads JSON carried in a JSON string, one level of \\\" deep", () => {
    expect(scrubDiagnosticSecrets('HTTP 401 body: "{\\"token\\":\\"canarypass\\",\\"n\\":\\"1\\"}"')).toBe('HTTP 401 body: "{\\"token\\":[REDACTED:TOKEN],\\"n\\":\\"1\\"}"');
    expect(scrubDiagnosticSecrets('{\\"password\\": \\"canarypass\\"}')).toBe('{\\"password\\": [REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecrets('{"body":"{\\"token\\":\\"canarypass\\"}"}')).toBe('{"body":"{\\"token\\":[REDACTED:TOKEN]}"}');
    expect(scrubDiagnosticSecrets('{\\"to\\\\u006ben\\":\\"canarypass\\"}')).toBe('{\\"to\\\\u006ben\\":[REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecrets('{\\"token\\":\\"a\\\\\\"canarypass\\"}')).toBe('{\\"token\\":[REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecrets('{\\"token\\": \\"canarypass')).toBe('{\\"token\\": [REDACTED:TOKEN]');
    expect(scrubDiagnosticSecrets('{\\"n\\":\\"kept\\"}')).toBe('{\\"n\\":\\"kept\\"}');
  });

  it("over-redacts a value that crosses a line rather than let it swallow the next key", () => {
    expect(scrubDiagnosticSecrets('token:"\n"GH_TOKEN": "canarypass"')).toBe("token:[REDACTED:TOKEN]");
    // `\d` does not decode, so the key fails closed, and its value on the next line takes that line.
    expect(scrubDiagnosticSecrets('"C:\\dir":\ntoken: canarypass\nnext')).toBe('"C:\\dir":\n[REDACTED:TOKEN]\nnext');
    // A value that a separator follows was the next key: its value goes too.
    expect(scrubDiagnosticSecrets('"token":\n\n"api_key"\n: "canarypass", "n": "1"')).toBe('"token":\n\n[REDACTED:TOKEN]\n: [REDACTED:TOKEN], "n": "1"');
  });

  it("treats a key of markers alone as a credential's, and skips only a value that is exactly a marker", () => {
    expect(scrubDiagnosticSecrets('{"[REDACTED:TOKEN]": "canarypass"}')).toBe('{"[REDACTED:TOKEN]": [REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecrets("helper: token=[REDACTED:TOKEN]canarypass")).toBe("helper: token=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("helper: token=[REDACTED:TOKEN] kept")).toBe("helper: token=[REDACTED:TOKEN] kept");
    expect(scrubDiagnosticSecrets("helper: token=[REDACTED-ish]canarypass")).toBe("helper: token=[REDACTED:TOKEN]");
  });

  it("takes JSON whitespace around a quoted key's separator, and only blanks after a bare key", () => {
    expect(scrubDiagnosticSecrets('{"password"\n: "canarypass", "n": "1"}')).toBe('{"password"\n: [REDACTED:TOKEN], "n": "1"}');
    // A value that starts on a later line takes that whole line.
    expect(scrubDiagnosticSecrets('{"password":\r\n  "canarypass"}')).toBe('{"password":\r\n  [REDACTED:TOKEN]');
    expect(scrubDiagnosticSecrets("prose ends with token:\nnext line")).toBe("prose ends with token:\nnext line");
  });

  it("never reads a redaction marker as key material, and redacts an assignment inside a quoted key", () => {
    expect(scrubDiagnosticSecrets("fatal: unable to access 'https://alice:canarypass@host/repo': 401")).toBe("fatal: unable to access 'https://[REDACTED:CREDENTIALS]@host/repo': 401");
    expect(scrubDiagnosticSecrets("remote: 'see docs': 403")).toBe("remote: 'see docs': 403");
    // A key naming a credential takes its value, here a status: over-redaction is the safe side.
    expect(scrubDiagnosticSecrets("remote: 'api token' : 403")).toBe("remote: 'api token' : [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("remote: 'token=canarypass' : 403")).toBe("remote: 'token=[REDACTED:TOKEN]' : [REDACTED:TOKEN]");
  });

  it("ends a value read inside a quoted key at the key's closing quote, so the key's own value is still redacted", () => {
    expect(scrubDiagnosticSecrets('{"token:label": "canarypass", "n": "1"}')).toBe('{"token:[REDACTED:TOKEN]": [REDACTED:TOKEN], "n": "1"}');
    expect(scrubDiagnosticSecrets("{'password=a b': 'canarypass'}")).toBe("{'password=[REDACTED:TOKEN] b': [REDACTED:TOKEN]}");
    expect(scrubDiagnosticSecrets(`{"token='a b' c": "canarypass"}`)).toBe(`{"token=[REDACTED:TOKEN] c": [REDACTED:TOKEN]}`);
    expect(scrubDiagnosticSecrets('{"token: ": "canarypass"}')).toBe('{"token: ": [REDACTED:TOKEN]}');
  });

  it("runs a credential's bare value to whitespace, punctuation included, wherever the key stands", () => {
    expect(scrubDiagnosticSecrets("helper: password=prefix;canarypass")).toBe("helper: password=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("helper: password=a,b c")).toBe("helper: password=[REDACTED:TOKEN] c");
    expect(scrubDiagnosticSecrets("helper: token=x&y then")).toBe("helper: token=[REDACTED:TOKEN] then");
    expect(scrubDiagnosticSecrets("helper: host=a,b c")).toBe("helper: host=a,b c");
  });

  it("decodes a quoted key before judging it, and fails closed when it does not decode", () => {
    expect(scrubDiagnosticSecrets('{"to\\u006ben":"canarypass","n":"1"}')).toBe('{"to\\u006ben":[REDACTED:TOKEN],"n":"1"}');
    expect(scrubDiagnosticSecrets('{"to\\qken":"canarypass","n":"1"}')).toBe('{"to\\qken":[REDACTED:TOKEN],"n":"1"}');
    expect(scrubDiagnosticSecrets('{"n\\u0061me":"kept"}')).toBe('{"n\\u0061me":"kept"}');
  });

  it("redacts a quoted value that crosses a line unclosed to the end of the text", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\r\nMIIEcanarypass\r\n-----END PRIVATE KEY-----";
    expect(scrubDiagnosticSecrets(`config: private_key="${pem}"\r\nhost=git.example`)).toBe("config: private_key=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: token='a\nb' then\nnext")).toBe("x: token=[REDACTED:TOKEN]");
    // An escape never carries a value past its line's end.
    expect(scrubDiagnosticSecrets('apikey="\\\n GH_TOKEN="canarypass"')).toBe("apikey=[REDACTED:TOKEN]");
  });

  it("redacts the value of a long credential flag, and leaves a short one", () => {
    expect(scrubDiagnosticSecrets("helper --password canarypass --api-key=other --verbose --depth 1")).toBe("helper --password [REDACTED:TOKEN] --api-key=[REDACTED:TOKEN] --verbose --depth 1");
    expect(scrubDiagnosticSecrets("helper --token --verbose")).toBe("helper --token --verbose");
    // A limitation: `-p` says nothing of what it takes.
    expect(scrubDiagnosticSecrets("mysql -p canarypass")).toBe("mysql -p canarypass");
  });

  it("scrubs 64 KiB of adversarial text in linear time", () => {
    const size = 64 * 1024;
    const fill = (unit: string, tail = "") => unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;
    const inputs = [
      fill("token", "!"), fill("token", "="), fill("a."), fill("a.", "://x@y"), fill("a@"), fill(" a@"), fill("a:b@"), fill("%"),
      `token="${fill("\\")}`, fill('token="a'), fill("token='a"), `'${fill("\\")}':`, fill('\\"'),
      fill("a="), fill("a:"), fill('"a":'), fill("token="), fill(" ="), `token${fill(" ")}=`, fill("--token "), fill("-"),
      fill('"a'), fill("'a"), fill('"a" '), fill('"a:'), fill("'x=y' "), fill('"token":"a'), fill('\\\\"'), `"${fill("a:")}`,
      fill('"a"\n'), `"a"${fill("\r\n")}:`, `"token":${fill("\n")}`, fill("'a' :"), fill(`"'a':`), fill('"token"\n:'), fill("'[REDACTED:X]':"),
      fill('"token:a" :'), `"${fill("token=a ")}": x`, fill(`"'a b' token=c":`), `"${fill("'a")}":`,
      fill('\\"a'), fill('\\"a\\\\\\"'), `\\"${fill('a\\\\\\"')}`, fill('\\"token\\":'), fill('\\"token\\":\\"a\\"'), fill('"token":\n"a"\n:'), fill("token: a :"),
      `"${fill('\\"a')}": 1`, `"\\"${fill('a\\\\\\"')}": 1`, fill('\\"a \\"'), `"${fill('\\"token\\": ')}": 1`, fill("token=Basic "), `token=Basic${fill(" ")}x`,
      `Authorization: Digest ${fill('a="b", ')}`, fill("Authorization: Basic a\n"), fill("x: Authorization: Basic "),
    ];
    for (const input of inputs) {
      const started = performance.now();
      scrubDiagnosticSecrets(input);
      // Generous for a loaded CI host; the quadratic key regex took seconds on each of the first two.
      expect(performance.now() - started, input.slice(0, 24)).toBeLessThan(250);
    }
  });

  it("takes any key holding a credential word, `auth` only as a whole segment", () => {
    expect(scrubDiagnosticSecrets("x: api_key=a X-Api-Key: b accessKey=c private-key=d credentials=e pwd=f Bearer=g x-auth=h GH_TOKEN=i author=j; oauth=k"))
      .toBe("x: api_key=[REDACTED:TOKEN] X-Api-Key: [REDACTED:TOKEN] accessKey=[REDACTED:TOKEN] private-key=[REDACTED:TOKEN] credentials=[REDACTED:TOKEN] pwd=[REDACTED:TOKEN] Bearer=[REDACTED:TOKEN] x-auth=[REDACTED:TOKEN] GH_TOKEN=[REDACTED:TOKEN] author=j; oauth=k");
    // Accepted false positives: a key holding a credential word is redacted even when its value is not a secret.
    expect(scrubDiagnosticSecrets("x: password_policy_url=https://corp.example/pw")).toBe("x: password_policy_url=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: max_tokens: 4096")).toBe("x: max_tokens: [REDACTED:TOKEN]");
  });

  it("redacts header-like authorization lines", () => {
    const token = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    const out = scrubDiagnosticSecrets(`> GET /info/refs\n> Authorization: Bearer abc123def456ghi789\n> authorization: token ${token}`);
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).not.toContain(token);
  });

  it("redacts the secret lines of credential-helper and askpass output, and keeps the rest", () => {
    const out = scrubDiagnosticSecrets("protocol=https\nhost=example.com\nusername=alice\npassword=hunter2\noauth_refresh_token=refresh-me\n");
    expect(out).not.toMatch(/hunter2|refresh-me/u);
    expect(out).toContain("host=example.com");
    expect(out).toContain("password=[REDACTED:TOKEN]");
    // Inside a line a bare value runs to whitespace, punctuation included: `s3cret;suffix` is one value.
    expect(scrubDiagnosticSecrets("helper failed: token=s3cret;suffix retry")).toBe("helper failed: token=[REDACTED:TOKEN] retry");
    // A helper line's value runs to the line's end, spaces included.
    expect(scrubDiagnosticSecrets("password=correct horse battery\nquit=1")).toBe("password=[REDACTED:TOKEN]\nquit=1");
  });
});

describe("redactFsPath", () => {
  const home = os.homedir();
  // Guard: if homedir is empty (rare CI sandbox) the redact logic is a no-op —
  // skip these tests rather than give a false-green pass.
  const itIfHome = home ? it : it.skip;

  itIfHome("replaces home-dir prefix in a plain FS path", () => {
    const p = home + "/.ave/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^<home>/);
    expect(result).not.toContain(home);
  });

  itIfHome("replaces home-dir prefix in a file:// URL (pathToFileURL format)", () => {
    // Use pathToFileURL so the test input matches what Electron/Node produces,
    // not just the same string-concat the implementation uses internally.
    const p = pathToFileURL(home + "/.ave/plugins/com.example/dist/ui.js").href;
    const result = redactFsPath(p);
    expect(result).toMatch(/^file:\/\/<home>/);
    expect(result).not.toContain(home);
  });

  it("leaves unrelated paths unchanged", () => {
    const p = "/tmp/some-random-path/file.js";
    expect(redactFsPath(p)).toBe(p);
  });

  itIfHome("caps paths longer than 256 code points", () => {
    // Use emoji (2 UTF-16 units each) to verify the cap works on code points,
    // not UTF-16 code units. 300 emoji + "<home>/" = 307 code points > 256.
    const long = home + "/" + "😀".repeat(300);
    const result = redactFsPath(long);
    expect([...result].length).toBeLessThanOrEqual(257); // 256 code points + ellipsis
    expect(result).toContain("…");
  });

  it("returns the input unchanged for empty string", () => {
    expect(redactFsPath("")).toBe("");
  });

  itIfHome("handles exact home-dir match without trailing slash", () => {
    expect(redactFsPath(home)).toBe("<home>");
  });

  itIfHome("handles Windows-style backslash separator", () => {
    // Simulate a Windows path where the home dir is used as a prefix.
    const winHome = home.replace(/\//g, "\\");
    const p = winHome + "\\AppData\\Roaming\\ave\\plugins\\foo.js";
    const result = redactFsPath(p);
    // On non-Windows, _homeDir uses forward slashes so backslash paths won't
    // match — this test is mainly a contract test for when running on Windows.
    // Just assert no throw and the result is a string.
    expect(typeof result).toBe("string");
  });
});

describe("redactHomePathsInText", () => {
  it("redacts embedded Windows, macOS, Linux, and file URL home paths", () => {
    const input = [
      "Windows C:\\Users\\alice\\private\\output",
      "macOS /Users/alice/private/output",
      "Linux /home/alice/private/output",
      "Windows URL file:///C:/Users/alice/private/output",
      "macOS URL file:///Users/alice/private/output",
      "Linux URL file:///home/alice/private/output",
    ].join(" | ");
    const redacted = redactHomePathsInText(input);

    expect(redacted).not.toContain("C:\\Users\\alice");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted.match(/\[home\]/gu)).toHaveLength(6);
    expect(redactHomePathsInText("/srv/workspace/output")).toBe(
      "/srv/workspace/output",
    );
  });
});

describe("redactAuditPayload", () => {
  const home = os.homedir();
  const itIfHome = home ? it : it.skip;

  itIfHome("redacts known path fields", () => {
    const payload = {
      webContentsId: 42,
      pluginId: "com.example",
      entryUrl: home + "/.ave/plugins/com.example/dist/ui.js",
      entryFsPath: home + "/.ave/plugins/com.example/dist/ui.js",
      reason: "invalid-entry-url",
    };
    const result = redactAuditPayload(payload) as Record<string, unknown>;
    expect(result.entryUrl).toMatch(/^<home>/);
    expect(result.entryFsPath).toMatch(/^<home>/);
    expect(result.pluginId).toBe("com.example");
    expect(result.webContentsId).toBe(42);
    expect(result.reason).toBe("invalid-entry-url");
  });

  it("returns non-object payload unchanged", () => {
    expect(redactAuditPayload("string")).toBe("string");
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload(42)).toBe(42);
  });
});
