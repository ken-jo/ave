import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { judgedPathNamesOpenedFile } from "../permissions/sensitive-paths.js";
import { sniffComposerImageFormat } from "../shared/composer-image-input.js";
import { IMAGE_PREPARATION_POLICY } from "../shared/image-preparation-policy.js";

export function requireSupportedImage(bytes: Uint8Array): "png" | "jpeg" | "gif" | "webp" {
  const mime = sniffComposerImageFormat(bytes)?.mimeType;
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  throw new Error("unsupported-image: Supported input formats are PNG, JPEG, GIF and WebP. Convert other formats to one of these with an available image conversion tool, then call view_image again; changing the extension is insufficient.");
}

/**
 * Read from one opened regular file, bounding growth after the size check too. `path` is the real path whose rules the
 * caller judged; the bytes are returned only if it still names the very file read, looked up after the read with the
 * handle still open (`judgedPathNamesOpenedFile`). The open refuses a link in the last name where the platform can.
 */
export async function readImageInput(path: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("invalid-image-file: view_image requires a regular file.");
    const opened = await handle.stat({ bigint: true });
    const prefix = Buffer.alloc(16);
    const first = await handle.read(prefix, 0, prefix.length, 0);
    signal.throwIfAborted();
    requireSupportedImage(prefix.subarray(0, first.bytesRead));
    const limit = IMAGE_PREPARATION_POLICY.maxInputBytes;
    if (info.size > limit) throw new Error(`image-input-limit: Source exceeds ${limit} bytes. Export a smaller source image first; maxBytes limits the derived output, not source reading.`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(IMAGE_PREPARATION_POLICY.readChunkBytes, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      signal.throwIfAborted();
      if (bytesRead === 0) {
        if (!judgedPathNamesOpenedFile(path, opened)) {
          throw new Error("image-source-changed: The image file changed while it was read. Read it again.");
        }
        return Buffer.concat(chunks, total);
      }
      total += bytesRead;
      if (total > limit) throw new Error("image-input-limit: Source grew beyond the host read limit. Export a smaller source image first.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}
