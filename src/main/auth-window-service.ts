import { rememberPluginAuthPartition } from "./plugin-auth-partition-tracker.js";
export { wirePluginAuthPartitionPersistence, seedPluginAuthPartitions, rememberPluginAuthPartition, getTrackedPluginAuthPartitions, forgetTrackedPluginAuthPartitions } from "./plugin-auth-partition-tracker.js";
// The host owns login-window lifecycle; plugins supply completion patterns and cookie-domain allowlists.
import { randomBytes } from "node:crypto";
import { BrowserWindow, dialog, screen, session, shell, type Cookie, type Session, type WebContents } from "electron";
import { attachAuthWindowContent, authWindowChromeOptions, buildAuthWindowShellHtml, installAuthSessionPermissions, type AuthNavigationFailure } from "./auth-window-content.js";
export { buildAuthWindowShellHtml } from "./auth-window-content.js";
import { isOAuthBrowserRefusal, requiresSystemBrowser } from "./oauth-login.js";
import { resolveAppIconPath } from "./app-icon.js";
import { configureAuthWebviewAttach } from "./plugin-webview-attach.js";
import {
  withAuthPartitionViewersClosed,
} from "./auth-partition-viewer-service.js";
import { applyBrowserSessionIdentity } from "./browser-user-agent.js";
import { normalizeCookieDomain } from "./auth-partition-cookie-jar.js";
import {
  normalizeAllowedHosts,
  normalizeHost,
  urlHostMatchesAllowList,
} from "./host-allow-list.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { t } from "../i18n/index.js";
import type { OAuthLoginOptions } from "./oauth-login.js";

const log = createLogger("auth-window");

function isDevConsoleEnabled(): boolean {
  return process.env.AVE_DEV_CONSOLE === "1";
}

export interface AuthCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  // Unix seconds. Omitted for session cookies.
  expirationDate?: number;
}

export interface OpenAuthWindowOptions {
  // Initial load URL, usually the external portal SSO entry point.
  url: string;
  // Login is considered complete when the current URL contains any of these substrings. Callers must choose precise patterns so still-in-SSO paths like `sso` are not matched.
  completionUrlPatterns: string[];
  // Domain suffixes for cookies to collect, e.g. `["sso.example.com", "portal.example.com"]`. Returned cookies must have `cookie.domain` ending in one of
  // these suffixes. Concrete domains are supplied by the caller/plugin; host code does not hardcode corp domains.
  cookieHosts: string[];
  // Login timeout. Defaults to five minutes.
  timeoutMs?: number;
  // Window title. Defaults to "Login".
  windowTitle?: string;
  // Opt-in result shape for OAuth-style callbacks where the plugin needs the final callback URL (for example a fragment token) in addition to cookies.
  // Default preserves the legacy AuthCookie[] return contract.
  returnFinalUrl?: boolean;
  // Each default call uses a fresh in-memory partition; explicitly reuse a persistent plugin-scoped partition for session storage.
  persistPartition?: string;
  // Hidden warmups still navigate and harvest cookies; require a finite timeout so a hidden challenge cannot hang indefinitely.
  show?: boolean;
  // Vault mode redacts returned values to empty strings while preserving cookie metadata; real values stay in the persistent partition for hostFetch.
  retainCookies?: boolean;
}

export interface OpenAuthWindowResult {
  cookies: AuthCookie[];
  // The URL that matched completionUrlPatterns. May contain a fragment token, so host code must never include this value in logs or error messages.
  finalUrl: string;
}

// Deduplicate visible windows by partition plus title; focus and await an existing request. Hidden bounded warmups remain independent.
const inFlightVisibleAuthWindows = new Map<
  string,
  { window: BrowserWindow; promise: Promise<AuthCookie[] | OpenAuthWindowResult> }
>();

function authWindowDedupKey(effectivePartition: string, windowTitle: string): string {
  return `${effectivePartition}\u0000${windowTitle}`;
}

// Use shared host matching and idempotent normalization so direct callers and cookie-domain spellings obey the same allowlist.
export function filterCookiesByHost(cookies: Cookie[], allowedHosts: string[]): AuthCookie[] {
  return selectCookiesByHost(cookies, allowedHosts).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
}

// The allow-list half of `filterCookiesByHost`, kept as Electron `Cookie`s with every attribute intact (`hostOnly`, `sameSite`) for the write-back into
// the partition, which the plugin-facing `AuthCookie` shape does not carry.
function selectCookiesByHost(cookies: Cookie[], allowedHosts: string[]): Cookie[] {
  const normalizedAllowed = allowedHosts
    .map(normalizeHost)
    .filter((h) => h.length > 0);
  if (normalizedAllowed.length === 0) return [];
  return cookies.filter((c) => {
    if (!c.domain) return false;
    // Electron cookie domains may include a leading dot (".example.com"); `urlHostMatchesAllowList` normalizes the probe host internally.
    return urlHostMatchesAllowList(c.domain, normalizedAllowed);
  });
}

// Returns true when the URL's `origin + pathname` contains a completion pattern. Query/hash are intentionally excluded so IdP parameters like
// RelayState, continue, or returnTo cannot embed a destination URL and create a false "complete" verdict while still on the IdP domain.
export function isCompletionUrl(url: string, patterns: readonly string[]): boolean {
  const target = extractCompletionTarget(url);
  return patterns.some((p) => target.includes(p));
}

export function shouldGraceCollectClosedAuthWindow(input: {
  webviewAttached: boolean;
  lastCommittedUrl: string | null;
  completionPatterns: readonly string[];
}): boolean {
  return (
    input.webviewAttached &&
    input.lastCommittedUrl !== null &&
    isCompletionUrl(input.lastCommittedUrl, input.completionPatterns)
  );
}

// URL for host-visible diagnostics only; strips query/hash to avoid token leaks.
export function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const q = url.indexOf("?");
    const h = url.indexOf("#");
    const cut =
      q === -1 ? h : h === -1 ? q : Math.min(q, h);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

// Redact cookie VALUES for `retainCookies` mode: keep name/domain/path (so existence and count checks work) but blank the value, which stays only in the
// persistent partition. A no-op when `retain` is false.
export function redactCookieValues(cookies: AuthCookie[], retain: boolean): AuthCookie[] {
  if (!retain) return cookies;
  return cookies.map((cookie) => ({ ...cookie, value: "" }));
}

// Session cookies otherwise disappear at process exit even in persist partitions; bound retained expiry while upstream still controls session validity.
export const RETAINED_SESSION_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Retain only cookies without upstream expiry, preserve host-only and Secure attributes, and flush before teardown.
// Values stay in the same host partition; persistence failures propagate to the caller.
export async function retainSessionCookiesAcrossRestart(
  ses: Pick<Session, "cookies">,
  cookies: readonly Cookie[],
  nowMs: number = Date.now(),
): Promise<number> {
  const targets = cookies.flatMap((cookie) => {
    const host = normalizeCookieDomain(cookie.domain);
    return typeof cookie.expirationDate !== "number" && host ? [{ cookie, host }] : [];
  });
  if (targets.length === 0) return 0;
  const expirationDate = Math.floor(nowMs / 1000) + RETAINED_SESSION_COOKIE_TTL_SECONDS;
  for (const { cookie, host } of targets) {
    const path = cookie.path ?? "/";
    await ses.cookies.set({
      url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate,
    });
  }
  await ses.cookies.flushStore();
  return targets.length;
}

// Redact cookie values before choosing either result shape so finalUrl cannot bypass vault mode.
export function buildAuthResult(
  cookies: AuthCookie[],
  finalUrl: string,
  returnFinalUrl: boolean,
  retainCookies = false,
): AuthCookie[] | OpenAuthWindowResult {
  const shaped = redactCookieValues(cookies, retainCookies);
  return returnFinalUrl ? { cookies: shaped, finalUrl } : shaped;
}

function extractCompletionTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // If URL construction fails, strip query/hash manually.
    const q = url.indexOf("?");
    const h = url.indexOf("#");
    const cut =
      q === -1 ? h : h === -1 ? q : Math.min(q, h);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

// Open the target URL, wait until a completion pattern is reached, then collect cookies. The window is always closed. Rejects if the user closes it early.
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions & { returnFinalUrl: true },
): Promise<OpenAuthWindowResult>;
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions & { returnFinalUrl?: false | undefined },
): Promise<AuthCookie[]>;
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
): Promise<AuthCookie[] | OpenAuthWindowResult>;
export async function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
): Promise<AuthCookie[] | OpenAuthWindowResult> {
  return openAuthWindowInternal(parent, options);
}

/** OAuth uses the same isolated shell; only the host listener can complete it. */
export async function openOAuthInAuthWindow(
  parent: BrowserWindow,
  url: string,
  options: OAuthLoginOptions,
): Promise<void> {
  try {
    if (requiresSystemBrowser(url)) {
      await openSystemBrowserLogin(parent, url, options);
      return;
    }
    await openAuthWindowInternal(parent, {
      url, completionUrlPatterns: [], cookieHosts: [], timeoutMs: options.timeoutMs,
      windowTitle: t("oauthWindow.title"),
    }, options);
  } catch (error) {
    options.onCancel();
    throw error;
  }
}

async function announceSystemBrowserLogin(parent: BrowserWindow, url: string): Promise<void> {
  void dialog.showMessageBox(parent, {
    type: "info", title: t("oauthWindow.title"), message: t("oauthWindow.systemBrowser"),
  }).catch(() => undefined);
  await shell.openExternal(url);
}

async function openSystemBrowserLogin(parent: BrowserWindow, url: string, options: OAuthLoginOptions): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      options.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OAuth login timeout")), options.timeoutMs);
      }),
      announceSystemBrowserLogin(parent, url).then(() => options.completion),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openAuthWindowInternal(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
  oauth?: OAuthLoginOptions,
): Promise<AuthCookie[] | OpenAuthWindowResult> {
  const policy = {
    harvestCookies: !oauth, clearOnClose: Boolean(oauth), escalateOnRefusal: true,
    devConsole: !oauth && isDevConsoleEnabled(), completion: oauth?.completion,
  };
  const {
    url,
    completionUrlPatterns,
    cookieHosts,
    windowTitle = "Login",
    persistPartition,
    returnFinalUrl = false,
    retainCookies = false,
    show: showRequested = true,
  } = options;
  // Silent warmups (show:false) MUST pair with an explicit timeoutMs so an invisible challenge page can't hang forever. Reject the combination early so
  // the caller surface is unambiguous.
  if (showRequested === false && options.timeoutMs === undefined) {
    throw new Error(
      "openAuthWindow: when show is false, timeoutMs is required (silent warmup must bound itself)",
    );
  }

  // Validate timeoutMs; reject NaN, Infinity, negative, and excessive values. Default is five minutes; maximum is 30 minutes, matching the manifest schema cap.
  const DEFAULT_TIMEOUT_MS = 5 * 60_000;
  const MAX_TIMEOUT_MS = 30 * 60_000;
  const MIN_TIMEOUT_MS = 1_000;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (options.timeoutMs !== undefined) {
    const t = options.timeoutMs;
    if (!Number.isFinite(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `openAuthWindow: timeoutMs must be a finite number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
    timeoutMs = Math.floor(t);
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("openAuthWindow: invalid url");
  }

  // Drop empty/blank string entries. Any remaining empty string would make `isCompletionUrl` substring matching always true, incorrectly treating auth as
  // complete and collecting cookies too early.
  const normalizedCompletionPatterns = (
    Array.isArray(completionUrlPatterns) ? completionUrlPatterns : []
  )
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (policy.harvestCookies && normalizedCompletionPatterns.length === 0) {
    throw new Error("openAuthWindow: completionUrlPatterns must be a non-empty array of non-blank strings");
  }

  // Validate cookieHosts with the shared viewer allowlist before creating any window or partition; reject broad suffixes and punycode spoofing.
  let normalizedCookieHosts: string[];
  try {
    // `allowLoopback` — OAuth loopback redirects (RFC 8252 §7.3) legitimately declare `localhost`/`127.0.0.1` here, and loopback cookies cannot leave the
    // machine, so admitting the literals does not widen the exfiltration surface the strict single-label rule guards.
    normalizedCookieHosts = normalizeAllowedHosts(
      (Array.isArray(cookieHosts) ? cookieHosts : []).filter(
        (h): h is string => typeof h === "string",
      ),
      { allowLoopback: true },
    );
  } catch (err) {
    throw new Error(
      `openAuthWindow: cookieHosts rejected — ${errorMessage(err)}`,
    );
  }
  if (policy.harvestCookies && normalizedCookieHosts.length === 0) {
    throw new Error("openAuthWindow: cookieHosts must be a non-empty array of non-blank strings");
  }

  // When `persistPartition` is omitted, isolate the call with a fresh in-memory partition instead of Electron's default session. The plugin runtime
  // already injects a per-plugin default, but this also protects direct service callers such as host-internal auth flows.
  const effectivePartition =
    persistPartition && persistPartition.length > 0
      ? persistPartition
      : `ephemeral-auth-${randomBytes(8).toString("hex")}`;
  rememberPluginAuthPartition(effectivePartition);
  const partitionSession = session.fromPartition(effectivePartition);
  installAuthSessionPermissions(partitionSession);
  applyBrowserSessionIdentity(partitionSession);

  // Idempotency guard — a single visible auth window per (partition, title). Silent warmups (show:false) are never deduped: they are invisible and may
  // overlap an interactive login. For visible calls, focus + await an already open/in-flight window instead of spawning a duplicate.
  const dedupKey = authWindowDedupKey(effectivePartition, windowTitle);
  const dedupEligible = showRequested !== false;
  if (dedupEligible) {
    const existing = inFlightVisibleAuthWindows.get(dedupKey);
    if (existing && !existing.window.isDestroyed()) {
      log.info(
        { phase: "dedup", partition: effectivePartition, windowTitle },
        `[auth-window:dedup] reusing in-flight visible auth window for partition=${effectivePartition} title=${windowTitle}`,
      );
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      return existing.promise;
    }
    // Stale entry (window already destroyed but not yet cleaned up) — drop it so the fresh window below registers cleanly.
    if (existing) inFlightVisibleAuthWindows.delete(dedupKey);
  }

  // Remote pages and their child windows share an isolated session without host privileges.
  const authWindow = new BrowserWindow({
    parent,
    modal: false,
    width: 1024,
    height: 768,
    title: windowTitle,
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    // Native controls keep both login lanes independent of host IPC capabilities.
    ...authWindowChromeOptions(),
    // Explicit show:false suppresses initial display and later web-content focus while still permitting navigation and harvest.
    show: showRequested,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true,
    },
  });
  authWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    configureAuthWebviewAttach({ event, webPreferences: webPreferences as Record<string, unknown>, params, url, partition: effectivePartition });
  });
  // Centering only matters for visible windows; skip the geometry math when the caller asked for a hidden warmup.
  if (showRequested) centerAuthWindowOnScreen(authWindow);
  if (typeof authWindow.setMenu === "function") authWindow.setMenu(null);

  let authContents: WebContents | null = null;
  let content: ReturnType<typeof attachAuthWindowContent>;
  let partitionCleanup: Promise<void> | undefined;
  const cleanUp = (): Promise<void> => partitionCleanup ??= (async () => {
    await content.close();
    if (policy.clearOnClose) {
      if (!authWindow.isDestroyed()) authWindow.destroy();
      await Promise.all([partitionSession.clearStorageData(), partitionSession.clearCache(), partitionSession.clearAuthCache()]);
    }
  })();

  // Record close timing, URL, and reason to distinguish early external closes from navigation races.
  const createdAtMs = Date.now();
  const sinceCreated = (): number => Date.now() - createdAtMs;
  const sanitizedOpenUrl = sanitizeUrlForLog(url);
  // Use committed top-level navigation for grace collection; page script can spoof diagnostic lastSeenUrl with history changes.
  let lastSeenUrl: string | null = null;
  let lastCommittedUrl: string | null = null;
  let webviewAttached = false;
  log.info(
    {
      phase: "open",
      url: sanitizedOpenUrl,
      partition: effectivePartition,
      showRequested,
      timeoutMs,
      completionPatternCount: normalizedCompletionPatterns.length,
      cookieHostCount: normalizedCookieHosts.length,
    },
    `[auth-window:open] url=${sanitizedOpenUrl} partition=${effectivePartition} show=${showRequested} timeoutMs=${timeoutMs}`,
  );

  const authPromise = new Promise<AuthCookie[] | OpenAuthWindowResult>((resolve, reject) => {
    let settled = false;
    let handedOff = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const handOff = (authorizationUrl: string): void => {
      if (handedOff || settled) return;
      handedOff = true;
      if (!authWindow.isDestroyed()) authWindow.close();
      log.info(`[auth-window:system-browser] ${new URL(authorizationUrl).host}`);
      void cleanUp().then(() => announceSystemBrowserLogin(parent, url)).then(() => {
        if (!policy.harvestCookies) return;
        finish(() => {
          clearTimeout(timer);
          reject(new Error("Login continued in the system browser; session cookies are unavailable"));
        });
      }, () => {
        finish(() => {
          clearTimeout(timer);
          reject(new Error("Unable to open the system browser"));
        });
      });
    };
    const escalate = (authorizationUrl: string): boolean => {
      if (!policy.escalateOnRefusal || !isOAuthBrowserRefusal(authorizationUrl)) return false;
      handOff(authorizationUrl);
      return true;
    };

    if (policy.completion) {
      void policy.completion.then(() => {
        finish(() => {
          clearTimeout(timer);
          resolve([]);
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      }, () => {
        finish(() => {
          clearTimeout(timer);
          reject(new Error("OAuth login did not complete"));
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      });
    }

    const timer = setTimeout(() => {
      finish(() => {
        log.warn(
          {
            phase: "close",
            closeReason: "timeout",
            elapsedMs: sinceCreated(),
            lastSeenUrl: lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : null,
            webviewAttached,
          },
          `[auth-window:timeout] url=${sanitizedOpenUrl} elapsedMs=${sinceCreated()} lastSeenUrl=${lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : "none"} webviewAttached=${webviewAttached}`,
        );
        reject(new Error(`openAuthWindow: login timeout after ${timeoutMs}ms`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    }, timeoutMs);

    // Retain session cookies at harvest; failure affects next-launch durability without invalidating the current login. Log counts only.
    const retainAcrossRestart = async (ses: Pick<Session, "cookies">, allCookies: Cookie[]) => {
      if (!retainCookies) return;
      const scoped = selectCookiesByHost(allCookies, normalizedCookieHosts);
      try {
        const retained = await retainSessionCookiesAcrossRestart(ses, scoped);
        log.debug(
          {
            phase: "harvest",
            partition: effectivePartition,
            cookieCount: scoped.length,
            sessionCookiesMadeDurable: retained,
          },
          `[auth-window:retain] partition=${effectivePartition} cookies=${scoped.length} sessionCookiesMadeDurable=${retained}`,
        );
      } catch (err) {
        const errMsg = errorMessage(err);
        log.warn(
          {
            phase: "harvest",
            partition: effectivePartition,
            cookieCount: scoped.length,
            errorMessage: errMsg,
          },
          `[auth-window:retain-failed] partition=${effectivePartition} cookies=${scoped.length} err=${errMsg} — the session will not survive a restart`,
        );
      }
    };

    // One harvest at a time. The attach-time probe, `did-navigate`, `did-navigate-in-page` and the ERR_ABORTED re-check can all fire on the same completion
    // URL; the first harvest settles the promise, so the overlapping ones would only repeat the partition write-back.
    let harvesting = false;
    const checkAndCollect = async (contents = authContents) => {
      if (!policy.harvestCookies) return;
      if (settled || handedOff || harvesting) return;
      if (!contents || contents.isDestroyed()) return;
      const currentUrl = contents.getURL();
      if (!isCompletionUrl(currentUrl, normalizedCompletionPatterns)) return;
      harvesting = true;
      try {
        const harvestSession = contents.session as Session;
        const allCookies = await harvestSession.cookies.get({});
        const filtered = filterCookiesByHost(allCookies, normalizedCookieHosts);
        await retainAcrossRestart(harvestSession, allCookies);
        finish(() => {
          clearTimeout(timer);
          resolve(buildAuthResult(filtered, currentUrl, returnFinalUrl, retainCookies));
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      } catch (err) {
        finish(() => {
          clearTimeout(timer);
          reject(err as Error);
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      } finally {
        harvesting = false;
      }
    };

    // F12 / Cmd+Alt+I → open native Chromium DevTools on the webview. Eruda is fine for read-only inspection but native DevTools is needed for network panel
    // / breakpoints when the login flow misbehaves.
    if (policy.devConsole) {
      authWindow.webContents.on("before-input-event", (_event, input) => {
        const isF12 = input.key === "F12" && input.type === "keyDown";
        const isCmdAltI =
          input.type === "keyDown" &&
          (input.meta || input.control) &&
          input.alt &&
          (input.key === "i" || input.key === "I");
        if (!(isF12 || isCmdAltI)) return;
        if (authContents && !authContents.isDestroyed()) {
          authContents.openDevTools({ mode: "detach" });
        } else if (!authWindow.isDestroyed()) {
          authWindow.webContents.openDevTools({ mode: "detach" });
        }
      });
    }

    // Fail real main-frame load errors promptly; ignore subresource failures and benign ERR_ABORTED redirects unless completion already matches.
    const ERR_ABORTED = -3;
    const failReject = (errorCode: number, validatedUrl: string) =>
      finish(() => {
        clearTimeout(timer);
        log.warn(
          {
            phase: "close",
            closeReason: "did-fail-load",
            errorCode,
            errorDescription: "Navigation failed",
            url: sanitizeUrlForLog(validatedUrl),
            elapsedMs: sinceCreated(),
          },
          `[auth-window:fail-load] errorCode=${errorCode} desc=Navigation failed url=${sanitizeUrlForLog(validatedUrl)} elapsedMs=${sinceCreated()}`,
        );
        reject(
          new Error(
            `openAuthWindow: navigation failed (${errorCode} Navigation failed) url=${sanitizeUrlForLog(validatedUrl)}`,
          ),
        );
        if (!authWindow.isDestroyed()) authWindow.close();
      });

    // Read canonical event error fields; deprecated positional args can be empty and silently disable fast failure.
    const onFailLoad = (event: AuthNavigationFailure) => {
      if (!event.isMainFrame) return;
      // The failed connection stays blocked while the trusted chrome shows the certificate error.
      if (event.errorCode <= -200 && event.errorCode > -300) return;
      if (event.errorCode === ERR_ABORTED) {
        // Benign redirect/page-transition cancel. Re-check completion and resolve through cookie collection when possible; otherwise ignore it.
        void checkAndCollect();
        return;
      }
      failReject(event.errorCode, event.validatedURL);
    };

    content = attachAuthWindowContent({
      window: authWindow, session: partitionSession, partition: effectivePartition,
      title: windowTitle, url, devConsole: policy.devConsole,
      active: () => !settled && !handedOff,
      onRefusal: escalate,
      onNavigation: (navUrl, committed) => {
        lastSeenUrl = navUrl;
        if (committed) lastCommittedUrl = navUrl;
        log.info({ url: sanitizeUrlForLog(navUrl), committed }, "[auth-window:navigate]");
      },
      onCheck: contents => { void checkAndCollect(contents); },
      onAttached: contents => { authContents = contents; webviewAttached = true; },
      onFailure: onFailLoad,
    });
    authWindow.webContents.on("did-fail-load", onFailLoad as never);
    authWindow.webContents.on("did-fail-provisional-load", onFailLoad as never);

    authWindow.webContents.on("render-process-gone", (_e, details) => {
      finish(() => {
        clearTimeout(timer);
        log.warn(
          {
            phase: "close",
            closeReason: "render-process-gone",
            reason: details.reason,
            elapsedMs: sinceCreated(),
            url: sanitizedOpenUrl,
          },
          `[auth-window:render-process-gone] reason=${details.reason} elapsedMs=${sinceCreated()} url=${sanitizedOpenUrl}`,
        );
        reject(new Error(`openAuthWindow: render process gone (${details.reason})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });

    authWindow.on("closed", () => {
      if (settled || handedOff) return;
      clearTimeout(timer);
      // On an early SSO close, retry partition cookies only after a committed top-level completion URL; history changes are not trusted.
      const lastUrlSanitized = lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : null;
      const lastCommittedSanitized = lastCommittedUrl
        ? sanitizeUrlForLog(lastCommittedUrl)
        : null;
      const isGraceEligible = policy.harvestCookies && shouldGraceCollectClosedAuthWindow({
        webviewAttached,
        lastCommittedUrl,
        completionPatterns: normalizedCompletionPatterns,
      });
      if (isGraceEligible && lastCommittedUrl) {
        const capturedUrl = lastCommittedUrl;
        const partitionSession = session.fromPartition(effectivePartition);
        log.warn(
          {
            phase: "close",
            closeReason: "closed-event",
            graceCollectAttempt: true,
            url: sanitizedOpenUrl,
            lastSeenUrl: lastUrlSanitized,
            lastCommittedUrl: lastCommittedSanitized,
            webviewAttached,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:closed-grace-collect] url=${sanitizedOpenUrl} committed=${lastCommittedSanitized} elapsedMs=${sinceCreated()} — attempting grace cookie fetch`,
        );
        void (async () => {
          try {
            const allCookies = await partitionSession.cookies.get({});
            const filtered = filterCookiesByHost(allCookies, normalizedCookieHosts);
            await retainAcrossRestart(partitionSession, allCookies);
            finish(() => {
              log.info(
                {
                  phase: "close",
                  closeReason: "closed-event-grace-resolved",
                  cookieCount: filtered.length,
                  elapsedMs: sinceCreated(),
                },
                `[auth-window:closed-grace-resolved] cookies=${filtered.length} elapsedMs=${sinceCreated()}`,
              );
              resolve(buildAuthResult(filtered, capturedUrl, returnFinalUrl, retainCookies));
            });
          } catch (err) {
            const errMsg = errorMessage(err);
            finish(() => {
              log.warn(
                {
                  phase: "close",
                  closeReason: "closed-event-grace-failed",
                  errorMessage: errMsg,
                  elapsedMs: sinceCreated(),
                },
                `[auth-window:closed-grace-failed] err=${errMsg} elapsedMs=${sinceCreated()}`,
              );
              reject(new Error(`openAuthWindow: window closed before login completed (grace fetch failed: ${errMsg})`));
            });
          }
        })();
        return;
      }
      finish(() => {
        log.warn(
          {
            phase: "close",
            closeReason: "closed-event",
            graceCollectAttempt: false,
            url: sanitizedOpenUrl,
            lastSeenUrl: lastUrlSanitized,
            lastCommittedUrl: lastCommittedSanitized,
            webviewAttached,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:closed-before-completion] url=${sanitizedOpenUrl} lastSeenUrl=${lastUrlSanitized ?? "none"} committed=${lastCommittedSanitized ?? "none"} webviewAttached=${webviewAttached} elapsedMs=${sinceCreated()}`,
        );
        reject(new Error("openAuthWindow: window closed before login completed"));
      });
    });

    const html = buildAuthWindowShellHtml({
      title: windowTitle,
      url,
      partition: effectivePartition,
      platform: process.platform,
      devConsole: policy.devConsole,
    });
    authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err) => {
      finish(() => {
        clearTimeout(timer);
        const errName = (err as Error).name || "Error";
        log.warn(
          {
            phase: "close",
            closeReason: "load-url-failed",
            url: sanitizedOpenUrl,
            errorName: errName,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:load-url-failed] url=${sanitizedOpenUrl} err=${errName} elapsedMs=${sinceCreated()}`,
        );
        reject(new Error(`openAuthWindow: load failed for ${sanitizeUrlForLog(url)} (${errName})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });
  });

  // Register the visible window for dedup and clean up on settle / teardown so a later open finds either a live window to focus or no stale entry. Only
  // remove our own entry (a fresh window for the same key may have replaced it).
  if (dedupEligible) {
    const clearOwnEntry = (): void => {
      const current = inFlightVisibleAuthWindows.get(dedupKey);
      if (current?.window === authWindow) inFlightVisibleAuthWindows.delete(dedupKey);
    };
    inFlightVisibleAuthWindows.set(dedupKey, { window: authWindow, promise: authPromise });
    // Remove dedup entries on window teardown; chaining finally on authPromise would create an unhandled derived rejection.
    authWindow.on("closed", clearOwnEntry);
    authWindow.webContents.on("render-process-gone", clearOwnEntry);
  }

  try {
    return await authPromise;
  } finally {
    await cleanUp();
  }
}

// Auth windows are centered in the primary display work area. The previous behavior followed the host parent position, which clipped auth windows when
// the host was near a screen edge and forced users to move them manually.
function centerAuthWindowOnScreen(authWindow: BrowserWindow): void {
  if (authWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height } = authWindow.getBounds();
  authWindow.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + (workArea.height - height) / 2),
  );
}

// Sign-out must clear storage and separately clear HTTP/NTLM/Kerberos auth cache to prevent residual silent SSO.
// Plugin callers are namespace-validated upstream; direct host callers must scope the partition themselves.
export async function clearAuthPartition(partition: string): Promise<void> {
  if (typeof partition !== "string" || partition.length === 0) {
    throw new Error("clearAuthPartition: partition must be a non-empty string");
  }
  await withAuthPartitionViewersClosed(partition, async () => {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData({
      storages: [
        "cookies",
        "filesystem",
        "indexdb",
        "localstorage",
        "shadercache",
        "serviceworkers",
        "cachestorage",
      ],
    });
    await ses.clearCache();
    if (typeof ses.clearAuthCache === "function") {
      await ses.clearAuthCache();
    }
  });
}
