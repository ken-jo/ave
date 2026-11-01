import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
const invoke = vi.hoisted(() => vi.fn());
const intent = vi.hoisted(() => ({ inputOrigin: "user-keyboard", userActivation: true }));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));
vi.mock("../gesture-intent.js", () => ({ ipcUserKeyboardIntent: () => intent }));
import { buildTelegramConnectionApiSurface } from "../telegram-connection-api-surface.js";

beforeEach(() => { invoke.mockReset(); });
describe("connection owner identity preload boundary", () => {
  it("submits the numeric identity with locally minted keyboard intent", async () => {
    invoke.mockResolvedValue({ ok: true });
    await expect(buildTelegramConnectionApiSurface().setOwnerUserId("123456789")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(CHANNELS.telegramConnection.setOwnerUserId, { ownerUserId: "123456789", intent });
  });

  it("refuses a broadened mutation response", async () => {
    invoke.mockResolvedValue({ ok: true, ownerUserId: "123456789" });
    await expect(buildTelegramConnectionApiSurface().setOwnerUserId("123456789"))
      .resolves.toEqual({ ok: false, error: "telegram-connection-unavailable" });
  });
});
