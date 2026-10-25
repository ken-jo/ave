import { describe, expect, it } from "vitest";
import {
  createRationaleApprovalDisplay,
  parseRationaleApprovalDisplay,
  sealMaskedRationaleApprovalDisplay,
  RATIONALE_DISPLAY_CAPS,
} from "../rationale-approval-display.js";

/** Sealed displays must still parse after masking expands fields beyond their caps. */
function readyDisplay(overrides: Partial<Parameters<typeof createRationaleApprovalDisplay>[0]> = {}) {
  return createRationaleApprovalDisplay({
    toolName: "agent_spawn",
    canonicalTargets: ["session:abc"],
    requestedEffects: ["change-host-or-agent-state"],
    affectedResources: ["conversation"],
    requiredAuthority: "host-orchestration",
    effectiveVerdict: { level: "high", reason: "needs explicit review" },
    scopeAlignment: "aligned",
    scopeReasons: ["matches user request"],
    rationaleStatus: "ready",
    suggestion: "review the spawn instructions",
    modalFallbackRequired: false,
    ...overrides,
  });
}

const identity = (value: string) => value;
/** Worst-case mask: inflates every character 20x — everything blows its cap. */
const inflating = (value: string) => value.replaceAll(/./gu, "[REDACTED:TOKEN]");

describe("sealMaskedRationaleApprovalDisplay", () => {
  it("is a parse-preserving identity for a mask that changes nothing", () => {
    const display = readyDisplay();
    const sealed = sealMaskedRationaleApprovalDisplay(display, identity);
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
    expect(sealed.toolName).toBe(display.toolName);
    expect(sealed.effectiveVerdict.reason).toBe(display.effectiveVerdict.reason);
  });

  it("still parses when the mask inflates every field past its cap", () => {
    const sealed = sealMaskedRationaleApprovalDisplay(readyDisplay(), inflating);
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
  });

  it("degrades only the violating field, never the whole card", () => {
    const nearCap = "a".repeat(RATIONALE_DISPLAY_CAPS.authorityLength - 4);
    const display = readyDisplay({ requiredAuthority: nearCap });
    const sealed = sealMaskedRationaleApprovalDisplay(display, (v) =>
      v === nearCap ? nearCap + "[REDACTED:TOKEN]" : v,
    );
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
    // Mark truncation visibly so shortened values cannot be mistaken for complete authority text.
    expect(sealed.requiredAuthority.startsWith("aaa")).toBe(true);
    expect(sealed.requiredAuthority.endsWith("…")).toBe(true);
    expect(sealed.requiredAuthority.length).toBeLessThanOrEqual(
      RATIONALE_DISPLAY_CAPS.authorityLength,
    );
    expect(sealed.toolName).toBe(display.toolName);
  });

  it("never splits a surrogate pair at the truncation point", () => {
    // Drop an emoji whole at the cap; never leave a lone surrogate.
    const cap = RATIONALE_DISPLAY_CAPS.authorityLength;
    const base = "a".repeat(cap - 2) + "😀😀";
    const display = readyDisplay({ requiredAuthority: "auth" });
    const sealed = sealMaskedRationaleApprovalDisplay(display, (v) =>
      v === "auth" ? base : v,
    );
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
    expect(sealed.requiredAuthority.endsWith("…")).toBe(true);
    expect(sealed.requiredAuthority).not.toMatch(/[\ud800-\udbff]…$/u);
  });

  it("substitutes a safe literal when the mask output cannot be salvaged", () => {
    const sealed = sealMaskedRationaleApprovalDisplay(readyDisplay(), () => "  ");
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
    expect(sealed.toolName).toBe("[redacted]");
  });

  it("never masks host-determined enum and status fields", () => {
    const sealed = sealMaskedRationaleApprovalDisplay(readyDisplay(), inflating);
    expect(sealed.effectiveVerdict.level).toBe("high");
    expect(sealed.scopeAlignment).toBe("aligned");
    expect(sealed.rationaleStatus).toBe("ready");
    expect(sealed.modalFallbackRequired).toBe(false);
  });

  it("preserves the failed-status invariants (null suggestion, unknown scope)", () => {
    const failed = createRationaleApprovalDisplay({
      toolName: "agent_spawn",
      canonicalTargets: ["session:abc"],
      requestedEffects: ["change-host-or-agent-state"],
      affectedResources: ["conversation"],
      requiredAuthority: "host-orchestration",
      effectiveVerdict: { level: "high", reason: "generation failed" },
      scopeAlignment: "unknown",
      scopeReasons: ["generation timed out"],
      rationaleStatus: "failed",
      suggestion: null,
      modalFallbackRequired: true,
    });
    const sealed = sealMaskedRationaleApprovalDisplay(failed, inflating);
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
    expect(sealed.suggestion).toBeNull();
    expect(sealed.scopeAlignment).toBe("unknown");
  });

  it("keeps a full-to-cap list intact", () => {
    // Test the exact-cap boundary because constructors reject over-cap displays.
    const atCap = Array.from(
      { length: RATIONALE_DISPLAY_CAPS.listItems },
      (_, i) => `reason-${i}`,
    );
    const display = readyDisplay({ scopeReasons: atCap });
    const sealed = sealMaskedRationaleApprovalDisplay(display, identity);
    expect(sealed.scopeReasons).toEqual(atCap);
    expect(parseRationaleApprovalDisplay({ ...sealed })).not.toBeNull();
  });
});
