/**
 * MCP tool-result content → the host's tool result.
 *
 * A `tools/call` result is a list of typed content blocks. Text blocks become
 * the tool output. Image blocks carry base64 pixels: rendering them as JSON
 * text would hand the model a wall of base64 that the tool-result budget then
 * truncates, so the image is lost twice. Instead each image block leaves a
 * short placeholder in the text, and the first one rides
 * {@link ToolResultImage} — the same sibling field `view_image` uses — after
 * going through the same isolated decoder, which validates the format and
 * bounds its size. Only one image travels per tool result because that field
 * is singular; later images are named in the text.
 *
 * Any other block carrying base64 bytes — audio, an image block whose MIME
 * type is not an image, an embedded resource's `blob` — is replaced by a short
 * note naming its type and size (`[audio/ogg, 123 KB omitted]`): the model
 * cannot use the encoding, and the tool-result budget would spend itself on
 * it. Text blocks, embedded text resources and resource links keep their text.
 */
import { IMAGE_PREPARATION_POLICY } from "../shared/image-preparation-policy.js";
import { errorMessage } from "../shared/error-message.js";
import { prepareImageBytes } from "../tools/image-preparation.js";
import type { ToolResultImage } from "../tools/types.js";
import type { McpContentImage } from "./types.js";

/** One content block as an MCP server sends it; fields are untrusted. */
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

/** Bytes a base64 string decodes to, without decoding it. */
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

/**
 * The note that stands in for a block's base64 payload, or `undefined` when
 * the block carries none: `data` on the block itself (audio, a non-image
 * image block), or `blob` on an embedded resource.
 */
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

/**
 * Render content blocks to text, lifting image blocks out. A malformed image
 * block (no data, or a non-image MIME type) is not an image; like any other
 * block with a base64 payload it becomes an omission note, and a block with
 * none keeps its JSON rendering.
 */
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

/**
 * Prepare the first lifted image for the model. Returns the image when it
 * decodes, plus a note for the text output whenever an image was not attached
 * (a rejected first image, or images beyond the first), so the model is told
 * what it is not seeing instead of the image silently vanishing.
 */
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
