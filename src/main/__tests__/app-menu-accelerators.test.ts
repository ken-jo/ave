import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyShortcutBindingsPatch, shortcutPlatformOf, type ShortcutSettings } from "../../shared/shortcuts.js";

const setApplicationMenu = vi.fn();
vi.mock("electron", () => ({
  app: { name: "Ave" },
  Menu: { setApplicationMenu: (...a: unknown[]) => setApplicationMenu(...a), buildFromTemplate: (template: unknown) => ({ template }) },
}));
vi.mock("../../i18n/index.js", () => ({ getLocale: () => "en", t: (key: string) => key }));
let shortcuts: ShortcutSettings | null = null;
vi.mock("../app-state.js", () => ({
  getMainWindow: () => null,
  getServices: () => (shortcuts === null ? null : {
    settingsService: { get: (key: string) => (key === "shortcuts" ? shortcuts : undefined) },
    pluginRuntime: { listUiExtensions: () => [] },
  }),
}));
vi.mock("../native-window-coordinator.js", () => ({
  requestNativeChromeRefresh: vi.fn(),
  requestOpenNewMainWindow: vi.fn(),
  requestShowOrCreateMainWindow: vi.fn(),
}));

const platform = shortcutPlatformOf(process.platform);
const base: ShortcutSettings = { toggleWindow: null, enabled: false, bindings: {} };

/** Every item of the built application menu, flattened. */
function menuItems(): { label?: string; accelerator?: string }[] {
  const built = setApplicationMenu.mock.calls.at(-1)?.[0] as { template: { submenu?: unknown[] }[] };
  return built.template.flatMap((menu) => (menu.submenu ?? []) as { label?: string; accelerator?: string }[]);
}

beforeEach(() => {
  setApplicationMenu.mockClear();
  shortcuts = null;
});

describe("application menu accelerators", () => {
  it("use the registry defaults before settings exist", async () => {
    const { createSettingsMenuItem, refreshApplicationMenu } = await import("../app-menu.js");
    expect(createSettingsMenuItem().accelerator).toBe("CommandOrControl+,");
    refreshApplicationMenu();
    expect(menuItems().find((item) => item.label === "be_main.menuNewWindow")?.accelerator).toBe("CommandOrControl+Shift+N");
  });

  it("follow a rebind, and return to the default on reset", async () => {
    const { createSettingsMenuItem, refreshApplicationMenu } = await import("../app-menu.js");
    shortcuts = { ...base, bindings: applyShortcutBindingsPatch(base, { "menu.settings": "CommandOrControl+Alt+P", "menu.newWindow": "CommandOrControl+Alt+N" }, platform) };
    expect(createSettingsMenuItem().accelerator).toBe("CommandOrControl+Alt+P");
    refreshApplicationMenu();
    const items = menuItems();
    expect(items.find((item) => item.label === "be_main.menuSettings")?.accelerator).toBe("CommandOrControl+Alt+P");
    expect(items.find((item) => item.label === "be_main.menuNewWindow")?.accelerator).toBe("CommandOrControl+Alt+N");
    // The old key is no longer on any item.
    expect(items.some((item) => item.accelerator === "CommandOrControl+,")).toBe(false);

    shortcuts = { ...shortcuts, bindings: applyShortcutBindingsPatch(shortcuts, { "menu.settings": "CommandOrControl+," }, platform) };
    expect(shortcuts.bindings).toEqual({ "menu.newWindow": "CommandOrControl+Alt+N" });
    expect(createSettingsMenuItem().accelerator).toBe("CommandOrControl+,");
  });
});
