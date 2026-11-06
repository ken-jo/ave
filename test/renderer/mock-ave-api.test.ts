import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance-settings.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "./mock-ave-api.js";

describe("mock settings snapshots", () => {
  it("defaults only appearance when a fixture omits it", async () => {
    const { api } = makeMockAveApi({ settings: { system: { sidebarState: "hidden" } } });

    const snapshot = await api.getSettings();
    expect(snapshot).toMatchObject({
      appearance: DEFAULT_APPEARANCE,
      system: { sidebarState: "hidden" },
    });
    expect(snapshot).not.toHaveProperty("llm");
    expect(snapshot).not.toHaveProperty("chat");
  });

  it("preserves a supplied appearance section exactly", async () => {
    const appearance = { mode: "dark", terminalFont: { size: 18 } };
    const { api } = makeMockAveApi({
      settings: { appearance },
    });

    expect(await api.getSettings()).toMatchObject({
      appearance,
    });
    expect((await api.getSettings() as { appearance: unknown }).appearance).toBe(appearance);
  });

  it("preserves nested settings references and later fixture changes", async () => {
    const llm = { ...MOCK_DEFAULT_SETTINGS.llm, vendors: { ...MOCK_DEFAULT_SETTINGS.llm.vendors } };
    const { api } = makeMockAveApi({ settings: { llm } });
    llm.vendors["openai-compatible"] = {
      ...llm.vendors["openai-compatible"],
      baseUrl: "http://localhost:8001/v1",
    };

    const snapshot = await api.getSettings() as { llm: typeof llm };
    expect(snapshot.llm).toBe(llm);
    expect(snapshot.llm.vendors["openai-compatible"].baseUrl).toBe("http://localhost:8001/v1");
  });

  it.each([null, undefined])("preserves explicit invalid appearance %s for boundary validation", async (appearance) => {
    const { api } = makeMockAveApi({ settings: { appearance } });

    expect(await api.getSettings()).toMatchObject({ appearance });
  });
});
