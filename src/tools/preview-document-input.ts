import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { TableDocumentError } from "./table-document-error.js";

/** Read one opened regular file without reopening a checked pathname. */
export async function readPreviewDocumentInput(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new TableDocumentError("not-a-file", "Not a regular file.");
    const limit = PREVIEW_DOCUMENT_LIMITS.maxFileBytes;
    if (initial.size > limit) {
      throw new TableDocumentError("too-large", "Document exceeds the file size limit.", initial.size);
    }
    // One extra byte detects growth without buffering the replacement/grown file.
    const buffer = Buffer.allocUnsafe(initial.size + 1);
    let received = 0;
    while (received < buffer.length) {
      const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received);
      if (bytesRead === 0) break;
      received += bytesRead;
    }
    const final = await handle.stat();
    if (final.size > limit) {
      throw new TableDocumentError("too-large", "Document exceeds the file size limit.", final.size);
    }
    if (received !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
      throw new TableDocumentError("read-failed", "Document changed while being read.");
    }
    return buffer.subarray(0, received);
  } finally {
    await handle.close();
  }
}
