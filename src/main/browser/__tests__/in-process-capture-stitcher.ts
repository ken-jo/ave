import { createCaptureStitch } from "../browser-capture-stitch.js";
import type { CaptureStitcher } from "../browser-capture-stitch-process.js";

/** Composes in the test process; browser-capture-stitch-process.test.ts covers the child. */
export function startCaptureStitcher(width: number, height: number): CaptureStitcher {
  const stitch = createCaptureStitch(width, height);
  return {
    decode: async (png, tile) => (await stitch).decode(png, tile),
    encode: async () => (await stitch).encode(),
    stop: () => {},
  };
}
