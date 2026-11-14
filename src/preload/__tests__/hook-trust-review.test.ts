import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
const { invoke, gesture } = vi.hoisted(() => ({ invoke: vi.fn(), gesture: { inputOrigin: "user-keyboard", userActivation: false } }));
vi.mock("electron", () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }));
vi.mock("../gesture-intent.js", () => ({ ipcUserKeyboardIntent: () => ({ ...gesture }), consumeUserKeyboardIntent: vi.fn() }));
import { buildInternalApiSurface } from "../internal-api-surface.js";

beforeEach(() => { invoke.mockReset(); gesture.userActivation = false; });
describe("hook trust review preload", () => {
  it("binds source and reviewed hash to the locally observed gesture", async () => {
    const request = { sourceId: "user", fileName: "pre-policy.sh", expectedSha256: "a".repeat(64), action: "accept" as const };
    const permission = buildInternalApiSurface().permission;
    await permission.hookTrustReview(request);
    expect(invoke).toHaveBeenLastCalledWith(PERMISSIONS.hookTrustReview, { ...request, intent: { inputOrigin: "user-keyboard", userActivation: false } });
    gesture.userActivation = true;
    await permission.hookTrustReview(request);
    expect(invoke).toHaveBeenLastCalledWith(PERMISSIONS.hookTrustReview, { ...request, intent: { inputOrigin: "user-keyboard", userActivation: true } });
  });
});
