import { describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("electron", () => ({ app: {}, Menu: {} }));
vi.mock("../app-state.js", () => ({ getMainWindow: () => null, getServices: () => null }));
vi.mock("../native-window-coordinator.js", () => ({}));
vi.mock("../app-zoom.js", () => ({ runAppZoomCommand: run }));
import { NO_SHORTCUT_OVERRIDES, resolveShortcut, shortcutPlatformOf } from "../../shared/shortcuts.js";
import { createZoomMenuItems } from "../app-menu.js";

describe("zoom menu accelerators", () => {
 it("keeps primary, shifted and keypad commands without reserving project home", () => {
  const items = createZoomMenuItems();
  expect(items.map(item => item.accelerator)).toEqual([
   "CommandOrControl+=", "CommandOrControl+Shift+=", "CommandOrControl+numadd",
   "CommandOrControl+-", "CommandOrControl+Shift+-", "CommandOrControl+numsub", "CommandOrControl+num0",
  ]);
  const ids = [
    "menu.zoomIn", "menu.zoomInShifted", "menu.zoomInKeypad",
    "menu.zoomOut", "menu.zoomOutShifted", "menu.zoomOutKeypad", "menu.resetZoom",
  ] as const;
  expect(items.map(item => item.accelerator)).toEqual(ids.map(id => resolveShortcut(id, NO_SHORTCUT_OVERRIDES, shortcutPlatformOf(process.platform))));
  expect(items.some(item => item.accelerator === "CommandOrControl+0")).toBe(false);
  items.forEach((item, index) => {
   item.click?.({} as never, undefined, {} as never);
   expect(run).toHaveBeenLastCalledWith(index < 3 ? "in" : index < 6 ? "out" : "reset");
   if ([1, 2, 4, 5].includes(index)) expect(item).toMatchObject({ visible: false, acceleratorWorksWhenHidden: true });
  });
 });
});
