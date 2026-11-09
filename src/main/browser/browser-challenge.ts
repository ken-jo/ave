import type { BrowserChallenge, BrowserChallengeVendor } from "../../shared/browser-challenge.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { isRecord } from "../../shared/is-record.js";

interface ChallengeSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface ChallengeMarker {
  readonly vendor: BrowserChallengeVendor;
  readonly query: string;
  readonly pendingQuery?: string;
}

const WAITING_TITLE = /^(?:just a moment(?:\.{0,3}|…)?|잠시만\s*기다(?:리십시오|려\s*(?:주세요|주십시오))(?:\.{0,3}|…)?)$/iu;
const VERIFICATION_TITLE = /^(?:verify (?:that )?you are (?:a )?human|please verify you are (?:a )?human|human verification|security verification|access (?:to this page )?(?:has been )?denied|사람인지\s*확인해\s*주세요|보안\s*(?:확인|검증)|접근이\s*거부되었습니다)[.!…]*$/iu;
const MAX_TITLE_CHARS = 200;

// Fixed element queries exclude ordinary provider scripts and mentions in article text.
const CHALLENGE_MARKERS: readonly ChallengeMarker[] = [
  { vendor: "cloudflare", query: '//*[@id="cf-challenge" or @id="cf-challenge-running" or (self::form and @id="challenge-form" and contains(@action,"__cf_chl_"))]', pendingQuery: '//*[@id="cf-challenge" or @id="cf-challenge-running" or (self::form and @id="challenge-form" and contains(@action,"__cf_chl_")) or contains(concat(" ",normalize-space(@class)," ")," cf-turnstile ") or (self::iframe and starts-with(@src,"https://challenges.cloudflare.com/") and contains(@src,"/turnstile/"))]' },
  { vendor: "datadome", query: '//iframe[starts-with(@src,"https://geo.captcha-delivery.com/captcha/") or starts-with(@src,"https://geo.captcha-delivery.com/interstitial/") or starts-with(@src,"//geo.captcha-delivery.com/captcha/") or starts-with(@src,"//geo.captcha-delivery.com/interstitial/")]' },
  { vendor: "perimeterx", query: '//*[@id="px-captcha" and (descendant::iframe or descendant::button or @role="dialog")]', pendingQuery: '//*[@id="px-captcha"]' },
  { vendor: "akamai", query: '//*[@id="sec-cpt-container" or @id="sec-if-cpt-container" or (self::iframe and @id="sec-cpt-if")]' },
];

function challenge(vendor: BrowserChallengeVendor): BrowserChallenge {
  return { vendor, hint: "The user can solve it in the web panel." };
}

/** Optional fixed read-only annotation: one total budget, at most four searches, no page strings in executable input. */
export async function detectBrowserChallenge(cdp: ChallengeSession, title: string, signal?: AbortSignal): Promise<BrowserChallenge | undefined> {
  signal?.throwIfAborted();
  const heading = title.length <= MAX_TITLE_CHARS ? title.trim() : "";
  if (WAITING_TITLE.test(heading)) return challenge("cloudflare");
  const verification = VERIFICATION_TITLE.test(heading);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const probe = async (): Promise<BrowserChallenge | undefined> => {
    for (const marker of CHALLENGE_MARKERS) {
      if (stopped) return undefined;
      signal?.throwIfAborted();
      const response = await cdp.send("DOM.performSearch", { query: verification && marker.pendingQuery ? marker.pendingQuery : marker.query, includeUserAgentShadowDOM: false });
      const result = isRecord(response) ? response : {};
      const searchId = typeof result.searchId === "string" && result.searchId.length > 0 ? result.searchId : undefined;
      try {
        if (stopped) return undefined;
        signal?.throwIfAborted();
        if (!searchId || typeof result.resultCount !== "number" || !Number.isSafeInteger(result.resultCount) || result.resultCount < 0) {
          throw new Error("Invalid browser challenge search result");
        }
        if (result.resultCount > 0) return challenge(marker.vendor);
      } finally {
        // This also runs for a search response arriving after timeout or caller cancellation.
        if (searchId) await cdp.send("DOM.discardSearchResults", { searchId });
      }
    }
    return undefined;
  };
  const unavailable = new Promise<undefined>((resolve, reject) => {
    timer = setTimeout(() => { stopped = true; resolve(undefined); }, TOOL_TIMEOUT_POLICY.browserChallengeProbeMs);
    cancel = () => { stopped = true; reject(signal?.reason ?? new Error("Browser challenge observation cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try {
    const result = await Promise.race([probe(), unavailable]);
    signal?.throwIfAborted();
    return result;
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
