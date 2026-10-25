/** Accept only bounded inline bytes; app-supplied links must never trigger host-network fetches.
 * The user save dialog authorizes the destination after parsing succeeds. */
import { basename } from "node:path";
import { base64DecodedLength } from "../shared/json-representable.js";

/** Bound total decoded size from encoded length before allocating any buffer. */
export const MCP_APP_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** File count bounds save-dialog spam as well as memory. */
export const MCP_APP_DOWNLOAD_MAX_FILES = 8;

export const MCP_APP_DOWNLOAD_FALLBACK_FILENAME = "download";

const MCP_APP_DOWNLOAD_MAX_FILENAME_CHARS = 128;

/** User cancellation is a successful cancelled disposition, never a protocol error. */
export type McpUiDownloadOutcome =
  | { ok: true; disposition: "saved" | "cancelled" }
  | { ok: false; error: string; message: string };

interface McpAppDownloadFile {
  filename: string;
  mimeType?: string;
  bytes: Buffer;
}

export type McpAppDownloadParse =
  | { kind: "ok"; files: McpAppDownloadFile[] }
  | { kind: "invalid"; error: string; message: string };

const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(error: string, message: string): McpAppDownloadParse {
  return { kind: "invalid", error, message };
}

/** Suggest a bare cross-platform filename that cannot prefill traversal in the save dialog. */
export function sanitizeDownloadFilename(raw: unknown): string {
  if (typeof raw !== "string") return MCP_APP_DOWNLOAD_FALLBACK_FILENAME;

  // Handle both separator styles regardless of the host platform.
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  const name = basename(lastSegment)
    // One conservative allow-list rejects controls, drive syntax and filesystem metacharacters.
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, MCP_APP_DOWNLOAD_MAX_FILENAME_CHARS);

  return name.length > 0 ? name : MCP_APP_DOWNLOAD_FALLBACK_FILENAME;
}

/** Reject the entire request on any invalid item; partial acceptance would expose a probing channel. */
export function parseMcpAppDownload(params: unknown): McpAppDownloadParse {
  const record = asRecord(params);
  const contents = record?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    return invalid("invalid-contents", "contents must be a non-empty array");
  }
  if (contents.length > MCP_APP_DOWNLOAD_MAX_FILES) {
    return invalid(
      "too-many-files",
      `at most ${MCP_APP_DOWNLOAD_MAX_FILES} files may be downloaded in one request`,
    );
  }

  const files: McpAppDownloadFile[] = [];
  let totalBytes = 0;

  for (const item of contents) {
    const block = asRecord(item);
    if (!block) return invalid("invalid-content-block", "each content item must be an object");

    if (block.type === "resource_link") {
      return invalid(
        "resource-link-unsupported",
        "the host does not fetch app-supplied URIs; embed the bytes as a resource instead",
      );
    }
    if (block.type !== "resource") {
      return invalid("invalid-content-block", `unsupported content type '${String(block.type)}'`);
    }

    const resource = asRecord(block.resource);
    if (!resource) return invalid("invalid-content-block", "resource must be an object");

    const mimeType = resource.mimeType;
    if (mimeType !== undefined && (typeof mimeType !== "string" || !MIME_TYPE_RE.test(mimeType))) {
      return invalid("invalid-mime-type", "mimeType must be a well-formed media type");
    }

    const { blob, text } = resource;
    let bytes: Buffer;
    if (typeof blob === "string") {
      // Enforce the cap before base64 allocation.
      if (totalBytes + base64DecodedLength(blob) > MCP_APP_DOWNLOAD_MAX_BYTES) {
        return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
      }
      bytes = Buffer.from(blob, "base64");
    } else if (typeof text === "string") {
      if (totalBytes + Buffer.byteLength(text, "utf8") > MCP_APP_DOWNLOAD_MAX_BYTES) {
        return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
      }
      bytes = Buffer.from(text, "utf8");
    } else {
      return invalid("invalid-resource", "resource must carry `blob` (base64) or `text`");
    }

    // Lenient base64 decoding may discard characters; verify decoded size too.
    totalBytes += bytes.byteLength;
    if (totalBytes > MCP_APP_DOWNLOAD_MAX_BYTES) {
      return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
    }

    files.push({
      filename: sanitizeDownloadFilename(resource.uri),
      ...(typeof mimeType === "string" ? { mimeType } : {}),
      bytes,
    });
  }

  return { kind: "ok", files };
}
