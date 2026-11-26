import { BROWSER_CAPTURE_LIMITS } from "../../shared/browser-capture.js";

/** Built next to main.js by scripts/build-main-esbuild.mjs and listed in MAIN_BUNDLE_ROOT_FILES. */
export const CAPTURE_STITCH_CHILD_FILE = "browser-capture-stitch-child.js";
/** Raw pixels one capture may have extracted but not yet composed. */
export const CAPTURE_DECODE_PIXELS = BROWSER_CAPTURE_LIMITS.pixels / 2;
const FRAME_HEADER_BYTES = 8;

export interface CaptureTilePlacement {
  pixelWidth: number; pixelHeight: number;
  scale: number; skip: number; copied: number; rows: number;
}
/** A tile to compose, or with no tile the request for the encoded result. */
export interface CaptureStitchRequest { id: number; tile?: CaptureTilePlacement }
export interface CaptureStitchReply { id: number; error?: { message: string; code?: string } }

export function captureStitchError(code: "screenshot-limit" | "screenshot-unavailable", message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function captureStitchFrame(message: CaptureStitchRequest | CaptureStitchReply, payload?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  header.writeUInt32BE(payload?.length ?? 0, 4);
  return Buffer.concat(payload ? [header, json, payload] : [header, json]);
}

/** Reassembles frames from stream chunks. A frame above the byte limit throws. */
export function captureStitchFrames(onFrame: (message: unknown, payload: Buffer) => void): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let size = 0;
  return (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size >= FRAME_HEADER_BYTES) {
      const first = chunks[0];
      // Chunks are joined only when the header straddles them or the whole frame has arrived.
      const header = first && first.length >= FRAME_HEADER_BYTES ? first : Buffer.concat(chunks);
      if (header !== first) chunks = [header];
      const payloadStart = FRAME_HEADER_BYTES + header.readUInt32BE(0);
      const end = payloadStart + header.readUInt32BE(4);
      if (end > FRAME_HEADER_BYTES + 2 * BROWSER_CAPTURE_LIMITS.bytes) throw new Error("capture stitch frame exceeds its byte limit");
      if (size < end) return;
      const frame = chunks.length === 1 ? header : Buffer.concat(chunks);
      chunks = size > end ? [frame.subarray(end)] : [];
      size -= end;
      onFrame(JSON.parse(frame.toString("utf8", FRAME_HEADER_BYTES, payloadStart)), frame.subarray(payloadStart, end));
    }
  };
}
