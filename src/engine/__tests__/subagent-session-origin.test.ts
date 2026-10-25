import { describe, expect, it, vi } from "vitest";
import { SubAgentRunner } from "../subagent-runner.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "sub-11111111-22222222-2222-4222-8222-222222222222";

describe("subagent session origin", () => {
  it("reads restored ownership only from subagent metadata", () => {
    const loadSessionMetadata = vi.fn(() => ({ sessionKind: "subagent", originSessionId: PARENT }));
    const runner = new SubAgentRunner({ subAgentMemoryManager: { loadSessionMetadata } } as never);
    expect(runner.resolveOriginSessionId(CHILD)).toBe(PARENT);
    loadSessionMetadata.mockReturnValue({ sessionKind: "main", originSessionId: PARENT });
    expect(runner.resolveOriginSessionId(CHILD)).toBeUndefined();
    expect(runner.resolveOriginSessionId("../foreign")).toBeUndefined();
    expect(loadSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it("prefers live host ownership over stale disk metadata", () => {
    const loadSessionMetadata = vi.fn();
    const runner = new SubAgentRunner({ subAgentMemoryManager: { loadSessionMetadata } } as never);
    vi.spyOn(runner, "liveOriginSessionId").mockReturnValue(PARENT);
    expect(runner.resolveOriginSessionId(CHILD)).toBe(PARENT);
    expect(loadSessionMetadata).not.toHaveBeenCalled();
  });
});
