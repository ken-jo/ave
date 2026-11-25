import { vi } from "vitest";
import { CALLS, replayEach } from "./stage-unknown-replay.js";

vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: quiet, info: quiet, debug: quiet, error: quiet }) };
});

replayEach("exit 1 with stderr", CALLS);
