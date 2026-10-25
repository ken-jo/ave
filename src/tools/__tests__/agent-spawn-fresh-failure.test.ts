// Failed fresh runs never suspended and cannot resume; guidance must preserve findings without respawning.
import { describe, expect, it } from "vitest";

import { en } from "../../i18n/messages/generated/be_agentSpawn.js";

describe("failed fresh spawn guidance", () => {
  const failed = en["be_agentSpawn.freshSpawnFailedGuidance"];
  const rejected = en["be_agentSpawn.freshSpawnRejectedGuidance"];

  it("states plainly that the child cannot be resumed", () => {
    expect(failed).toMatch(/CANNOT be resumed/i);
    expect(rejected).toMatch(/cannot be resumed/i);
  });

  it("explains WHY there is nothing to resume", () => {
    // No suspension means there is no resume point.
    expect(failed).toMatch(/never suspended|no point to continue/i);
  });

  it("tells the parent not to immediately respawn the same task", () => {
    expect(failed).toMatch(/not.{0,30}spawn the same task again/i);
  });

  it("does not promise a retry will work for a provider rejection", () => {
    // Deterministic refusals cannot recover through retries.
    expect(rejected).toMatch(/every time|cannot succeed/i);
    expect(rejected).toMatch(/change the request/i);
  });

  it("keeps a transient failure retryable exactly once, not blindly", () => {
    expect(failed).toMatch(/transient/i);
    expect(failed).toMatch(/one retry/i);
  });

  it("names concrete next moves rather than only forbidding things", () => {
    // Guidance needs an actionable alternative to respawning.
    for (const text of [failed, rejected]) {
      expect(text).toMatch(/sourceTools/);
    }
    expect(failed).toMatch(/narrow the task|do the work yourself/i);
  });

  it("tells the parent to surface the loss to the user", () => {
    // Surface the failure so partial work cannot be reported as complete.
    expect(failed).toMatch(/tell the user/i);
    expect(rejected).toMatch(/Tell the user/i);
  });
});
