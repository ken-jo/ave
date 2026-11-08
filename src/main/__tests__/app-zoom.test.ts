import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../shared/appearance-settings.js";

const state = vi.hoisted(() => ({
 windows: [] as Array<{ isDestroyed: () => boolean; webContents: { isDestroyed: () => boolean; setZoomLevel: ReturnType<typeof vi.fn> } }>,
 appearance: { zoomLevel: 0 } as { zoomLevel?: number },
 patch: vi.fn(), broadcast: vi.fn(),
}));
vi.mock("../app-state.js", () => ({
 getMainWindows: () => state.windows,
 getMainWindow: () => state.windows[0],
 getServices: () => ({ settingsService: { get: () => state.appearance, patch: state.patch } }),
}));
vi.mock("../../ipc/domains/settings.js", () => ({ broadcastSettingsSnapshot: state.broadcast }));
import { applyAppZoomLevel, bindAppWindowZoom, runAppZoomCommand } from "../app-zoom.js";

beforeEach(() => {
 state.appearance = { ...DEFAULT_APPEARANCE, zoomLevel: 0 };
 state.windows = Array.from({ length: 2 }, () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, setZoomLevel: vi.fn() } }));
 state.patch.mockReset().mockImplementation(async ({ appearance }) => {
  state.appearance = { ...state.appearance, ...appearance };
  applyAppZoomLevel(state.appearance.zoomLevel);
 });
 state.broadcast.mockReset().mockResolvedValue(undefined);
});

describe("persisted app zoom commands", () => {
 it("saves serialized commands and applies each to all registered shells", async () => {
  const guest = { setZoomLevel: vi.fn() };
  await Promise.all([runAppZoomCommand("in"), runAppZoomCommand("in")]);
  expect(state.patch.mock.calls.map(([patch]) => patch.appearance.zoomLevel)).toEqual([1, 2]);
  for (const win of state.windows) expect(win.webContents.setZoomLevel.mock.calls).toEqual([[1], [2]]);
  expect(guest.setZoomLevel).not.toHaveBeenCalled();
  expect(state.broadcast).toHaveBeenCalledTimes(2);
  await runAppZoomCommand("reset");
  expect(state.appearance.zoomLevel).toBe(0);
 });
 it.each([[8, "in"], [-8, "out"]] as const)("keeps %s at its bound", async (level, command) => {
  state.appearance.zoomLevel = level;
  await runAppZoomCommand(command);
  expect(state.patch).toHaveBeenCalledWith({ appearance: { zoomLevel: level } });
 });
 it("skips destroyed windows and contents without interrupting peers", () => {
  state.windows.unshift({ isDestroyed: () => true, webContents: { isDestroyed: () => false, setZoomLevel: vi.fn() } });
  const middle = state.windows[1];
  if (!middle) throw new Error("Missing shell");
  middle.webContents.isDestroyed = () => true;
  applyAppZoomLevel(-2);
  expect(state.windows[0]?.webContents.setZoomLevel).not.toHaveBeenCalled();
  expect(state.windows[1]?.webContents.setZoomLevel).not.toHaveBeenCalled();
  expect(state.windows[2]?.webContents.setZoomLevel).toHaveBeenCalledWith(-2);
 });
 it("locks visual zoom and routes wheel zoom through the persisted commands", async () => {
  const listeners = new Map<string, (event: { preventDefault: () => void }, direction: "in" | "out") => void>();
  const setVisualZoomLevelLimits = vi.fn(async () => {});
  bindAppWindowZoom({ webContents: { setVisualZoomLevelLimits, on: (name: string, handler: (event: { preventDefault: () => void }, direction: "in" | "out") => void) => listeners.set(name, handler) } } as never);
  expect(setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
  const event = { preventDefault: vi.fn() };
  listeners.get("zoom-changed")?.(event, "in");
  await vi.waitFor(() => expect(state.appearance.zoomLevel).toBe(1));
  listeners.get("zoom-changed")?.(event, "out");
  await vi.waitFor(() => expect(state.appearance.zoomLevel).toBe(0));
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
 });
});
