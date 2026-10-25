/** Decode at most one image into the model image field; text retains placeholders for omitted media.
 * Encoded binary payloads never consume the text budget as base64. */
import { IMAGE_PREPARATION_POLICY } from "../shared/image-preparation-policy.js";
import { errorMessage } from "../shared/error-message.js";
import { prepareImageBytes } from "../tools/image-preparation.js";
import type { ToolResultImage } from "../tools/types.js";
import type { McpContentImage } from "./types.js";

type McpContentBlock = { type: string; text?: string; [key: string]: unknown };


interface RenderedMcpContent {
  text: string;
  images: McpContentImage[];
}

function contentImage(block: McpContentBlock): McpContentImage | undefined {
  if (block.type !== "image") return undefined;
  const { data, mimeType } = block;
  if (typeof data !== "string" || data.length === 0) return undefined;
  if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) return undefined;
  return { data, mimeType };
}

function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

function mimeTypeOf(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "application/octet-stream";
}

/** Identify encoded binary payloads for omission notes without decoding them. */
function omittedBinaryNote(block: McpContentBlock): string | undefined {
  if (typeof block.data === "string") {
    return `[${mimeTypeOf(block.mimeType)}, ${formatBytes(base64DecodedBytes(block.data))} omitted]`;
  }
  const resource = block.resource;
  if (block.type === "resource" && resource && typeof resource === "object") {
    const { blob, mimeType, uri } = resource as Record<string, unknown>;
    if (typeof blob === "string") {
      const where = typeof uri === "string" && uri.length > 0 ? ` ${uri}` : "";
      return `[resource${where}: ${mimeTypeOf(mimeType)}, ${formatBytes(base64DecodedBytes(blob))} omitted]`;
    }
  }
  return undefined;
}

/** Lift valid image blocks; other encoded payloads become explicit omission notes. */
export function renderMcpContent(content: readonly McpContentBlock[]): RenderedMcpContent {
  const images: McpContentImage[] = [];
  const parts = content.map((block) => {
    const image = contentImage(block);
    if (!image) return block.text ?? omittedBinaryNote(block) ?? JSON.stringify(block);
    images.push(image);
    return `[image ${images.length}: ${image.mimeType}, ${base64DecodedBytes(image.data)} bytes]`;
  });
  return { text: parts.join("\n"), images };
}

/** Report rejected or extra images in text so media cannot disappear silently. */
export async function prepareMcpContentImage(
  images: readonly McpContentImage[],
  signal?: AbortSignal,
): Promise<{ image?: ToolResultImage; note?: string }> {
  const [first, ...rest] = images;
  if (!first) return {};
  const notes: string[] = [];
  let image: ToolResultImage | undefined;
  try {
    if (base64DecodedBytes(first.data) > IMAGE_PREPARATION_POLICY.maxInputBytes) {
      throw new Error(`image-input-limit: Image source exceeds ${IMAGE_PREPARATION_POLICY.maxInputBytes} bytes.`);
    }
    const prepared = await prepareImageBytes(Buffer.from(first.data, "base64"), {}, signal);
    image = {
      data: prepared.data,
      mimeType: prepared.mimeType,
      bytes: prepared.bytes,
      width: prepared.width,
      height: prepared.height,
    };
  } catch (error) {
    signal?.throwIfAborted();
    notes.push(`[image 1 was not attached: ${errorMessage(error)}]`);
  }
  if (rest.length > 0) {
    const which = rest.length === 1 ? "image 2 was" : `images 2-${images.length} were`;
    notes.push(`[${which} not attached: one image is shown per tool result]`);
  }
  return { ...(image ? { image } : {}), ...(notes.length > 0 ? { note: notes.join("\n") } : {}) };
}
