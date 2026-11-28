import { afterEach, expect, it, vi } from "vitest";
import { watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { emitSandboxAudit } from "../egress-logging.js";
import { buildSandboxEgressDenyAuditEntry } from "../egress-observation.js";

afterEach(() => vi.restoreAllMocks());

it.each(["network-outbound", "http-request", "socks-tunnel"] as const)(
  "logs the %s refusal with bounded metadata",
  async (action) => {
    const observed = vi.fn();
    watchPermissionEvents(observed);
    await emitSandboxAudit(buildSandboxEgressDenyAuditEntry({
      timestamp: new Date(),
      sandbox: { kind: "asrt", confidence: "verified" },
      invocation: { kind: "unattributed" },
      deny: {
        action, host: "example.test", port: 123, method: "GET",
        url: "https://example.test/private", reason: "private text",
      },
    }));
    expect(observed).toHaveBeenCalledExactlyOnceWith({
      event: "sandbox_egress_denied", sandboxKind: "asrt", attribution: "unattributed", action,
    });
  },
);
