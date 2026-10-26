import { PACKAGE_KINDS, isPackageName, type PackageKind } from "../marketplace/catalog/types.js";
import { isFolderPathInput } from "../marketplace/net/source-url.js";
import { isSourceId } from "../marketplace/sources/official.js";
import { holdsCredential } from "../shared/dlp.js";
import type { GitMarketplaceDeepLink } from "../shared/git-marketplace.js";
import { isValidPluginId } from "../plugins/public-contract.js";

export function findAveProtocolUri(argv: readonly string[]): string | null {
  // Scheme comparison is case-insensitive per RFC 3986 §3.1, so accept e.g. AVE://...
  return argv.find((arg) => arg.toLowerCase().startsWith("ave://")) ?? null;
}

const GIT_MARKETPLACE_ADD_URL_MAX = 2048;

// Marketplace links accept remote addresses only; local paths open an empty Add dialog with an explanation. Legacy slug-only install links are rejected.
export function parseGitMarketplaceUri(url: string): GitMarketplaceDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ave:" || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "marketplace") {
    if (parsed.pathname !== "/add") return null;
    const keys = [...parsed.searchParams.keys()];
    const address = parsed.searchParams.get("url");
    if (keys.length !== 1 || keys[0] !== "url" || !address) return null;
    if (address.length > GIT_MARKETPLACE_ADD_URL_MAX || /[\u0000-\u001f\u007f]/u.test(address)) return null;
    if (isFolderPathInput(address)) return { action: "add-refused", reason: "deep-link-path" };
    return { action: "add", url: address };
  }
  if (host !== "install" && host !== "uninstall") return null;
  if (parsed.search) return null;
  let segments: string[];
  try {
    segments = parsed.pathname.replace(/^\//, "").split("/").map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (segments.length !== 2) return null;
  const [kind, qualified] = segments as [string, string];
  const at = qualified.lastIndexOf("@");
  if (at < 0) return null;
  const name = qualified.slice(0, at);
  const sourceId = qualified.slice(at + 1);
  // Reject credential-shaped keys before returning the scrubbed key to the tab.
  if (!(PACKAGE_KINDS as readonly string[]).includes(kind) || !isPackageName(name) || holdsCredential(name) || !isSourceId(sourceId)) return null;
  return { action: host, key: { sourceId, kind: kind as PackageKind, name } };
}

// Treat OAuth codes as opaque and enforce only bounded unreserved-character shape before host-event delivery.
// Require one valid plugin segment and exactly one code parameter; ignore fragments.
const PLUGIN_AUTH_HOST = "plugin-auth";
const MIN_CODE_LENGTH = 16;
const MAX_CODE_LENGTH = 256;
const CODE_RE = /^[A-Za-z0-9._~-]+$/;

export function parsePluginAuthUri(url: string): { pluginId: string; code: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ave:") return null;
  if (parsed.hostname.toLowerCase() !== PLUGIN_AUTH_HOST) return null;

  // Extract first path segment as pluginId. URL normalizes `ave://plugin-auth/foo` to pathname "/foo"; strip leading slash and require non-empty single segment.
  const path = parsed.pathname ?? "";
  if (!path.startsWith("/")) return null;
  const trimmed = path.slice(1);
  if (trimmed.length === 0) return null;
  // Reject extra path segments — exact form is `plugin-auth/<pluginId>` only.
  if (trimmed.includes("/")) return null;
  const pluginId = trimmed;
  if (!isValidPluginId(pluginId)) return null;

  const codes = parsed.searchParams.getAll("code");
  // Reject parameter pollution (`?code=a&code=b`) outright. A real callback never carries duplicate `code` keys, so the only way we'd see this is an
  // attacker trying to confuse the parser.
  if (codes.length !== 1) return null;
  const code = codes[0];
  if (!code) return null;
  if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return null;
  if (!CODE_RE.test(code)) return null;
  return { pluginId, code };
}
