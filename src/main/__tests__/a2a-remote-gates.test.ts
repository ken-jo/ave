import { describe, expect, it } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";
import { snapshotA2ARemoteGates } from "../a2a-remote-gates.js";

function settings(features: Record<string, unknown> | undefined): Pick<SettingsService, "get"> {
  return {
    get: (key: string) => key === "features" ? features : undefined,
  } as Pick<SettingsService, "get">;
}

describe("A2A remote boot gates", () => {
  it("defaults OFF: no saved setting and no environment leaves both directions closed", () => {
    const gates = snapshotA2ARemoteGates(settings({}), {});
    expect(gates).toEqual({ outboundRouting: false, receiverProfile: false });
    expect(Object.isFrozen(gates)).toBe(true);
  });

  it("opens only on an exact boolean true setting, per direction", () => {
    expect(snapshotA2ARemoteGates(settings({ a2aRemoteRouting: true }), {}))
      .toEqual({ outboundRouting: true, receiverProfile: false });
    expect(snapshotA2ARemoteGates(settings({ a2aRemoteReceiver: true }), {}))
      .toEqual({ outboundRouting: false, receiverProfile: true });
    // Truthy non-boolean values do not open a remote network direction.
    expect(snapshotA2ARemoteGates(settings({
      a2aRemoteRouting: "true",
      a2aRemoteReceiver: 1,
    }), {})).toEqual({ outboundRouting: false, receiverProfile: false });
    expect(snapshotA2ARemoteGates(settings(undefined), {}))
      .toEqual({ outboundRouting: false, receiverProfile: false });
  });

  it("lets the environment force each direction ON only with the exact value", () => {
    const forced = snapshotA2ARemoteGates(settings({}), {
      AVE_A2A_REMOTE: "1",
      AVE_A2A_REMOTE_RECEIVER: "1",
    });
    expect(forced).toEqual({ outboundRouting: true, receiverProfile: true });
    expect(Object.isFrozen(forced)).toBe(true);
    expect(snapshotA2ARemoteGates(settings({}), {
      AVE_A2A_REMOTE: "0",
      AVE_A2A_REMOTE_RECEIVER: "true",
    })).toEqual({ outboundRouting: false, receiverProfile: false });
  });
});
