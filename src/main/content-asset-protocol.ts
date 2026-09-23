/**
 * `ave-content://<token>/<kind>/<name>/<path>` — the host asset scheme
 * installed content packages reach the renderer through (design §5.4): a
 * theme's preview image and the faces of an installed font. Nothing is served
 * by file path, and only files the installed-content service lists as applied
 * answer; everything else is 404.
 *
 * Web pages the app opens share the default session this scheme is handled
 * in, and a page can send a request with no Origin and no referrer (an
 * `<img referrerpolicy=no-referrer>`, a fetch from a sandboxed `srcdoc`
 * frame). So the host of every URL is a random token drawn at launch, which
 * only the app's renderer receives (in the installed-content view): a request
 * without it is 404, and a page cannot name, probe or read an installed file.
 * On top of that, the answer admits only the opaque origin of the app's
 * `file:` windows (`Access-Control-Allow-Origin: null`), and a request with an
 * http(s) origin or referrer is refused outright.
 */
import { readFile } from "node:fs/promises";
import { CONTENT_ASSET_SCHEME, CONTENT_ASSET_TOKEN } from "../shared/installed-content.js";
import type { ServedContentFile } from "../marketplace/content/service.js";

/** Registered with the other privileged schemes in one call before `app.ready` (see `early-boot-env.ts`). */
export const CONTENT_ASSET_CUSTOM_SCHEME: Electron.CustomScheme = Object.freeze({
  scheme: CONTENT_ASSET_SCHEME,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    // Fonts are CORS requests; the renderer's own origin is not this scheme.
    corsEnabled: true,
  }),
});

export interface ContentAssetRequest {
  token: string;
  kind: string;
  name: string;
  path: string;
}

/** The parts of a `ave-content:` URL, or null for anything malformed. */
export function parseContentAssetUrl(requestUrl: string): ContentAssetRequest | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${CONTENT_ASSET_SCHEME}:` || url.search || url.hash) return null;
  const segments = url.pathname.replace(/^\/+/u, "").split("/");
  if (segments.length < 3) return null;
  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (decoded.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\/\0]/u.test(segment))) return null;
  const [kind, name, ...rest] = decoded;
  return { token: url.hostname, kind: kind!, name: name!, path: rest.join("/") };
}

type ContentAssetResolver = (kind: string, name: string, path: string) => ServedContentFile | null | Promise<ServedContentFile | null>;

/** Who asked: the request's `Origin` header (null without one) and its referrer. */
export interface ContentAssetRequester {
  origin: string | null;
  referrer: string;
}

const WEB = /^https?:/iu;

/** Answer a `ave-content:` request from the files `resolve` lists. */
export async function respondToContentAsset(
  requestUrl: string,
  token: string,
  resolve: ContentAssetResolver,
  requester: ContentAssetRequester,
): Promise<Response> {
  if ((requester.origin !== null && WEB.test(requester.origin)) || WEB.test(requester.referrer)) {
    return new Response("forbidden", { status: 403 });
  }
  const parsed = parseContentAssetUrl(requestUrl);
  const file = parsed && parsed.token === token ? await resolve(parsed.kind, parsed.name, parsed.path) : null;
  if (!file) return new Response("not found", { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await readFile(file.path);
  } catch {
    return new Response("not found", { status: 404 });
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "null",
      "cache-control": "no-cache",
    },
  });
}

/** Serve `ave-content:` on the default session, answering only URLs that carry `token`. */
export function installContentAssetProtocolHandler(
  protocolApi: Pick<Electron.Protocol, "handle">,
  token: string,
  resolve: ContentAssetResolver,
): void {
  if (!CONTENT_ASSET_TOKEN.test(token)) throw new Error("the content asset token must be 32 hex characters");
  protocolApi.handle(CONTENT_ASSET_SCHEME, (request) =>
    respondToContentAsset(request.url, token, resolve, { origin: request.headers.get("origin"), referrer: request.referrer }),
  );
}
