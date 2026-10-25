// Refused sends must offer actionable alternatives without inviting retries or duplicate agents.
import { describe, expect, it } from "vitest";

import {
  SEND_FAILURE_GUIDANCE,
  type AgentSendFailureReason,
} from "../agent-send.js";

const REASONS = Object.keys(SEND_FAILURE_GUIDANCE) as AgentSendFailureReason[];

describe("agent_send failure guidance", () => {
  it("covers every declared refusal reason", () => {
    // Check runtime guidance contents as well as the type-checked reason keys.
    expect(REASONS.length).toBeGreaterThan(0);
    for (const reason of REASONS) {
      expect(SEND_FAILURE_GUIDANCE[reason].trim().length).toBeGreaterThan(0);
    }
  });

  it("tells a parent which tools DO work from a parent", () => {
    // Parent guidance must point to agent_guide or agent_spawn to avoid duplicate children.
    const guidance = SEND_FAILURE_GUIDANCE["unknown-sender"];
    expect(guidance).toContain("agent_guide");
    expect(guidance).toContain("agent_spawn");
  });

  it("does not tell the model to retry a permanent refusal", () => {
    // Terminal recipients and an unavailable message bus cannot recover through retries.
    expect(SEND_FAILURE_GUIDANCE["terminal-recipient"]).toMatch(/never|already/i);
    expect(SEND_FAILURE_GUIDANCE["message-bus-unavailable"]).toMatch(/not retry|do not retry/i);
  });

  it("marks an idle recipient as a timing miss, not a failure to route around", () => {
    const guidance = SEND_FAILURE_GUIDANCE["recipient-unavailable"];
    expect(guidance).toMatch(/timing/i);
    expect(guidance).toMatch(/replacement agent|NOT re-send/i);
  });

  it("points a bad id at where the real id comes from", () => {
    const guidance = SEND_FAILURE_GUIDANCE["unknown-recipient"];
    expect(guidance).toMatch(/agent_list|agent_status/);
    // Agent names are not message addresses.
    expect(guidance).toMatch(/names are not addresses/i);
  });

  it("does not auto-retry after a deliberate stop", () => {
    expect(SEND_FAILURE_GUIDANCE.aborted).toMatch(/deliberate/i);
  });
});
