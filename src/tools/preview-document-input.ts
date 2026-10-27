import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { TableDocumentError } from "./table-document-error.js";

/** Read one opened regular file without reopening a checked pathname. */
export async function readPreviewDocumentInput(
  path: string,
  signal?: AbortSignal,
  maxBytes = PREVIEW_DOCUMENT_LIMITS.maxFileBytes,
): Promise<Buffer> {
  return (await readOpenedDocument(path, signal, maxBytes)).data;
}

async function readOpenedDocument(path: string, signal: AbortSignal | undefined, maxBytes: number) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
    throw new TableDocumentError("too-large", "Invalid preview byte limit.");
  }
  const handle = await open(path, constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
  try {
    signal?.throwIfAborted();
    // Windows has no O_NOFOLLOW, so prove the descriptor is the checked
    // pathname's own file rather than a link swapped in before the open.
    const atPath = await lstat(path, { bigint: true });
    const initial = await handle.stat();
    const opened = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (atPath.isSymbolicLink() || atPath.dev !== opened.dev || atPath.ino !== opened.ino) {
      throw new TableDocumentError("read-failed", "Document changed while being read.");
    }
    if (!initial.isFile()) throw new TableDocumentError("not-a-file", "Not a regular file.");
    const limit = maxBytes;
    if (initial.size > limit) {
      throw new TableDocumentError("too-large", "Document exceeds the file size limit.", initial.size);
    }
    // One extra byte detects growth without buffering the replacement/grown file.
    const buffer = Buffer.allocUnsafe(initial.size + 1);
    let received = 0;
    while (received < buffer.length) {
      const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      received += bytesRead;
    }
    const final = await handle.stat();
    signal?.throwIfAborted();
    if (final.size > limit) {
      throw new TableDocumentError("too-large", "Document exceeds the file size limit.", final.size);
    }
    if (received !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
      throw new TableDocumentError("read-failed", "Document changed while being read.");
    }
    return { data: buffer.subarray(0, received), identity: opened };
  } finally {
    await handle.close();
  }
}
