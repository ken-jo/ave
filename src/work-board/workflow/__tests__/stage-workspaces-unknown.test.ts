import { expect, it, vi } from "vitest";
import { CALLS, controlCalls, replayEach } from "./stage-unknown-replay.js";

vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: quiet, info: quiet, debug: quiet, error: quiet }) };
});

it("each lifecycle makes exactly the git calls listed, so a new one is replayed failing too", async () => {
  const seen = await controlCalls();
  expect(seen).toEqual(CALLS);
});

replayEach("exit 128", CALLS);
