import "../bare-program-lookup.js";
import { BROWSER_CAPTURE_LIMITS } from "../../shared/browser-capture.js";
import { errorMessage } from "../../shared/error-message.js";
import { createCaptureStitch } from "./browser-capture-stitch.js";
import { captureStitchFrame, captureStitchFrames, type CaptureStitchReply, type CaptureStitchRequest } from "./browser-capture-stitch-protocol.js";

const [width = 0, height = 0] = process.argv.slice(2).map(Number);
if (process.argv.length !== 4 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width * height > BROWSER_CAPTURE_LIMITS.pixels) {
  process.exit(1);
}
const stitch = createCaptureStitch(width, height);
const reply = (message: CaptureStitchReply, payload?: Buffer): void => { process.stdout.write(captureStitchFrame(message, payload)); };

process.stdin.on("data", captureStitchFrames((message, payload) => {
  const { id, tile } = message as CaptureStitchRequest;
  void stitch.then((active) => tile ? active.decode(payload, tile).then(() => undefined) : active.encode()).then(
    (png) => reply({ id }, png),
    (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      reply({ id, error: { message: errorMessage(error), ...(typeof code === "string" ? { code } : {}) } });
    },
  );
}));
// The host owns this process: without it there is nothing to answer.
process.stdin.on("end", () => process.exit(0));
