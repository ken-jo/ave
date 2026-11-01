import { afterEach, describe, expect, it, vi } from "vitest";
import { readTailnetOwnerLogin, tailnetOwnerLoginFromStatus } from "../tailnet-owner-identity.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const native = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: native.read }));
afterEach(() => native.read.mockReset());
const status = { BackendState: "Running", Self: { UserID: 7 }, User: { "7": { LoginName: "owner@example.test" }, "8": { LoginName: "peer@example.test" } } };

describe("local node owner identity", () => {
  it("selects only the local node user profile independently of peer identity fields", () => {
    expect(tailnetOwnerLoginFromStatus({ ...status, LoginName: "peer@example.test", headers: { "tailscale-user-login": "peer@example.test" }, Peer: { peer: { UserID: 8 } } })).toBe("owner@example.test");
    expect(tailnetOwnerLoginFromStatus({ ...status, Self: { UserID: "7" } })).toBe("owner@example.test");
  });
  it.each([null, {}, { ...status, BackendState: "NeedsLogin" }, { ...status, Self: { UserID: 0 } }, { ...status, Self: { UserID: 8, Tags: ["tag:server"] } }, { ...status, User: {} }, { ...status, User: { "7": { LoginName: " " } } }])("rejects missing, stopped, tagged or malformed local ownership: %j", value => {
    expect(tailnetOwnerLoginFromStatus(value)).toBeNull();
  });
  it("reads fresh bounded daemon status for every check without mutating native state", () => {
    native.read.mockReturnValueOnce(JSON.stringify(status)).mockReturnValueOnce(JSON.stringify({ ...status, Self: { UserID: 8 } }));
    expect(readTailnetOwnerLogin()).toBe("owner@example.test");
    expect(readTailnetOwnerLogin()).toBe("peer@example.test");
    expect(native.read).toHaveBeenCalledTimes(2);
    expect(native.read).toHaveBeenCalledWith(expect.any(String), ["status", "--json"], expect.objectContaining({ timeout: TOOL_TIMEOUT_POLICY.tailnetIdentityProbeMs, windowsHide: true }));
  });
  it("fails closed when daemon status cannot be read or decoded", () => {
    native.read.mockImplementationOnce(() => { throw new Error("unavailable"); }).mockReturnValueOnce("not-json");
    expect(readTailnetOwnerLogin()).toBeNull();
    expect(readTailnetOwnerLogin()).toBeNull();
  });
});
