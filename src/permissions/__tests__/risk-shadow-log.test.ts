import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPermissionEvents } from "../../__tests__/support/permission-events.js";
import { emitEffectShadowLog } from "../reviewer/risk-shadow-log.js";

afterEach(() => vi.restoreAllMocks());

describe("effect observation logging", () => {
  it.each([
    { source: "mcp", hostObservable: false, effects: [], hasMutatingEffect: false },
    { source: "plugin", hostObservable: true,
      effects: [{ kind: "config.get", effect: "read", target: "secret-canary" }], hasMutatingEffect: false },
    { source: "plugin", hostObservable: true,
      effects: [{ kind: "config.set", effect: "write", target: "secret-canary" }], hasMutatingEffect: true },
  ] as const)("records $source observation without effect targets", (record) => {
    const { events } = collectPermissionEvents();
    emitEffectShadowLog({
      source: record.source,
      toolName: "test_tool",
      hostObservable: record.hostObservable,
      hostObservedEffect: {
        correlationId: "effect-probe",
        hasMutatingEffect: record.hasMutatingEffect,
        effects: [...record.effects],
      },
    });
    expect(events).toEqual([expect.objectContaining({
      event: "permission_effect_observed",
      tool: "test_tool",
      source: record.source,
      hostObservable: record.hostObservable,
      hasMutatingEffect: record.hasMutatingEffect,
      correlationId: "effect-probe",
      effectCount: record.effects.length,
    })]);
    expect(JSON.stringify(events)).not.toContain("secret-canary");
  });
});
