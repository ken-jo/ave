// windows-native: the Windows job runs this file from config/windows-native-tests.txt.
import { vi } from "vitest";
import { CALLS, replayEach } from "./stage-unknown-replay.js";

vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: quiet, info: quiet, debug: quiet, error: quiet }) };
});

replayEach("thrown", CALLS);
