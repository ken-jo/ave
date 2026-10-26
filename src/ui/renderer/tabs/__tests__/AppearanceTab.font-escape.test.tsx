/** Escape must skip the synchronous blur commit via escapingRef; a batched state reset alone leaves the blur closure
 * holding the typed draft. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { AppearanceTab } from "../AppearanceTab.js";

vi.mock("../../api-client.js", () => ({
  getApi: () => ({
    getSettings: vi.fn().mockResolvedValue({
      appearance: { schemaVersion: 2, bundleId: "tokyo-night", font: { family: "system", sizeScale: 1 } },
      webView: { preferredFlow: "in-app" },
    }),
    updateSettings: vi.fn().mockResolvedValue({}),
    onSettingsUpdated: vi.fn(() => () => {}),
  }),
}));

vi.mock("../../theme/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../theme/index.js")>("../../theme/index.js");
  return {
    ...actual,
    useTheme: () => {
      const [bundleId] = useState("tokyo-night");
      return { bundleId, setBundle: vi.fn(), followSystem: false, setFollowSystem: vi.fn(), canFollowSystem: false };
    },
    BUNDLES: actual.BUNDLES ?? [],
  };
});

describe("FontFamilyCustomInput — Escape semantics (PR #672 3차 critic M1)", () => {
  it("Escape after typing does NOT commit the typed text", async () => {
    const { container, findByLabelText } = render(<AppearanceTab />);

    const input = (await findByLabelText("사용자 정의 폰트 stack")) as HTMLInputElement;

    const { getApi } = await import("../../api-client.js");
    const api = getApi() as ReturnType<typeof getApi> & {
      updateSettings: ReturnType<typeof vi.fn>;
    };
    api.updateSettings.mockClear();

    fireEvent.change(input, { target: { value: "AttackerFont, sans-serif" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    const updateCalls = api.updateSettings.mock.calls.filter(([patch]) => {
      const family = (patch as { appearance?: { font?: { family?: string } } })?.appearance?.font?.family;
      return typeof family === "string" && family.includes("AttackerFont");
    });
    expect(updateCalls, "Escape must NOT commit the typed text via cascading onBlur").toHaveLength(0);
    expect(container).toBeTruthy();
  });
});
