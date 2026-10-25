/** Share credential probes across scrubber, IPC, and copied diagnostics so every layer covers the same spellings. */
export interface DiagnosticSecretProbe {
  id: string;
  text: string;
  secret: string;
  address?: true;
  /** Text around the secret that must come through unchanged. */
  kept?: string;
}

const midLine = (id: string, assignment: string): DiagnosticSecretProbe => ({ id, text: `helper failed: ${assignment}; retry`, secret: "canarypass" });

export const DIAGNOSTIC_SECRET_PROBES: readonly DiagnosticSecretProbe[] = [
  { id: "https-password", text: "https://alice:verifier-secret@example.com/owner/repo", secret: "verifier-secret", address: true },
  { id: "ssh-password", text: "ssh://user:canarypass@host/repo", secret: "canarypass", address: true },
  { id: "compound-scheme-token", text: "git+https://opaque-canary-value@host/repo", secret: "opaque-canary-value", address: true },
  { id: "x-access-token", text: "https://x-access-token:canarypass@host/repo", secret: "canarypass", address: true },
  { id: "percent-encoded-https", text: "https://ali%63e:%63%61%6E%61%72%79@host/repo", secret: "%63%61%6E%61%72%79", address: true },
  // The URL pass's marker in a quoted string is not a credential key: `: 401` stays.
  { id: "embedded-url", text: "fatal: unable to access 'https://alice:canarypass@host/repo': 401", secret: "canarypass", kept: "@host/repo': 401" },
  { id: "svn-ssh", text: "svn+ssh://user:canarypass@host/repo", secret: "canarypass" },
  { id: "upper-compound-scheme", text: "HTTPS+git://canarypass@host/repo", secret: "canarypass" },
  { id: "ssh-3A", text: "ssh://user%3Acanarypass@host/org/repo", secret: "canarypass", address: true },
  { id: "ssh-3a", text: "ssh://user%3acanarypass@host/org/repo", secret: "canarypass", address: true },
  { id: "ssh-40", text: "ssh://user%40canarypass@host/org/repo", secret: "canarypass", address: true },
  { id: "ssh-ZZ", text: "ssh://user%ZZcanarypass@host/org/repo", secret: "canarypass", address: true },
  { id: "ssh-double-encoded", text: "ssh://user%253Acanarypass@host/repo", secret: "canarypass" },
  { id: "ssh-encoded-slash", text: "ssh://user%2Fcanarypass@host/repo", secret: "canarypass" },
  { id: "scp-password", text: "user:canarypass@host:org/repo", secret: "canarypass", address: true },
  { id: "scp-3A", text: "user%3Acanarypass@host:org/repo", secret: "canarypass", address: true },
  { id: "scp-3a", text: "user%3acanarypass@host:org/repo", secret: "canarypass", address: true },
  { id: "scp-40", text: "user%40canarypass@host:org/repo", secret: "canarypass", address: true },
  { id: "scp-ZZ", text: "user%ZZcanarypass@host:org/repo", secret: "canarypass", address: true },
  { id: "scp-double-encoded", text: "clone of user%253Acanarypass@host:org/repo failed", secret: "canarypass" },
  midLine("double-quoted", 'token="canarypass"'),
  midLine("single-quoted", "token='canarypass'"),
  midLine("single-quoted-password", "password='canarypass'"),
  midLine("escaped-double", 'token="prefix\\"canarypass"'),
  midLine("escaped-single", "token='prefix\\'canarypass'"),
  { id: "unclosed", text: 'helper failed: token="canarypass', secret: "canarypass" },
  { id: "unclosed-escaped", text: 'helper failed: token="prefix\\"canarypass', secret: "canarypass" },
  { id: "json-token", text: 'helper failed: {"token": "canarypass"}', secret: "canarypass" },
  { id: "json-escaped", text: 'helper failed: {"token": "prefix\\"canarypass"}', secret: "canarypass" },
  { id: "json-api-key", text: 'helper failed: {"api_key":"canarypass","n":1}', secret: "canarypass" },
  { id: "json-single-quoted", text: "helper failed: {'client_secret': 'prefix\\'canarypass'}", secret: "canarypass" },
  { id: "separator-in-quoted-key", text: 'helper failed: {"prefix:token":"canarypass"}', secret: "canarypass" },
  { id: "equals-in-quoted-key", text: 'helper failed: "a=token" = canarypass', secret: "canarypass" },
  { id: "colon-in-single-quoted-key", text: "helper failed: 'x:password': 'canarypass'", secret: "canarypass" },
  { id: "json-newline-before-separator", text: 'helper failed: {"password"\n: "canarypass"}', secret: "canarypass" },
  { id: "json-newline-after-separator", text: 'helper failed: {"password":\n"canarypass"}', secret: "canarypass" },
  { id: "json-crlf-escaped-key-and-value", text: 'helper failed: {"pass\\u0077ord"\r\n:\r\n"prefix\\"canarypass"}', secret: "canarypass" },
  // An assignment inside a quoted key is redacted, and the key names a credential, so its value goes too.
  { id: "assignment-in-quoted-key", text: "remote: 'token=canarypass' : 403", secret: "canarypass" },
  // A value read inside a quoted key ends at the key's closing quote; the key's own value is redacted as well.
  { id: "colon-assignment-key", text: 'helper failed: {"token:label": "canarypass"}', secret: "canarypass" },
  { id: "equals-assignment-key", text: 'helper failed: {"token=label": "canarypass"}', secret: "canarypass" },
  { id: "assignment-key-newline-value", text: 'helper failed: {"token:label":\n"canarypass"}', secret: "canarypass" },
  { id: "single-quoted-assignment-key", text: "helper failed: {'password=a b': 'canarypass'}", secret: "canarypass" },
  { id: "nested-assignment-key", text: 'helper failed: "x:token=y": "canarypass"', secret: "canarypass" },
  { id: "json-escaped-key", text: 'helper failed: {"to\\u006ben":"canarypass"}', secret: "canarypass" },
  { id: "json-undecodable-key", text: 'helper failed: {"to\\qken":"canarypass"}', secret: "canarypass" },
  { id: "crlf-private-key", text: 'config: private_key="-----BEGIN PRIVATE KEY-----\r\nMIIEcanarypass\r\n-----END PRIVATE KEY-----"\r\nnext', secret: "canarypass" },
  { id: "multiline-double", text: 'helper failed: token="first line\ncanarypass"; retry', secret: "canarypass" },
  { id: "multiline-single", text: "helper failed: token='first line\ncanarypass'; retry", secret: "canarypass" },
  // JSON carried inside a JSON string: one level of `\"`.
  { id: "escaped-json-body", text: 'HTTP 401 body: "{\\"token\\":\\"canarypass\\"}"', secret: "canarypass" },
  { id: "escaped-json", text: '{\\"password\\": \\"canarypass\\"}', secret: "canarypass" },
  { id: "escaped-json-in-json", text: '{"body":"{\\"token\\":\\"canarypass\\"}"}', secret: "canarypass" },
  { id: "escaped-json-escaped-key", text: '{\\"n\\":\\"1\\",\\"to\\\\u006ben\\":\\"canarypass\\"}', secret: "canarypass" },
  // A value crossing into the next line, and keys a value or a marker hid.
  { id: "value-crosses-into-next-key", text: 'token:"\n"GH_TOKEN": "canarypass"', secret: "canarypass" },
  { id: "undecodable-key-next-line", text: '"C:\\dir":\ntoken: canarypass', secret: "canarypass" },
  { id: "value-was-next-key", text: '"token":\n\n"api_key"\n: "canarypass"', secret: "canarypass" },
  { id: "escaped-newline-in-value", text: 'apikey="\\\n GH_TOKEN="canarypass"', secret: "canarypass" },
  { id: "marker-only-key", text: '{"[REDACTED:TOKEN]": "canarypass"}', secret: "canarypass" },
  { id: "marker-prefixed-value", text: "helper: token=[REDACTED:TOKEN]canarypass", secret: "canarypass" },
  { id: "stray-quote-key", text: 'msg: "a":token":"canarypass"', secret: "canarypass" },
  { id: "escaped-json-as-key", text: '"{\\"token\\": \\"canarypass\\"}": 1', secret: "canarypass" },
  { id: "escaped-json-after-stray", text: 'path C:\\"dir x \\"token\\": \\"canarypass\\"', secret: "canarypass" },
  // Authorization, quoted or after `=`; a bare value starting with an auth scheme takes the credentials after it.
  { id: "authorization-quoted-basic", text: 'Authorization: "Basic dXNlcjpjYW5hcnlwYXNz"', secret: "dXNlcjpjYW5hcnlwYXNz" },
  { id: "authorization-quoted", text: 'Authorization: "dXNlcjpjYW5hcnlwYXNz"', secret: "dXNlcjpjYW5hcnlwYXNz" },
  { id: "authorization-single-quoted", text: "authorization='Basic dXNlcjpjYW5hcnlwYXNz'", secret: "dXNlcjpjYW5hcnlwYXNz" },
  { id: "authorization-equals", text: "Authorization=Basic dXNlcjpjYW5hcnlwYXNz", secret: "dXNlcjpjYW5hcnlwYXNz" },
  { id: "proxy-authorization", text: 'proxy-authorization="Basic dXNlcjpjYW5hcnlwYXNz"', secret: "dXNlcjpjYW5hcnlwYXNz" },
  { id: "authorization-bearer", text: "Authorization: Bearer canarypass", secret: "canarypass" },
  // An Authorization header's value is its line: every parameter of the scheme goes.
  { id: "authorization-digest", text: 'Authorization: Digest username="u", realm="r", nonce="n", uri="/", response="6629fae4canarypass"', secret: "canarypass" },
  { id: "authorization-digest-unquoted", text: "x: Authorization: Digest username=u, realm=r, response=6629fae4canarypass", secret: "canarypass" },
  { id: "proxy-authorization-digest", text: 'Proxy-Authorization: Digest username="u", response="6629fae4canarypass"', secret: "canarypass" },
  { id: "authorization-split-basic", text: "x: Authorization: Basic dXNlcjpj YW5hcnlwYXNz", secret: "YW5hcnlwYXNz" },
  { id: "basic-authorization", text: "Authorization: Basic YWxpY2U6Y2FuYXJ5cGFzcw==", secret: "YWxpY2U6Y2FuYXJ5cGFzcw==" },
  midLine("unquoted-token", "token=canarypass"),
  midLine("password", "password=canarypass"),
  midLine("passwd", "passwd=canarypass"),
  midLine("pwd", "pwd=canarypass"),
  midLine("secret", "secret=canarypass"),
  midLine("client-secret", "client_secret=canarypass"),
  midLine("api_key", "api_key=canarypass"),
  midLine("api-key-colon", "api-key: canarypass"),
  midLine("apikey", "apikey=canarypass"),
  midLine("API_KEY", "API_KEY=canarypass"),
  midLine("accessKey", "accessKey=canarypass"),
  midLine("private_key", 'private_key="canarypass"'),
  midLine("credentials", "credentials=canarypass"),
  midLine("credential", "aws.credential: canarypass"),
  midLine("auth-segment", "x-auth: canarypass"),
  midLine("AUTH", "AUTH=canarypass"),
  midLine("bearer", "bearer=canarypass"),
  midLine("GH_TOKEN", "GH_TOKEN=canarypass"),
  midLine("dotted-password", "db.password: canarypass"),
  // A bare value runs to whitespace, punctuation included.
  { id: "semicolon-suffix", text: "helper: password=prefix;canarypass", secret: "canarypass" },
  { id: "comma-suffix", text: "helper: password=prefix,canarypass rest", secret: "canarypass" },
  { id: "ampersand-suffix", text: "helper: token=prefix&canarypass rest", secret: "canarypass" },
  { id: "comma-then-space", text: "helper: password=a,canarypass c", secret: "canarypass" },
  { id: "flag-space", text: "helper --password canarypass --verbose", secret: "canarypass" },
  { id: "flag-equals", text: "helper --api-key=canarypass --verbose", secret: "canarypass" },
  { id: "flag-quoted", text: 'helper --token "prefix canarypass" --verbose', secret: "canarypass" },
];

/** Diagnostics that name no credential and must come through unchanged. */
export const DIAGNOSTIC_KEPT: readonly string[] = [
  "author=Jane Doe",
  "the tokenizer split the input",
  "oauth=enabled",
  "git@github.com:org/repo.git",
  "deploy-bot.1@git.example:acme/tools",
  "%67it@git.example:acme/tools",
  "ssh://git@git.example/acme/tools",
  "ssh://%67it@git.example/acme/tools",
  "connect to host:8080 refused",
  "Host key for [git.example]:2222 has changed",
  "mail alice@example.com",
  "git fetch --depth 1 --author Jane --verbose",
  "remote: 'see docs': 403",
  "token:\nnext line kept",
  "remote: unauthorized for host",
  '{"host":"::1","port":443}',
  '{"op":"=","value":3}',
  '"a":":x"',
  `x "a 'b "c": 1' : 2" : 3`,
];

/** Force a scrubber contract failure on the sentinel and return an undo callback. */
export function breakDiagnosticScrubberOn(sentinel: string): () => void {
  const original = RegExp.prototype[Symbol.replace] as (this: RegExp, input: string, replacement: unknown) => string;
  const broken = function (this: RegExp, input: string, replacement: unknown): string {
    if (typeof input === "string" && input.includes(sentinel)) throw new Error("injected diagnostic scrubber failure");
    return original.call(this, input, replacement);
  };
  Object.defineProperty(RegExp.prototype, Symbol.replace, { value: broken, configurable: true, writable: true });
  return () => Object.defineProperty(RegExp.prototype, Symbol.replace, { value: original, configurable: true, writable: true });
}
