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
import { CREDENTIAL_FORMAT_PREFIXES, holdsCredential, reservedPrefixIn, scrubDiagnosticSecrets, scrubDiagnosticSecretsStrict, type CredentialIssuer } from "../../shared/dlp.js";
import { linearGrowthBound, measureCpuGrowth } from "../../__tests__/support/cpu-growth.js";
import { fixtureSecret } from "./secret-fixtures.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../shared/__tests__/fixtures/diagnostic-secret-probes.js";

it("redacts unfinished private key bodies in diagnostic and display text", () => {
  const text = "command\n-----BEGIN PRIVATE KEY-----\nunfinished-private-material";
  expect(scrubDiagnosticSecretsStrict(text)).toBe("command\n[REDACTED:PRIVATE_KEY]");
  expect(scrubSecretsForLLM(text)).toBe("command\n[REDACTED:PRIVATE_KEY]");
});

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
      // Restore the module-global audit sink to avoid leaking it across files.
      initDlpAudit(null, "unknown");
    }
  });
});

describe("scrubDiagnosticSecrets — real credential formats, not prefixes (design §18.8)", () => {
  // Assemble realistic token shapes so no complete credential sits in source.
  const mixed = (length: number) => "A1b2C3d4E5f6G7h8".repeat(Math.ceil(length / 16)).slice(0, length);
  const TOKENS: ReadonlyArray<readonly [string, string]> = [
    ["GitHub classic", fixtureSecret("gh", "p_", mixed(36))],
    ["GitHub OAuth", fixtureSecret("gh", "o_", mixed(36))],
    ["GitHub user-to-server", fixtureSecret("gh", "u_", mixed(36))],
    ["GitHub server-to-server", fixtureSecret("gh", "s_", mixed(36))],
    ["GitHub refresh", fixtureSecret("gh", "r_", mixed(36))],
    ["GitHub App installation (stateless)", fixtureSecret("gh", "s_", "123456_", "eyJ", "hbGciOiJSUzI1NiJ9", ".", "eyJpc3MiOiIxMjM0NTYifQ", ".", mixed(342))],
    ["GitHub fine-grained", fixtureSecret("github", "_pat_", mixed(22), "_", mixed(59))],
    ["GitLab personal", fixtureSecret("gl", "pat-", mixed(20))],
    ["GitLab deploy", fixtureSecret("gl", "dt-", mixed(20))],
    ["npm", fixtureSecret("np", "m_", mixed(36))],
    ["Slack bot", fixtureSecret("xo", "xb-", "123456789012-123456789012-", mixed(24))],
    ["Slack user", fixtureSecret("xo", "xp-", "123456789012-123456789012-123456789012-", mixed(32))],
    ["Slack app", fixtureSecret("xa", "pp-", "1-A0123ABC-1234567890123-", mixed(32))],
    ["AWS key id", fixtureSecret("AK", "IA", "IOSFODNN7EXAMPL3")],
    ["AWS temporary key id", fixtureSecret("AS", "IA", "IOSFODNN7EXAMPL3")],
    ["Google API key", fixtureSecret("AI", "za", mixed(35))],
    ["Google API key ending in -", fixtureSecret("AI", "za", mixed(34), "-")],
    ["OpenAI", fixtureSecret("sk", "-", mixed(48))],
    ["OpenAI project", fixtureSecret("sk", "-proj-", mixed(64), "_", mixed(40))],
    ["OpenAI signed", fixtureSecret("sk", "-", mixed(20), "T3Blbk", "FJ", mixed(20))],
    ["Anthropic", fixtureSecret("sk", "-ant-api03-", mixed(93), "AA")],
    ["Stripe secret", fixtureSecret("sk", "_live_", mixed(24))],
    ["Stripe restricted", fixtureSecret("rk", "_test_", mixed(24))],
  ];

  const RESERVED: Readonly<Record<string, readonly [string, CredentialIssuer]>> = {
    "GitHub classic": ["ghp_", "github"], "GitHub OAuth": ["gho_", "github"], "GitHub user-to-server": ["ghu_", "github"],
    "GitHub server-to-server": ["ghs_", "github"], "GitHub refresh": ["ghr_", "github"], "GitHub App installation (stateless)": ["ghs_", "github"],
    "GitHub fine-grained": ["github_pat_", "github"], "GitLab personal": ["glpat-", "gitlab"], "GitLab deploy": ["gldt-", "gitlab"],
    npm: ["npm_", "npm"], "Slack bot": ["xoxb-", "slack"], "Slack user": ["xoxp-", "slack"], "Slack app": ["xapp-", "slack"],
    "AWS key id": ["AKIA", "aws"], "AWS temporary key id": ["ASIA", "aws"], "Google API key": ["AIza", "google"], "Google API key ending in -": ["AIza", "google"],
    OpenAI: ["sk-", "openai"], "OpenAI project": ["sk-proj-", "openai"], "OpenAI signed": ["sk-", "openai"], Anthropic: ["sk-ant-", "anthropic"],
    "Stripe secret": ["sk_live_", "stripe"], "Stripe restricted": ["rk_test_", "stripe"],
  };

  it.each(TOKENS)("names the reserved prefix of a %s token, alone or after a word", (kind, token) => {
    const [prefix, issuer] = RESERVED[kind]!;
    expect(token.startsWith(prefix)).toBe(true);
    for (const text of [token, `docs-${token}`, `1.0.0+${token}`]) expect(reservedPrefixIn(text), text).toEqual({ prefix, issuer });
  });

  it("lists every row whose prefix extends another row's before that row, across the whole table", () => {
    const rows = CREDENTIAL_FORMAT_PREFIXES;
    expect(rows.length).toBeGreaterThan(10);
    for (let general = 0; general < rows.length; general++) {
      for (let specific = general + 1; specific < rows.length; specific++) {
        for (const short of rows[general]!) {
          for (const long of rows[specific]!) {
            expect(long !== short && long.startsWith(short), `${long} (row ${specific}) extends ${short} (row ${general}) but comes after it`).toBe(false);
          }
        }
      }
    }
  });

  it("names the more specific issuer where a key also carries a general row's shape", () => {
    // Overlapping token signatures must redact the same starting position.
    const overlap = fixtureSecret("sk", "-ant-api03-", "a".repeat(12), "T3Blbk", "FJ", "b".repeat(12));
    expect(reservedPrefixIn(overlap)).toEqual({ prefix: "sk-ant-", issuer: "anthropic" });
    expect(reservedPrefixIn(`1.0.0-${overlap}`)).toEqual({ prefix: "sk-ant-", issuer: "anthropic" });
    const project = fixtureSecret("sk", "-proj-", mixed(40), "T3Blbk", "FJ");
    expect(reservedPrefixIn(project)).toEqual({ prefix: "sk-proj-", issuer: "openai" });
  });

  it("names the earliest prefix, the specific row's where two start together, and none where no format is", () => {
    const gitlab = fixtureSecret("gl", "pat-", mixed(20));
    const openai = fixtureSecret("sk", "-", mixed(48));
    expect(reservedPrefixIn(`${openai}-${gitlab}`)).toEqual({ prefix: "sk-", issuer: "openai" });
    expect(reservedPrefixIn(`${gitlab}-${openai}`)).toEqual({ prefix: "glpat-", issuer: "gitlab" });
    expect(reservedPrefixIn(fixtureSecret("sk", "-proj-", mixed(40), "T3Blbk", "FJ"))).toEqual({ prefix: "sk-proj-", issuer: "openai" });
    expect(reservedPrefixIn(`eyJ${mixed(10)}.${mixed(10)}.${mixed(10)}`)).toEqual({ prefix: "eyJ", issuer: "jwt" });
    // Reserve complete token formats; shorter or alphanumeric-glued prefixes remain identifiers.
    expect(reservedPrefixIn("glpat-rotation-documentation-for-local-marketplaces")).toEqual({ prefix: "glpat-", issuer: "gitlab" });
    for (const text of ["glpat-rotation-docs", "sk-proj-tools", "task-proj-build-the-user-interface-for-the-marketplace", "password=hunter2", "https://alice:secret@example.com/x"]) {
      expect(reservedPrefixIn(text), text).toBeNull();
    }
    // Context-detected credentials have no format prefix to report.
    expect(holdsCredential("password=hunter2")).toBe(true);
  });

  it.each(TOKENS)("masks a %s token in a host, a path, an id, a URL and an ssh account, behind any boundary", (_kind, token) => {
    for (const text of [
      token,
      // A format starts after any non-alphanumeric character and counts the entire following body.
      `backup_${token}`,
      `backup-${token}`,
      `x-${token}`,
      `key:${token}`,
      `id=${token}`,
      `"${token}"`,
      `'${token}'`,
      `backup.${token}`,
      `${token}_backup`,
      `${token}-backup`,
      `${token}.backup`,
      `//server/share/backup_${token}`,
      `${token}.example.com`,
      `/srv/markets/${token}/plugins`,
      `C:\\work\\${token}\\market`,
      `market-${token}`,
      `https://example.com/acme/${token}/market.git`,
      `ssh://${token}@git.example/acme/market`,
    ]) {
      const scrubbed = scrubDiagnosticSecrets(text);
      expect(scrubbed, text).not.toContain(token);
      expect(scrubbed).toContain("[REDACTED:");
    }
  });

  it("masks a stateless GitHub App installation token whole, app id included", () => {
    const token = fixtureSecret("gh", "s_", "123456_", "eyJ", "hbGciOiJSUzI1NiJ9", ".", "eyJpc3MiOiIxMjM0NTYifQ", ".", mixed(342));
    expect(scrubDiagnosticSecrets(`/srv/${token}/x`)).toBe("/srv/[REDACTED:TOKEN]/x");
  });

  it("masks a JSON Web Token in a path and a URL, after `_` too, and a private key block", () => {
    const jwt = fixtureSecret("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", mixed(43));
    for (const text of [`/srv/${jwt}/x`, `https://example.com/cb?state=${jwt}`, `/srv/backup_${jwt}`, `x-${jwt}`]) {
      expect(scrubDiagnosticSecrets(text), text).not.toContain(jwt);
    }
    const pem = fixtureSecret("-----BEGIN ", "PRIVATE KEY-----\n", mixed(64), "\n-----END ", "PRIVATE KEY-----");
    expect(scrubDiagnosticSecrets(`key file:\n${pem}\nend`)).toBe("key file:\n[REDACTED:PRIVATE_KEY]\nend");
  });

  // Unprefixed 52-character base32 tokens can also be ordinary digests.
  const azure = fixtureSecret("abcdefgh234567", "abcdefgh234567", "abcdefgh234567", "abcdefgh23");

  it("masks an Azure DevOps token only where it stands as a credential", () => {
    for (const text of [
      `https://user:${azure}@dev.azure.com/acme/_git/market`,
      `https://${azure}@dev.azure.com/acme/_git/market`,
      `Authorization: Basic ${Buffer.from(`:${azure}`).toString("base64")}`,
      `Authorization: Bearer ${azure}`,
      `AZURE_DEVOPS_EXT_PAT=${azure}`,
      `pat=${azure}`,
      `https://dev.azure.com/acme?token=${azure}`,
      `{"pat": "${azure}"}`,
    ]) {
      const scrubbed = scrubDiagnosticSecrets(text);
      expect(scrubbed, text).not.toContain(azure);
      expect(scrubbed).toContain("[REDACTED:");
    }
    // Preserve base32 identifiers outside credential context.
    for (const text of [azure, `1.0.0+${azure}`, `/srv/cache/${azure}/x`]) expect(scrubDiagnosticSecrets(text)).toBe(text);
  });

  it.each([
    "test-server01.corp.example",
    "live-db-replica-0001.internal",
    "proj-alpha.example.com",
    "sk-learn.example.org",
    "aizawa-shop-production-europe-west1.example",
    "akiaprojectserverab.example",
    "xapp-launcher.example.com",
    "live-captions",
    "sk-learn-utils",
    "test-runner",
    "pk-tools",
    "rk-deploy-helper",
    "proj-template-react",
    "test-marketplace",
    "test-marketplace2026",
    "test-integration123",
    "live-notifications2026",
    "live-feed-2024",
    "npm-audit-helper",
    "glpat-rotation-docs",
    "sk-proj-tools",
    "/Users/example/test-fixtures01/market",
    "C:\\work\\live-dashboard-2024\\plugins",
    "/opt/sk-learn-utils/v2",
    "ssh://git@github.com/acme/market",
    "https://github.com/acme/live-captions",
    "laughs_compilation-of-the-best-moments-2026.mp4",
    "task-proj-build-the-user-interface-for-the-marketplace",
    "task-prepare-marketplace-folder-source-diagnostics",
    "task-sk-learn-utils",
    "npm_scripts",
    "akiak-production",
    "AKIA-example-not-a-token",
    "/media/backup_test-marketplace2026/notes",
    "path=/srv/market",
    "patterns=src/**/*.ts",
    "0123456789abcdef0123456789abcdef01234567",
    "1.0.0+al62ny3xigdbyafl7irut3jbxlrld5chtn2dxghblz6hml2otyqq",
    "local-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ])("keeps %s as it is", (text) => {
    expect(scrubDiagnosticSecrets(text)).toBe(text);
  });

  it("leaves the model-bound scrubber's broad prefix rule as it was", () => {
    // Model-bound text favors false positives over missed credentials.
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
    // Authorization values extend to line end; embedded redaction markers are untrusted.
    expect(scrubSecretsForLLM("Authorization: Bearer [REDACTED:TOKEN] status=200")).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("x-api-key: myheaderSECRET99")).not.toContain("myheaderSECRET99");
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42")).not.toContain("rawSecretHeader42");
    const basicSecret = fixtureSecret("Basic ", "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(scrubSecretsForLLM(`Authorization: ${basicSecret}`)).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM(`{"level":30,"msg":"Authorization: ${basicSecret}","status":200}`)).toBe('{"level":30,"msg":"Authorization: [REDACTED:TOKEN]');
    const digest = scrubSecretsForLLM('Authorization: Digest username="user", response="secret-response-token" status=200');
    expect(digest).toBe("Authorization: [REDACTED:TOKEN]");
    const embeddedDigest = scrubSecretsForLLM(
      '{"level":30,"msg":"Authorization: Digest username=\\"user\\", response=\\"secret-response-token\\"","status":200}',
    );
    expect(embeddedDigest).toBe('{"level":30,"msg":"Authorization: [REDACTED:TOKEN]');
    // Unknown authorization schemes still consume the rest of the line.
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42 status=200")).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("Couldn't connect: Authorization: Custom foo' opaque-pass-12345\nnext")).toBe("Couldn't connect: Authorization: [REDACTED:TOKEN]\nnext");
    expect(scrubSecretsForLLM("Proxy-Authorization: Weird a=1, b=opaque-pass-12345")).toBe("Proxy-Authorization: [REDACTED:TOKEN]");
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
    // Detect credentials beyond 200 characters without relying on truncation.
    const line = "x".repeat(200) + " Bearer LATElineSECRETtoken777";
    const out = scrubSecretsForLLM(line);
    expect(out).not.toContain("LATElineSECRETtoken777");
    expect(out.length).toBeGreaterThan(120); // whole line preserved, not truncated
  });

  it("does not redact unprefixed high-entropy hashes without credential context", () => {
    // Keep diagnostic scrubbing prefix/context-driven so commit and artifact hashes survive.
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
    // Quoted text without a following separator may still contain assignments.
    expect(scrubDiagnosticSecrets(`msg "token=canarypass" sent; it's fine`)).toBe(`msg "token=[REDACTED:TOKEN] sent; it's fine`);
  });

  it("keeps the scanner's invariant on ordinary JSON, and on its own output", () => {
    for (const text of ['{"host":"::1","port":443}', '{"op":"=","value":3}', '"a":":x"', `x "a 'b "c": 1' : 2" : 3`]) {
      expect(scrubDiagnosticSecretsStrict(text)).toBe(text);
    }
    expect(scrubDiagnosticSecretsStrict('{"password":"=hunter2"}')).toBe('{"password":[REDACTED:TOKEN]}');
    expect(scrubDiagnosticSecretsStrict('{" --token ": "x"}')).toBe('{" --token ": [REDACTED:TOKEN]}');
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
    // Quotes never terminate an Authorization value before line end.
    expect(scrubDiagnosticSecrets('Authorization: "Basic dXNlcjpwYXNz" next')).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("authorization='Basic dXNlcjpwYXNz' next")).toBe("authorization=[REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: Authorization=Basic dXNlcjpwYXNz next\nkept")).toBe("x: Authorization=[REDACTED:TOKEN]\nkept");
    expect(scrubDiagnosticSecrets("Authorization=Basic dXNlcjpwYXNz next\nkept")).toBe("Authorization=[REDACTED:TOKEN]\nkept");
    expect(scrubDiagnosticSecrets("x: token=Negotiate YIIabc next")).toBe("x: token=[REDACTED:TOKEN] next");
    expect(scrubDiagnosticSecrets("x: password=basic next")).toBe("x: password=[REDACTED:TOKEN]");
    // Authorization schemes consume the rest of the line; other keys consume the next word.
    expect(scrubDiagnosticSecrets('x: Authorization: Digest username="u", realm="r", nonce="n", uri="/", response="6629fae4"\nnext')).toBe("x: Authorization: [REDACTED:TOKEN]\nnext");
    expect(scrubDiagnosticSecrets('Proxy-Authorization: Digest username="u", response="6629fae4"')).toBe("Proxy-Authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: Authorization: Bearer abc def\nkept")).toBe("x: Authorization: [REDACTED:TOKEN]\nkept");
    expect(scrubDiagnosticSecrets("helper --authorization Bearer abc def")).toBe("helper --authorization [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("x: token=Basic abc def")).toBe("x: token=[REDACTED:TOKEN] def");
    expect(scrubDiagnosticSecrets('x: authorization: "Basic abc" kept')).toBe("x: authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("Authorization: Custom opaque-pass-12345")).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets("Proxy-Authorization: Weird a=1, b=2\nnext")).toBe("Proxy-Authorization: [REDACTED:TOKEN]\nnext");
    expect(scrubDiagnosticSecrets("proxy returned Authorization: Custom opaque-pass-12345")).toBe("proxy returned Authorization: [REDACTED:TOKEN]");
    expect(scrubDiagnosticSecrets('x {"msg":"Authorization: Custom opaque-pass-12345","status":200}')).toBe('x {"msg":"Authorization: [REDACTED:TOKEN]');
    expect(scrubDiagnosticSecrets("error: 'Authorization: Custom opaque-pass-12345' failed")).toBe("error: 'Authorization: [REDACTED:TOKEN]");
    // A delimited authorization word makes a header key, including accepted URL over-masking.
    expect(scrubDiagnosticSecrets("x: authorization_url=https://idp.example/x kept")).toBe("x: authorization_url=[REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("x: authorization_url=https://idp.example/x kept")).toBe("x: authorization_url=[REDACTED:TOKEN]");
    for (const kept of ["xauthorization: keep", "authorizationfoo: keep", "the authorization header was absent", "authorization_flow failed"]) {
      expect(scrubDiagnosticSecrets(kept)).toBe(kept);
      expect(scrubSecretsForLLM(kept)).toBe(kept);
    }
    // Scan key remainders through punctuation and nested quotes to the first raw or escaped separator.
    for (const [key, masked] of [
      ["authorization header", '{"authorization header":'],
      ["authorization\\tvalue", '{"authorization\\tvalue":'],
      [`authorization${String.fromCharCode(0xa0)}header`, `{"authorization${String.fromCharCode(0xa0)}header":`],
      ["authorization\\u003aheader", '{"authorization\\u003a'],
      ["authorization\\u003dheader", '{"authorization\\u003d'],
      ["authorization:header", '{"authorization:'],
      ["client's authorization header", `{"client's authorization header":`],
      ['client \\"authorization header', '{"client \\"authorization header":'],
      ['prefix \\"quoted\\" authorization header', '{"prefix \\"quoted\\" authorization header":'],
    ]) {
      const text = `{"${key}":"Custom opaque-pass-12345"}`;
      expect(scrubDiagnosticSecrets(text), text).toBe(`${masked}[REDACTED:TOKEN]`);
      expect(scrubSecretsForLLM(text), text).toBe(`${masked}[REDACTED:TOKEN]`);
      for (let depth = 1; depth < 4; depth++) {
        let nested = text;
        for (let level = 0; level < depth; level++) nested = JSON.stringify({ level: 30, msg: nested });
        expect(scrubDiagnosticSecrets(nested), nested).not.toContain("opaque-pass-12345");
        expect(scrubSecretsForLLM(nested), nested).toBe(scrubDiagnosticSecrets(nested));
      }
    }
    // An unmatched distant quote must not consume intervening lines.
    const info = Array.from({ length: 1000 }, (_, line) => `INFO line ${line} kept`).join("\n");
    const far = `"\nAuthorization: Custom opaque-pass-12345\n${info}\n": late-value\nlast`;
    expect(scrubDiagnosticSecrets(far)).toBe(`"\nAuthorization: [REDACTED:TOKEN]\n${info}\n": late-value\nlast`);
    expect(scrubSecretsForLLM(far)).toBe(scrubDiagnosticSecrets(far));
    // Stop key scans after one raw line break or 256 decoded reads.
    for (const kept of ["the authorization header\nwas absent\nnext: line", `authorization ${"x".repeat(300)}: value`]) {
      expect(scrubDiagnosticSecrets(kept)).toBe(kept);
      expect(scrubSecretsForLLM(kept)).toBe(kept);
    }
    // The 256-read limit includes the separator; escapes and backslash runs each count once, as does a newline with its trailing whitespace.
    const astral = String.fromCodePoint(0x1f600);
    for (const [label, text, masked] of [
      ["255 units, then the separator as the 256th read", `authorization${"_".repeat(255)}: v`, true],
      ["256 units, the separator a 257th read", `authorization${"_".repeat(256)}: v`, false],
      ["a space and 127 astral characters (254 units)", `authorization ${astral.repeat(127)}: v`, true],
      ["a space and 128 astral characters (256 units)", `authorization ${astral.repeat(128)}: v`, false],
      ["255 `\\u` escapes, one read each", `authorization${"\\u005f".repeat(255)}: v`, true],
      ["256 `\\u` escapes", `authorization${"\\u005f".repeat(256)}: v`, false],
      ["254 spaces, the break, the separator", `authorization${" ".repeat(254)}\n: v`, true],
      ["255 spaces before the break: one read per unit", `authorization${" ".repeat(255)}\n: v`, false],
      ["300 spaces after the break: one read with it", `authorization\n${" ".repeat(300)}: v`, true],
    ] as const) {
      const expected = masked ? `${text.slice(0, -1)}[REDACTED:TOKEN]` : text;
      expect(scrubSecretsForLLM(text), label).toBe(expected);
      expect(scrubDiagnosticSecrets(text), label).toBe(expected);
    }
    expect(scrubSecretsForLLM("authorization flow: PKCE")).toBe("authorization flow: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("the authorization header\n  was absent: retry")).toBe("the authorization header\n  was absent: [REDACTED:TOKEN]");
    for (const kept of ['{"level":30,"msg":"authorization header missing"}', '{"authorizationfoo bar":"keep"}', '{"msg":"see the \'authorization\' docs"}']) {
      expect(scrubDiagnosticSecrets(kept)).toBe(kept);
      expect(scrubSecretsForLLM(kept)).toBe(kept);
    }
  });

  describe("an Authorization value ends only at its line's end, or the text's (§18.8)", () => {
    const secret = "opaque-pass-12345";
    it.each([
      ["an apostrophe in its Digest parameter", `Authorization: Digest username="O'Neil", response="${secret}"`, "Authorization: [REDACTED:TOKEN]"],
      ["a contraction before it", `Couldn't authenticate: Authorization: Digest username="O'Neil", response="${secret}"`, "Couldn't authenticate: Authorization: [REDACTED:TOKEN]"],
      ["a contraction and a stray quote in its value", `Couldn't connect: Authorization: Custom foo' ${secret}`, "Couldn't connect: Authorization: [REDACTED:TOKEN]"],
      ["a quote opening its value", `Proxy-Authorization: "Digest username="O'Neil", response="${secret}"" next`, "Proxy-Authorization: [REDACTED:TOKEN]"],
      [
        "a JSON message with a contraction",
        String.raw`{"message":"Couldn't fetch: Authorization: Digest username=\"O'Neil\", response=\"${secret}\"","safe":"keep"}`,
        `{"message":"Couldn't fetch: Authorization: [REDACTED:TOKEN]`,
      ],
      ["a JSON value", String.raw`{"Authorization":"Digest username=\"O'Neil\", response=\"${secret}\"","safe":"keep"}`, `{"Authorization":[REDACTED:TOKEN]`],
      [
        "JSON carried in a JSON string",
        String.raw`"{\"message\":\"Couldn't: Authorization: Custom ${secret}\",\"safe\":\"keep\"}"`,
        String.raw`"{\"message\":\"Couldn't: Authorization: [REDACTED:TOKEN]`,
      ],
      [
        "a value folded onto the lines after it",
        `Authorization: Digest username="O'Neil",\r\n\trealm="r",\r\n response="${secret}"\r\nHost: git.example\r\n`,
        "Authorization: [REDACTED:TOKEN]\r\nHost: git.example\r\n",
      ],
      ["the last line, with no line break after it", `GET /info/refs\nAuthorization: Custom ${secret}`, "GET /info/refs\nAuthorization: [REDACTED:TOKEN]"],
    ])("with %s", (_label, input, expected) => {
      const out = scrubDiagnosticSecrets(input);
      expect(out).toBe(expected);
      expect(out).not.toContain(secret);
      expect(holdsCredential(input)).toBe(true);
    });

    it.each([
      ["a marker followed by more of the value", `Authorization: [REDACTED:TOKEN] ${secret}`, "Authorization: [REDACTED:TOKEN]"],
      ["two markers and more", `Authorization: [REDACTED:TOKEN] [REDACTED:TOKEN] ${secret}`, "Authorization: [REDACTED:TOKEN]"],
      ["a marker with the value folded after it", `Authorization: [REDACTED:TOKEN]\r\n\t${secret}\r\nHost: git.example`, "Authorization: [REDACTED:TOKEN]\r\nHost: git.example"],
      ["a scheme, a marker and more", `Proxy-Authorization: Bearer [REDACTED:TOKEN] ${secret}`, "Proxy-Authorization: [REDACTED:TOKEN]"],
      ["a JSON key whose value starts with a marker", `{"authorization":"[REDACTED:TOKEN] ${secret}","safe":"keep"}`, '{"authorization":[REDACTED:TOKEN]'],
    ])("never trusts a marker in it: %s", (_label, input, expected) => {
      expect(scrubDiagnosticSecrets(input)).toBe(expected);
      expect(scrubSecretsForLLM(input)).toBe(expected);
      expect(holdsCredential(input)).toBe(true);
    });

    it("leaves a value that is one marker as it is, in both scrubbers", () => {
      for (const masked of ["Authorization: [REDACTED:TOKEN]", "x\nProxy-Authorization: [REDACTED:TOKEN]\nnext", '{"Authorization":[REDACTED:TOKEN]']) {
        expect(scrubDiagnosticSecrets(masked)).toBe(masked);
        expect(scrubSecretsForLLM(masked)).toBe(masked);
        expect(holdsCredential(masked)).toBe(false);
      }
    });

    describe("JSON whitespace at the separator, any indent and depth (seeded property)", () => {
      const generator = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
      const KEYS = [
        "Authorization", "authorization", "Proxy-Authorization", "AUTHORIZATION", "x-authorization",
        "authorization_header", "proxy_authorization", "x-authorization-token", "authorization.value", "AUTHORIZATION_URL", "upstream authorization",
        // Whitespace and separators inside quoted keys remain key content.
        "authorization header", "authorization\theader", `authorization${String.fromCharCode(0xa0)}header`, "authorization:header", "authorization=header",
        "upstream authorization header value",
        "client's authorization header", 'client "authorization header', 'prefix "quoted" authorization header', 'a\\"authorization\\\\" b',
        "it's 'authorization' here",
      ];
      const SCHEMES = ["Custom", "Basic", "Bearer", "[REDACTED:TOKEN]", 'Digest username="O\'Neil", response=', ""];
      const INDENTS: ReadonlyArray<number | string | undefined> = [undefined, 0, 1, 2, "\t"];
      const pick = <T,>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      /** Use the same whitespace classification for raw and escaped characters, including BOM and Unicode line separators. */
      const SPACES = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter((char) => /\s/u.test(char));
      const LETTERS: Readonly<Record<string, string>> = { "\n": "n", "\r": "r", "\t": "t", "\f": "f", "\v": "v" };
      const escapedForms = (char: string): string[] => {
        const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
        return [`\\u${hex}`, `\\u${hex.toUpperCase()}`, ...(LETTERS[char] === undefined ? [] : [`\\${LETTERS[char]}`])];
      };
      const LINE_BREAKS = new Set(["\n", "\r"]);
      const gapWithoutRawBreak = (random: () => number): string =>
        Array.from({ length: Math.floor(random() * 4) }, () => {
          const char = pick(random, SPACES);
          return random() < 0.5 && !LINE_BREAKS.has(char) ? char : pick(random, escapedForms(char));
        }).join("");
      const gap = (random: () => number): string =>
        Array.from({ length: Math.floor(random() * 4) }, () => {
          const char = pick(random, SPACES);
          return random() < 0.5 ? char : pick(random, escapedForms(char));
        }).join("");

      it("draws its whitespace from what JS `\\s` covers, U+FEFF, U+2028 and U+2029", () => {
        for (const code of [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2000, 0x2003, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
          expect(SPACES).toContain(String.fromCharCode(code));
        }
      });
      it.each(["FEFF", "2028", "2029", "00A0", "2003", "3000", "000B"])("reads U+%s between a key's closing quote and its colon as whitespace, raw and escaped", (hex) => {
        const char = String.fromCharCode(Number.parseInt(hex, 16));
        for (const form of [char, ...escapedForms(char)]) {
          for (const text of [`{"Authorization"${form}: "Custom ${secret}"}`, `{"Authorization":${form}"Custom ${secret}"}`]) {
            const masked = text.slice(0, text.indexOf('"Custom'));
            expect(scrubDiagnosticSecrets(text), JSON.stringify(text)).toBe(`${masked}[REDACTED:TOKEN]`);
            expect(scrubSecretsForLLM(text), JSON.stringify(text)).toBe(`${masked}[REDACTED:TOKEN]`);
          }
        }
      });
      const SHAPES: ReadonlyArray<(key: string, value: string) => unknown> = [
        (key, value) => ({ [key]: value }),
        (key, value) => ({ level: 30, headers: { accept: "*/*", [key]: value, host: "git.example" } }),
        (key, value) => ({ request: { url: "https://git.example/x", headers: [{ name: "accept" }, { [key]: value }] } }),
      ];
      const CASES = Array.from({ length: 400 }, (_, seed) => {
        const random = generator(seed + 1);
        const key = pick(random, KEYS);
        let text = JSON.stringify(pick(random, SHAPES)(key, `${pick(random, SCHEMES)} ${secret}`.trim()), null, pick(random, INDENTS));
        // Quoted compound keys permit no raw line break; ordinary keys allow one before the separator.
        const spelled = [...key].map((char) => (/[A-Za-z0-9]/u.test(char) || random() < 0.5 ? JSON.stringify(char).slice(1, -1) : pick(random, escapedForms(char)))).join("");
        const separatorInKey = /[:=]/u.test(key);
        const inQuotes = gapWithoutRawBreak(random);
        const beforeColon = separatorInKey ? gapWithoutRawBreak(random) : gap(random);
        const afterColon = separatorInKey ? gapWithoutRawBreak(random) : gap(random);
        text = text.replace(`${JSON.stringify(key)}:`, () => `"${spelled}${inQuotes}"${beforeColon}:${afterColon}`);
        const depth = Math.floor(random() * 4);
        for (let level = 0; level < depth; level++) text = JSON.stringify({ level: 30, msg: text }, null, random() < 0.5 ? undefined : 2);
        return { seed: seed + 1, depth, text };
      });

      it.each(CASES)("seed $seed, depth $depth: neither scrubber leaks, both agree, and again is a no-op", ({ text }) => {
        const diagnostic = scrubDiagnosticSecrets(text);
        const model = scrubSecretsForLLM(text);
        expect(diagnostic).not.toContain(secret);
        expect(model).not.toContain(secret);
        expect(model).toBe(diagnostic);
        expect(scrubDiagnosticSecrets(diagnostic)).toBe(diagnostic);
        expect(scrubSecretsForLLM(model)).toBe(model);
      });
    });

    it("has one place in the scrubber that reads `authorization`: the header stage", async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../../shared/dlp.ts", import.meta.url), "utf8");
      // Strip comments before checking code references to Authorization.
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
      const stageStart = code.indexOf("function authorizationValueEnd(");
      const stageEnd = code.indexOf("\n}\n", code.indexOf("function maskAuthorizationValues(")) + 3;
      expect(stageStart).toBeGreaterThan(0);
      expect(stageEnd).toBeGreaterThan(stageStart);
      const outside = [...code.matchAll(/authorization/giu)].filter((match) => match.index < stageStart || match.index >= stageEnd);
      expect(outside.map((match) => code.slice(match.index - 4, match.index + 25))).toEqual(["maskAuthorizationValues(text)", "maskAuthorizationValues(text)"]);
    });

    describe("one stage for both scrubbers, at any JSON depth (differential)", () => {
      const SCHEMES = ["Custom", "Basic", "Bearer", "Negotiate", 'Digest username="O\'Neil", response=', "[REDACTED:TOKEN]", ""];
      const FORMS: ReadonlyArray<readonly [string, (value: string) => string]> = [
        ["plain", (value) => `Authorization: ${value}`],
        ["equals", (value) => `authorization=${value}`],
        ["proxy", (value) => `Proxy-Authorization: ${value}`],
        ["JSON key", (value) => JSON.stringify({ Authorization: value, safe: "keep" })],
        ["flag", (value) => `curl --authorization ${value} --next`],
        ["x-prefixed", (value) => `x-authorization: ${value}`],
        ["folded", (value) => `Authorization: Custom\r\n\t${value}\r\nHost: git.example`],
        ["after a line break", (value) => `request failed\nAuthorization: ${value}`],
        ["u-escaped JSON key", (value) => `{"\\u0041uthorization":${JSON.stringify(value)}}`],
        ["escaped NBSP", (value) => `Authorization\\u00a0: ${value}`],
        ["escaped EM SPACE", (value) => `{"Authorization":\\u2003${JSON.stringify(value)}}`],
        ["escaped BOM", (value) => `{"Authorization\\uFEFF": ${JSON.stringify(value)}}`],
        ["escaped vertical tab", (value) => `authorization\\v= ${value}`],
        ["compound JSON key", (value) => JSON.stringify({ authorization_header: value, safe: "keep" })],
        ["compound proxy key", (value) => `proxy_authorization: ${value}`],
        ["compound dotted key", (value) => `authorization.value = ${value}`],
        ["compound escaped delimiter", (value) => `{"authorization\\u005fheader":${JSON.stringify(value)}}`],
      ];
      const encode = (text: string, depth: number): string => {
        let out = text;
        for (let level = 0; level < depth; level++) out = JSON.stringify({ level: 30, msg: out });
        return out;
      };
      const CASES = FORMS.flatMap(([form, build]) => SCHEMES.flatMap((scheme) => [0, 1, 2, 3].map((depth) => ({ form, scheme, depth, text: encode(build(`${scheme} ${secret}`.trim()), depth) }))));

      it.each(CASES)("$form, $scheme, depth $depth: neither leaks, both mask the same span, and again is a no-op", ({ text }) => {
        const diagnostic = scrubDiagnosticSecrets(text);
        const model = scrubSecretsForLLM(text);
        expect(diagnostic).not.toContain(secret);
        expect(model).not.toContain(secret);
        expect(model).toBe(diagnostic);
        expect(scrubDiagnosticSecrets(diagnostic)).toBe(diagnostic);
        expect(scrubSecretsForLLM(model)).toBe(model);
      });
    });

    it("masks the same span for model-bound and diagnostic text", () => {
      const inputs = [
        `Authorization: Custom ${secret}`,
        `Authorization: Custom foo\r\n\t${secret}\r\nnext`,
        `Couldn't authenticate: Authorization: Digest username="O'Neil", response="${secret}"\nretry`,
        `Authorization: Basic ${secret} status=200`,
        `Authorization: Bearer [REDACTED:TOKEN] ${secret}`,
        `{"message":"Couldn't fetch: Authorization: Custom foo' ${secret}","safe":"keep"}`,
        `{"Authorization": "Digest username=\\"O'Neil\\", response=\\"${secret}\\""}`,
        `curl --authorization Custom ${secret}\n--next`,
        `x-authorization: Custom ${secret}`,
        `authorization=Custom ${secret}\nkept`,
        `Proxy-Authorization:\n ${secret}\nkept`,
      ];
      for (const input of inputs) {
        const diagnostic = scrubDiagnosticSecrets(input);
        expect(scrubSecretsForLLM(input), input).toBe(diagnostic);
        expect(diagnostic, input).not.toContain(secret);
      }
    });

    it("keeps the lines after it, and a sentence with contractions and no header", () => {
      expect(scrubDiagnosticSecrets(`Authorization: Custom ${secret}\nCouldn't reach O'Neil's mirror`)).toBe("Authorization: [REDACTED:TOKEN]\nCouldn't reach O'Neil's mirror");
      expect(holdsCredential("Couldn't reach O'Neil's mirror: the authorization_server isn't up")).toBe(false);
    });
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
    // Unknown escapes fail closed; a value on the next line consumes that line.
    expect(scrubDiagnosticSecrets('"C:\\dir":\ntoken: canarypass\nnext')).toBe('"C:\\dir":\n[REDACTED:TOKEN]\nnext');
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
    expect(scrubDiagnosticSecrets('{"password":\r\n  "canarypass"}')).toBe('{"password":\r\n  [REDACTED:TOKEN]');
    expect(scrubDiagnosticSecrets("prose ends with token:\nnext line")).toBe("prose ends with token:\nnext line");
  });

  it("never reads a redaction marker as key material, and redacts an assignment inside a quoted key", () => {
    expect(scrubDiagnosticSecrets("fatal: unable to access 'https://alice:canarypass@host/repo': 401")).toBe("fatal: unable to access 'https://[REDACTED:CREDENTIALS]@host/repo': 401");
    expect(scrubDiagnosticSecrets("remote: 'see docs': 403")).toBe("remote: 'see docs': 403");
    // Credential-key detection accepts over-redaction of status values.
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
    expect(scrubDiagnosticSecrets('apikey="\\\n GH_TOKEN="canarypass"')).toBe("apikey=[REDACTED:TOKEN]");
  });

  it("redacts the value of a long credential flag, and leaves a short one", () => {
    expect(scrubDiagnosticSecrets("helper --password canarypass --api-key=other --verbose --depth 1")).toBe("helper --password [REDACTED:TOKEN] --api-key=[REDACTED:TOKEN] --verbose --depth 1");
    expect(scrubDiagnosticSecrets("helper --token --verbose")).toBe("helper --token --verbose");
    // A bare -p flag provides no credential context.
    expect(scrubDiagnosticSecrets("mysql -p canarypass")).toBe("mysql -p canarypass");
  });

  it("scrubs 332 KB of quotes at 800 distinct escape depths in linear time (round 17)", () => {
    // Bounded key windows prevent repeated scans over unmatched nested quotes.
    let text = "";
    for (let depth = 1; depth <= 800; depth++) text += `${"\\".repeat(depth)}"authorization `;
    expect(text.length).toBeGreaterThan(330_000);
    for (const scrub of [scrubDiagnosticSecrets, scrubSecretsForLLM]) {
      const started = performance.now();
      expect(scrub(text)).toBe(text);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it("scrubs 64 KiB of adversarial text in linear time", () => {
    // Measure CPU growth from 4 KiB to 64 KiB to distinguish linear from quadratic scans.
    const SMALL = 4 * 1024;
    const LARGE = 16 * SMALL;
    const MAX_GROWTH = linearGrowthBound(LARGE / SMALL);
    // Skip growth judgments when the 64 KiB pass is already under 5 ms.
    const growthOptions = { fastEnoughMs: 5, minSampleMs: 20 };
    const familiesAt = (size: number) => {
      const fill = (unit: string, tail = "") => unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;
      return [
        fill("token", "!"), fill("token", "="), fill("a."), fill("a.", "://x@y"), fill("a@"), fill(" a@"), fill("a:b@"), fill("%"),
        `token="${fill("\\")}`, fill('token="a'), fill("token='a"), `'${fill("\\")}':`, fill('\\"'),
        fill("a="), fill("a:"), fill('"a":'), fill("token="), fill(" ="), `token${fill(" ")}=`, fill("--token "), fill("-"),
        fill('"a'), fill("'a"), fill('"a" '), fill('"a:'), fill("'x=y' "), fill('"token":"a'), fill('\\\\"'), `"${fill("a:")}`,
        fill('"a"\n'), `"a"${fill("\r\n")}:`, `"token":${fill("\n")}`, fill("'a' :"), fill(`"'a':`), fill('"token"\n:'), fill("'[REDACTED:X]':"),
        fill('"token:a" :'), `"${fill("token=a ")}": x`, fill(`"'a b' token=c":`), `"${fill("'a")}":`,
        fill('\\"a'), fill('\\"a\\\\\\"'), `\\"${fill('a\\\\\\"')}`, fill('\\"token\\":'), fill('\\"token\\":\\"a\\"'), fill('"token":\n"a"\n:'), fill("token: a :"),
        `"${fill('\\"a')}": 1`, `"\\"${fill('a\\\\\\"')}": 1`, fill('\\"a \\"'), `"${fill('\\"token\\": ')}": 1`, fill("token=Basic "), `token=Basic${fill(" ")}x`,
        `Authorization: Digest ${fill('a="b", ')}`, fill("Authorization: Basic a\n"), fill("x: Authorization: Basic "),
        fill("\\u0041"), fill("\\\\u0041uthorizatio"), fill("Authorizatio"), fill('\\"Authorization\\"'), fill("\\nauthorization"), fill("--authorizatio"),
        `Authorization${fill("\n")}`, `"Authorization"${fill("\\n")}`, `Authorization${fill("\\\\\\t")}`, fill("Authorization \n"), fill('"authorization"\\u000a'), `authorization:${fill(" \r\n")}`,
        fill("authorization_"), `authorization_${fill("a")}`, fill("x-authorization-token "), fill("authorization.x\\u00a0"), `Authorization${fill("\\u00a0")}`,
        `Authorization${fill("\\\\u2003")}`, fill("authorization\\u005f"), fill("Authorization\\u0041"), `"authorization_x${fill("\\uFEFF")}"`,
        `"${fill("authorization ")}`, fill('"authorization '), fill("'a authorization "), fill('"authorization \\"authorization '),
        `"${fill("authorization\\u003a")}`, `\\"${fill("authorization\n")}\\": x`, fill('"x" authorization '),
        // Read long backslash runs once per key window rather than once per step.
        `${"authorization ".repeat(18)}${fill("\\")}`, `${"authorization ".repeat(18)}${fill("\\", "u0041")}`,
      ];
    };
    const small = familiesAt(SMALL);
    const large = familiesAt(LARGE);
    expect(large.map((input) => input.length)).toEqual(small.map((input) => input.length - SMALL + LARGE));
    for (const [index, input] of large.entries()) {
      for (const scrub of [scrubDiagnosticSecrets, scrubSecretsForLLM]) {
        const { smallMs, largeMs, growth } = measureCpuGrowth(() => scrub(small[index]), () => scrub(input), growthOptions);
        if (growth === undefined) continue;
        expect(growth,`${input.slice(0, 24)}: ${smallMs.toFixed(1)} ms at 4 KiB, ${largeMs.toFixed(1)} ms at 64 KiB`).toBeLessThan(MAX_GROWTH);
      }
    }
    // CPU samples avoid load bias, but collecting them may exceed the default wall-time budget.
  }, 180_000);

  it("takes any key holding a credential word, `auth` only as a whole segment", () => {
    expect(scrubDiagnosticSecrets("x: api_key=a X-Api-Key: b accessKey=c private-key=d credentials=e pwd=f Bearer=g x-auth=h GH_TOKEN=i author=j; oauth=k"))
      .toBe("x: api_key=[REDACTED:TOKEN] X-Api-Key: [REDACTED:TOKEN] accessKey=[REDACTED:TOKEN] private-key=[REDACTED:TOKEN] credentials=[REDACTED:TOKEN] pwd=[REDACTED:TOKEN] Bearer=[REDACTED:TOKEN] x-auth=[REDACTED:TOKEN] GH_TOKEN=[REDACTED:TOKEN] author=j; oauth=k");
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
    expect(scrubDiagnosticSecrets("helper failed: token=s3cret;suffix retry")).toBe("helper failed: token=[REDACTED:TOKEN] retry");
    expect(scrubDiagnosticSecrets("password=correct horse battery\nquit=1")).toBe("password=[REDACTED:TOKEN]\nquit=1");
  });
});

describe("redactFsPath", () => {
  const home = os.homedir();
  // Skip when homedir is empty; no-op redaction would otherwise pass vacuously.
  const itIfHome = home ? it : it.skip;

  itIfHome("replaces home-dir prefix in a plain FS path", () => {
    const p = home + "/.ave/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^<home>/);
    expect(result).not.toContain(home);
  });

  itIfHome("replaces home-dir prefix in a file:// URL (pathToFileURL format)", () => {
    // Use pathToFileURL so fixtures match native file URL encoding.
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
    // Astral characters verify code-point rather than UTF-16-unit caps.
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
    const winHome = home.replace(/\//g, "\\");
    const p = winHome + "\\AppData\\Roaming\\ave\\plugins\\foo.js";
    const result = redactFsPath(p);
    // Backslash home paths only match on Windows; other platforms can assert only safe return shape.
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
