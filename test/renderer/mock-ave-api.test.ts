import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance-settings.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "./mock-ave-api.js";

describe("mock settings snapshots", () => {
  it("keeps bootable defaults when a fixture supplies only another section", async () => {
    const { api } = makeMockAveApi({ settings: { system: { sidebarState: "hidden" } } });

    expect(await api.getSettings()).toMatchObject({
      appearance: DEFAULT_APPEARANCE,
      llm: MOCK_DEFAULT_SETTINGS.llm,
      system: { sidebarState: "hidden" },
    });
  });

  it("preserves nested overrides and their unmodified sibling defaults", async () => {
    const { api } = makeMockAveApi({
      settings: { appearance: { mode: "dark", terminalFont: { size: 18 } } },
    });

    expect(await api.getSettings()).toMatchObject({
      appearance: {
        ...DEFAULT_APPEARANCE,
        mode: "dark",
        terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, size: 18 },
      },
    });
  });

  it("preserves explicit invalid values for tests of boundary validation", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: null } });

    expect(await api.getSettings()).toMatchObject({ appearance: null });
  });
});
