import { afterEach, describe, expect, it, vi } from "vitest";
import { readTailnetOwnerLogin, tailnetOwnerLoginFromStatus } from "../tailnet-owner-identity.js";

const native = vi.hoisted(() => ({ read: vi.fn(), path: vi.fn(() => "host-cli"), warn: vi.fn() }));
vi.mock("../tailnet-cli.js", () => ({ runTailscaleCommand: native.read, tailscaleCliPath: native.path }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: native.warn }) }));
afterEach(() => { native.read.mockReset(); native.warn.mockClear(); native.path.mockClear(); });
const status = { BackendState: "Running", Self: { UserID: 7 }, User: { "7": { LoginName: "owner@example.test" }, "8": { LoginName: "peer@example.test" } } };

describe("local node owner identity", () => {
  it("selects only the local node user profile independently of peer identity fields", () => {
    expect(tailnetOwnerLoginFromStatus({ ...status, LoginName: "peer@example.test", headers: { "tailscale-user-login": "peer@example.test" }, Peer: { peer: { UserID: 8 } } })).toBe("owner@example.test");
    expect(tailnetOwnerLoginFromStatus({ ...status, Self: { UserID: "7" } })).toBe("owner@example.test");
  });
  it.each([null, {}, { ...status, BackendState: "NeedsLogin" }, { ...status, Self: { UserID: 0 } }, { ...status, Self: { UserID: 8, Tags: ["tag:server"] } }, { ...status, User: {} }, { ...status, User: { "7": { LoginName: " " } } }])("rejects missing, stopped, tagged or malformed local ownership: %j", value => {
    expect(tailnetOwnerLoginFromStatus(value)).toBeNull();
  });
  it("awaits a fresh shared command runner for every observation", async () => {
    native.read.mockResolvedValueOnce({ kind: "ran", code: 0, stdout: JSON.stringify(status), stderr: "" })
      .mockResolvedValueOnce({ kind: "ran", code: 0, stdout: JSON.stringify({ ...status, Self: { UserID: 8 } }), stderr: "" });
    await expect(readTailnetOwnerLogin()).resolves.toBe("owner@example.test");
    await expect(readTailnetOwnerLogin()).resolves.toBe("peer@example.test");
    expect(native.read).toHaveBeenCalledTimes(2);
    expect(native.path).toHaveBeenCalledWith(process.platform);
    expect(native.read).toHaveBeenCalledWith("host-cli", ["status", "--json"]);
    expect(native.warn).not.toHaveBeenCalled();
  });
  it.each([
    [{ kind: "not-found" }, "ENOENT"],
    [{ kind: "failed", category: "timeout", detail: "private owner@example.test" }, "timeout"],
    [{ kind: "failed", detail: "private owner@example.test" }, "execution-failed"],
    [{ kind: "ran", code: 1, stdout: "private owner@example.test", stderr: "private" }, "nonzero-exit"],
    [{ kind: "ran", code: 0, stdout: "private owner@example.test", stderr: "" }, "invalid-json"],
    [{ kind: "ran", code: 0, stdout: JSON.stringify({ ...status, Self: { UserID: 0 } }), stderr: "" }, "owner-unavailable"],
  ])("refuses unavailable evidence and logs only its category: %j", async (result, category) => {
    native.read.mockResolvedValueOnce(result);
    await expect(readTailnetOwnerLogin()).resolves.toBeNull();
    expect(native.warn).toHaveBeenCalledWith("Owner identity probe unavailable: %s", category);
    expect(JSON.stringify(native.warn.mock.calls)).not.toMatch(/private|owner@example/);
  });
  it("does not block the event loop while a probe is pending", async () => {
    let complete!: (value: unknown) => void;
    native.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = readTailnetOwnerLogin();
    await new Promise<void>(resolve => setImmediate(resolve));
    complete({ kind: "ran", code: 0, stdout: JSON.stringify(status), stderr: "" });
    await expect(pending).resolves.toBe("owner@example.test");
  });
});
