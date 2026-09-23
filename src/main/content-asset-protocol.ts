/**
 * `ave-content://<kind>/<name>/<path>` — the host asset scheme installed
 * content packages reach the renderer through (design §5.4): a theme's
 * preview image and the faces of an installed font. Nothing is served by
 * file path, and only files the installed-content service lists as applied
 * answer; everything else is 404.
 */
import { readFile } from "node:fs/promises";
import { CONTENT_ASSET_SCHEME } from "../shared/installed-content.js";
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
  if (segments.length < 2) return null;
  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (decoded.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\/\0]/u.test(segment))) return null;
  const [name, ...rest] = decoded;
  return { kind: url.hostname, name: name!, path: rest.join("/") };
}

type ContentAssetResolver = (kind: string, name: string, path: string) => ServedContentFile | null | Promise<ServedContentFile | null>;

/** Answer a `ave-content:` request from the files `resolve` lists. */
export async function respondToContentAsset(
  requestUrl: string,
  resolve: ContentAssetResolver,
): Promise<Response> {
  const parsed = parseContentAssetUrl(requestUrl);
  const file = parsed ? await resolve(parsed.kind, parsed.name, parsed.path) : null;
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
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    },
  });
}

/** Serve `ave-content:` on the default session (the app's own windows). */
export function installContentAssetProtocolHandler(
  protocolApi: Pick<Electron.Protocol, "handle">,
  resolve: ContentAssetResolver,
): void {
  protocolApi.handle(CONTENT_ASSET_SCHEME, (request) => respondToContentAsset(request.url, resolve));
}
