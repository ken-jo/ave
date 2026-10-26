import { describe, expect, it } from "vitest";
import { reviewerInvocationId } from "../reviewer-dispatch.js";
import { JudgeContractError } from "../../../permissions/judge/judge-contract.js";

describe("reviewer invocation identity", () => {
  it("retains the host's batch and tool-call identity across assessments", () => {
    const meta = { groupId: "batch-one", toolUseId: "call-one" };
    expect(reviewerInvocationId(meta)).toBe(reviewerInvocationId({ ...meta }));
    expect(reviewerInvocationId(meta)).not.toBe(reviewerInvocationId({ ...meta, groupId: "batch-two" }));
    expect(reviewerInvocationId(meta)).not.toBe(reviewerInvocationId({ ...meta, toolUseId: "call-two" }));
  });

  it("keeps tuple delimiters unambiguous", () => {
    expect(reviewerInvocationId({ groupId: "batch,call", toolUseId: "one" }))
      .not.toBe(reviewerInvocationId({ groupId: "batch", toolUseId: "call,one" }));
  });

  it.each([
    { groupId: "", toolUseId: "call" },
    { groupId: "batch", toolUseId: " " },
    { groupId: undefined, toolUseId: "call" },
    { groupId: "batch", toolUseId: undefined },
  ])("rejects incomplete host metadata %j", (meta) => {
    expect(() => reviewerInvocationId(meta as never)).toThrow(JudgeContractError);
  });
});
