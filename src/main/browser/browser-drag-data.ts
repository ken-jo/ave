/** Browser-originated drag text. Never accepts native file lists or model data. */
export interface BrowserDragData {
  readonly items: readonly {
    readonly mimeType: "text/plain" | "text/html" | "text/uri-list";
    readonly data: string;
    readonly title?: string;
    readonly baseURL?: string;
  }[];
  readonly dragOperationsMask: number;
}

class BrowserDragDataError extends Error {
  readonly code = "invalid-drag-data";
}

function refuse(): never { throw new BrowserDragDataError("the browser returned unsupported drag data; no drop was sent"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) refuse(); }
function localFile(value: string): boolean { return /file\s*:|(?:^|[\r\n])\s*(?:[a-z]:[\\/]|\\\\|\/|~\/)/i.test(value); }

export function browserDragData(value: unknown, origin: string): BrowserDragData {
  const approvedOrigin = new URL(origin).origin;
  if (!record(value)) refuse();
  keys(value, ["items", "files", "dragOperationsMask"]);
  if (value.files !== undefined && (!Array.isArray(value.files) || value.files.length !== 0)) refuse();
  // The native "all/uninitialized" sentinel is UINT_MAX, serialized by the
  // protocol's signed integer as -1. Narrow it to the three supported effects.
  const mask = value.dragOperationsMask === -1 ? 19 : value.dragOperationsMask;
  if (!Number.isInteger(mask) || typeof mask !== "number" || mask < 1 || mask > 19 || (mask & ~19) !== 0) refuse();
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 16) refuse();
  let bytes = 0;
  const items = value.items.map((item) => {
    if (!record(item)) refuse();
    keys(item, ["mimeType", "data", "title", "baseURL"]);
    const { mimeType, data, title, baseURL } = item;
    if (mimeType !== "text/plain" && mimeType !== "text/html" && mimeType !== "text/uri-list") refuse();
    if (typeof data !== "string" || localFile(data) || data.includes("\0")) refuse();
    if (title !== undefined && (typeof title !== "string" || title.length > 512 || localFile(title))) refuse();
    if (baseURL !== undefined) {
      if (typeof baseURL !== "string" || baseURL.length > 2048) refuse();
      try { if (new URL(baseURL).origin !== approvedOrigin || !/^https?:/.test(baseURL)) refuse(); } catch { refuse(); }
    }
    if (mimeType === "text/uri-list") for (const line of data.split(/\r?\n/).filter((line) => line && !line.startsWith("#"))) {
      try { const url = new URL(line); if (!/^https?:$/.test(url.protocol) || url.origin !== approvedOrigin) refuse(); } catch { refuse(); }
    }
    bytes += Buffer.byteLength(data) + Buffer.byteLength(title ?? "") + Buffer.byteLength(baseURL ?? "");
    if (bytes > 64 * 1024) refuse();
    return Object.freeze({ mimeType, data, ...(title === undefined ? {} : { title }), ...(baseURL === undefined ? {} : { baseURL }) });
  });
  return Object.freeze({ items: Object.freeze(items), dragOperationsMask: mask });
}
