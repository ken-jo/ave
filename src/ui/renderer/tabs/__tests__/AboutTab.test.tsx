import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { AboutTab } from "../AboutTab.js";
import type { AveApi } from "../../types.js";
import { DEFAULT_APP_INFO, MOCK_DEFAULT_SETTINGS, makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

const GENERAL_APP_INFO = {
  version: "0.2.3",
  electronVersion: "41.6.1",
  nodeVersion: "22.4.0",
  chromeVersion: "131.0.6778.0",
  v8Version: "13.1.201.13",
  platform: "darwin",
  arch: "arm64",
  userDataPath: "/Users/test/Library/Application Support/Ave",
  startupSettings: DEFAULT_APP_INFO.startupSettings,
  bootCrashReportEndpoint: DEFAULT_APP_INFO.bootCrashReportEndpoint,
};

function aboutTabApi(): AveApi {
  const { api } = makeMockAveApi({ appInfo: GENERAL_APP_INFO });
  window.aveApi = api as never;
  return api as unknown as AveApi;
}

describe("AboutTab (System Info)", () => {
  it("renders the resolved app version + data path", async () => {
    const api = aboutTabApi();
    const { findByTestId, findByText } = render(<AboutTab api={api} />);
    const version = await findByTestId("general-tab-app-version");
    await waitFor(() => expect(version.textContent).toContain("v0.2.3"));
    // The data path is informational text; assert presence via the user-facing copy.
    await findByText("/Users/test/Library/Application Support/Ave");
  });

  it("renders the resolved 기반 기술 stack (Electron / Node / Chromium / V8)", async () => {
    const api = aboutTabApi();
    const { findByTestId } = render(<AboutTab api={api} />);
    const electron = await findByTestId("general-tab-stack-electron");
    const node = await findByTestId("general-tab-stack-node");
    const chrome = await findByTestId("general-tab-stack-chrome");
    const v8 = await findByTestId("general-tab-stack-v8");
    await waitFor(() => {
      expect(electron.textContent).toContain("41.6.1");
      expect(node.textContent).toContain("22.4.0");
      expect(chrome.textContent).toContain("131.0.6778.0");
      expect(v8.textContent).toContain("13.1.201.13");
    });
  });
});


it("saves the automatic update preference and checks manually while it is off", async () => {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, updates: { autoCheckEnabled: false } } });
  window.aveApi = api as never;
  const { findByTestId } = render(<AboutTab api={api as unknown as AveApi} />);
  const toggle = await findByTestId("about-auto-check-updates");
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(await findByTestId("about-check-updates"));
  await waitFor(() => expect(api.checkForAppUpdates).toHaveBeenCalledOnce());
  fireEvent.click(toggle);
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ updates: { autoCheckEnabled: true } }));
});

it("shows an update check failure and preserves an unsaved preference", async () => {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, updates: { autoCheckEnabled: false } } });
  api.checkForAppUpdates.mockResolvedValueOnce({ ok: false, reason: "update-check-failed" });
  window.aveApi = api as never;
  const { findByTestId, findByRole } = render(<AboutTab api={api as unknown as AveApi} />);
  fireEvent.click(await findByTestId("about-check-updates"));
  expect(await findByRole("alert")).toBeTruthy();
  api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
  fireEvent.click(await findByTestId("about-auto-check-updates"));
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
  expect((await findByTestId("about-auto-check-updates")).getAttribute("aria-checked")).toBe("false");
});
