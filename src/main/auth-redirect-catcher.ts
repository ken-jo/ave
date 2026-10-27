// Confined plugins cannot bind a browser-reachable loopback listener; the host owns OAuth redirect capture.
// openAuthWindow observes committed navigation and cannot reliably serve a refused loopback redirect.
// Plugins receive query parameters only and cannot choose the interface, port, response body, or accepted request shape.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex, timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import { createLogger } from "../lib/logger.js";
import { listenFetchLoopback } from "../shared/fetch-loopback-listener.js";

const log = createLogger("auth-redirect");

// Bounds. Each is a refusal rather than a truncation: a request that exceeds one is not a well-formed redirect from an identity provider, and treating
// it as one that merely needs trimming would be a guess about a credential path.
const MAX_QUERY_PARAMS = 32;
const MAX_PARAM_NAME_LENGTH = 128;
const MAX_PARAM_VALUE_LENGTH = 8192;
// A request line long enough to be an attack rather than a redirect.
const MAX_REQUEST_URL_LENGTH = 16 * 1024;

const DEFAULT_AUTH_REDIRECT_TIMEOUT_MS = 5 * 60_000;
const MIN_AUTH_REDIRECT_TIMEOUT_MS = 5_000;
const MAX_AUTH_REDIRECT_TIMEOUT_MS = 15 * 60_000;

// The parsed redirect. Query parameters only — see the file header.
export type AuthRedirectParams = Readonly<Record<string, string>>;

export interface AuthRedirectOpenResult {
  handle: string;
  // Providers register redirect hosts independently of ports; substituting 127.0.0.1 for localhost changes the registered identity.
  redirectUri: string;
  state: string;
}

interface LiveCatcher {
  handle: string;
  ownerKey: string;
  redirectUri: string;
  server: Server;
  state: string;
  // Set once the redirect arrives; read by a `wait` that comes in after it.
  received: AuthRedirectParams | null;
  // Whether what arrived was a refusal. Decided when the redirect lands, not when the landing page is served — by then the query is gone, because the 303
  // below is what removes it.
  receivedFailure: boolean;
  waiters: Array<{
    resolve: (params: AuthRedirectParams) => void;
    reject: (err: Error) => void;
  }>;
  closed: boolean;
}

// The redirect page reports success or provider error, not merely arrival; host-owned bilingual wording cannot be supplied by plugins.
function outcomePage(failed: boolean): string {
  const title = failed ? "로그인 실패 (Sign-in failed)" : "로그인 완료 (Sign-in complete)";
  const color = failed ? "#f87171" : "#60a5fa";
  const body = failed
    ? "이 창을 닫고 앱에서 다시 시도해 주세요. (You may close this window and try again.)"
    : "이 창을 닫고 앱으로 돌아가세요. (You may close this window.)";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>${failed ? "Sign-in failed" : "Sign-in complete"}</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
<h2 style="color:${color}">${title}</h2>
<p>${body}</p>
</body></html>`;
}

// Require a loopback Host header to block DNS rebinding; state authenticates every callback before completion.
function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const withoutPort = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return (
    withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "[::1]"
  );
}

// Parse the redirect's query string, refusing anything outside the bounds. Returns `null` when there is nothing to report yet — a bare `/` is the
// landing page the 303 below sends the browser to, not a redirect.
function parseRedirectParams(requestUrl: string, base: string): AuthRedirectParams | null {
  if (requestUrl.length > MAX_REQUEST_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl, base);
  } catch {
    return null;
  }
  const entries = [...parsed.searchParams.entries()];
  if (entries.length === 0) return null;
  if (entries.length > MAX_QUERY_PARAMS) return null;
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (name.length > MAX_PARAM_NAME_LENGTH) return null;
    if (value.length > MAX_PARAM_VALUE_LENGTH) return null;
    if (seen.has(name)) return null;
    seen.add(name);
    // Define own data properties so prototype-named parameters cannot invoke inherited setters.
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(out);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_AUTH_REDIRECT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) {
    throw new Error("authRedirect.wait: timeoutMs must be a finite number");
  }
  if (timeoutMs < MIN_AUTH_REDIRECT_TIMEOUT_MS || timeoutMs > MAX_AUTH_REDIRECT_TIMEOUT_MS) {
    throw new Error(
      `authRedirect.wait: timeoutMs must be between ${MIN_AUTH_REDIRECT_TIMEOUT_MS} and ${MAX_AUTH_REDIRECT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

// Allow one catcher per owner and refuse replacement so an in-flight sign-in cannot lose its redirect port.
export class AuthRedirectCatchers {
  private readonly byHandle = new Map<string, LiveCatcher>();
  private readonly byOwner = new Map<string, string>();

  // localhost matches registered redirect hosts; the IP-literal option follows RFC 8252 §7.3 arbitrary-port rules.
  // Both URI forms bind the listener to 127.0.0.1.
  // Internal host flows may supply their state; plugin callers always receive a fresh host-generated value.
  async open(ownerKey: string, options: { state?: string; redirectHost?: "localhost" | "127.0.0.1" } = {}): Promise<AuthRedirectOpenResult> {
    const state = options.state ?? randomBytes(32).toString("base64url");
    if (state.length === 0 || state.length > MAX_PARAM_VALUE_LENGTH) {
      throw new Error("authRedirect.open: state must be a non-empty bounded string");
    }
    if (this.byOwner.has(ownerKey)) {
      throw new Error(
        "authRedirect.open: a redirect catcher is already open for this plugin; close it before opening another",
      );
    }
    const handle = randomUUID();
    // Reserve the owner slot BEFORE the await. Two concurrent `open` calls would otherwise both pass the check above and both bind.
    this.byOwner.set(ownerKey, handle);
    try {
      const server = createServer();
      const port = await listenFetchLoopback(server);
      const redirectUri = `http://${options.redirectHost ?? "localhost"}:${port}`;
      const catcher: LiveCatcher = {
        handle,
        ownerKey,
        redirectUri,
        server,
        state,
        received: null,
        receivedFailure: false,
        waiters: [],
        closed: false,
      };
      server.on("request", (req, res) => this.onRequest(catcher, req, res));
      // A live listener must not hold the app open at quit.
      server.unref();
      this.byHandle.set(handle, catcher);
      return { handle, redirectUri, state };
    } catch (err) {
      this.byOwner.delete(ownerKey);
      throw err;
    }
  }

  private onRequest(catcher: LiveCatcher, req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const requestUrl = req.url ?? "/";
    const redirectPath = new URL(catcher.redirectUri).pathname;
    if (requestUrl === redirectPath && catcher.received !== null) {
      // Only a completed flow has a landing page, after removing the credential query.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(outcomePage(catcher.receivedFailure));
      return;
    }
    const params = parseRedirectParams(requestUrl, catcher.redirectUri);
    if (requestUrl.split("?", 1)[0] !== redirectPath || params === null || catcher.received !== null) {
      log.warn({ ownerKey: catcher.ownerKey, reason: "invalid-callback" }, "Rejected OAuth redirect callback");
      res.writeHead(404);
      res.end();
      return;
    }
    // Hash to fixed-size digests so unequal UTF-8 lengths still reach the timing-safe comparison.
    if (!timingSafeEqualHexDigest(sha256Hex(params.state ?? ""), sha256Hex(catcher.state))) {
      log.warn({ ownerKey: catcher.ownerKey, reason: "state-mismatch" }, "Rejected OAuth redirect callback");
      res.writeHead(404);
      res.end();
      return;
    }
    // Redirect the browser to the bare URI so the authorization code does not remain in history. The response the USER ends up looking at is the landing page above.
    res.writeHead(303, { location: catcher.redirectUri });
    res.end();
    catcher.received = params;
    // `error` is the OAuth 2.0 spelling (RFC 6749 §4.1.2.1) and the only one this layer reads. Which error it was is the caller's to interpret; that there
    // WAS one is what the page has to say.
    catcher.receivedFailure = typeof params.error === "string" && params.error.length > 0;
    const waiters = catcher.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(params);
  }

  // Resolve with the redirect's query parameters. Resolves immediately when the redirect already arrived, which is not a nicety: the browser can land
  // before the caller gets around to waiting, and a wait that only ever watched for a FUTURE arrival would hang on exactly the fast path.
  async wait(
    ownerKey: string,
    handle: string,
    timeoutMs?: number,
  ): Promise<AuthRedirectParams> {
    const catcher = this.requireOwned(ownerKey, handle, "wait");
    if (catcher.received !== null) return catcher.received;
    const boundedTimeoutMs = normalizeTimeoutMs(timeoutMs);
    return await new Promise<AuthRedirectParams>((resolve, reject) => {
      const waiter = {
        resolve: (params: AuthRedirectParams) => {
          clearTimeout(timer);
          resolve(params);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const index = catcher.waiters.indexOf(waiter);
        if (index >= 0) catcher.waiters.splice(index, 1);
        // Close on timeout. Leaving the port bound after the caller stopped waiting is a listener nobody owns, and the owner slot it holds would refuse the user's next attempt.
        this.close(ownerKey, handle);
        reject(new Error(`authRedirect.wait: no redirect received within ${boundedTimeoutMs}ms`));
      }, boundedTimeoutMs);
      catcher.waiters.push(waiter);
    });
  }

  // Release the listener. Idempotent — a close of an unknown handle is a no-op.
  close(ownerKey: string, handle: string): void {
    const catcher = this.byHandle.get(handle);
    if (catcher === undefined) return;
    if (catcher.ownerKey !== ownerKey) return;
    if (catcher.closed) return;
    catcher.closed = true;
    this.byHandle.delete(handle);
    if (this.byOwner.get(ownerKey) === handle) this.byOwner.delete(ownerKey);
    const waiters = catcher.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("authRedirect: the redirect catcher was closed"));
    }
    catcher.server.close();
    catcher.server.closeAllConnections?.();
  }

  // Close every catcher an owner holds. Used when a plugin is unloaded.
  closeAllFor(ownerKey: string): void {
    const handle = this.byOwner.get(ownerKey);
    if (handle !== undefined) this.close(ownerKey, handle);
  }

  private requireOwned(ownerKey: string, handle: string, member: string): LiveCatcher {
    const catcher = this.byHandle.get(handle);
    // ONE message for "no such handle" and "someone else's handle". Telling the two apart would let a plugin probe for another plugin's live sign-in.
    if (catcher === undefined || catcher.ownerKey !== ownerKey) {
      throw new Error(`authRedirect.${member}: unknown redirect-catcher handle`);
    }
    return catcher;
  }
}
