import { browserWorkspaceUrl, type BrowserLoadError } from "../../shared/browser-workspace.js";

/** Network error codes grouped by what a person can do about them. Codes are the network stack's stable negative integers. */
function reasonFor(code: number): BrowserLoadError["reason"] {
  if (code === -105 || code === -137) return "dns";
  if (code === -106) return "offline";
  if (code === -310) return "redirects";
  if (code === -312 || code === -311 || (code <= -20 && code >= -30)) return "blocked";
  if (code <= -200 && code > -300) return "certificate";
  if (code === -107 || (code <= -110 && code >= -117) || code === -123 || code === -125 || code === -126 || code === -129) return "secure-connection";
  if (code === -7 || code === -15 || (code <= -100 && code >= -104) || code === -108 || code === -109 || code === -118) return "connection";
  return "failed";
}

/** A main-frame load failure as the host presents it. `description` is the stack's own name for the code. */
export function describeLoadFailure(code: number, description: string, url: string): BrowserLoadError {
  return {
    reason: reasonFor(code), code,
    detail: description.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 100),
    url: browserWorkspaceUrl(url) ?? "",
  };
}

/** The page's process ended without the page asking for it. */
export function describePageCrash(exitReason: string, url: string): BrowserLoadError {
  return { reason: "crashed", code: 0, detail: exitReason.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 100), url: browserWorkspaceUrl(url) ?? "" };
}
