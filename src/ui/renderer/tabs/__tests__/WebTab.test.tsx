/** Keep testid and data-value stable for the browser toggle contract. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { WEB_PROVIDERS } from "../../constants.js";
import { WebTab } from "../WebTab.js";
import type { AveApi } from "../../types.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

const WEB_SETTINGS = {
  ...MOCK_DEFAULT_SETTINGS,
  webView: { preferredFlow: "in-app" },
};

function installApi(settings: Record<string, unknown> = WEB_SETTINGS): AveApi {
  const { api } = makeMockAveApi({ settings });
  (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
  return api as unknown as AveApi;
}

function renderWebTab(api = installApi()) {
  return render(
    <WebTab
      api={api}
      webProvider="duckduckgo"
      setWebProvider={() => {}}
      hasWebKey={false}
      setHasWebKey={() => {}}
      webKeyInput=""
      setWebKeyInput={() => {}}
      onSaved={() => {}}
    />,
  );
}

describe("WebTab — webView preferredFlow section", () => {
  it("offers only implemented search providers", () => {
    expect(WEB_PROVIDERS.map((provider) => provider.id)).toEqual(["duckduckgo", "tavily", "serper"]);
  });

  it("discloses fallback when a selected provider has no stored key", () => {
    const api = installApi();
    const props = {
      api, webProvider: "tavily" as const, setWebProvider: () => {}, hasWebKey: false,
      setHasWebKey: () => {}, webKeyInput: "", setWebKeyInput: () => {}, onSaved: () => {},
    };
    const { getByRole, queryByRole, rerender } = render(<WebTab {...props} />);
    expect(getByRole("status").textContent).toContain("DuckDuckGo");
    rerender(<WebTab {...props} hasWebKey />);
    expect(queryByRole("status")).toBeNull();
  });

  it("renders in-app and system-browser radio options (relocated from Appearance)", () => {
    const { getByTestId } = renderWebTab();
    const group = getByTestId("webview-preferred-flow");
    expect(group).toBeTruthy();
    expect(group.querySelector('[data-value="in-app"]')).toBeTruthy();
    expect(group.querySelector('[data-value="system-browser"]')).toBeTruthy();
  });
});
