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
 * Other block types (audio, embedded resources, resource links) keep their
 * JSON rendering.
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

/**
 * Render content blocks to text, lifting image blocks out. A malformed image
 * block (no data, or a non-image MIME type) is not an image and keeps the
 * JSON rendering every other block gets.
 */
export function renderMcpContent(content: readonly McpContentBlock[]): RenderedMcpContent {
  const images: McpContentImage[] = [];
  const parts = content.map((block) => {
    const image = contentImage(block);
    if (!image) return block.text ?? JSON.stringify(block);
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
