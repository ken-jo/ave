import "../../../../../test/renderer/setup.js";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { StartupTab } from "../StartupTab.js";

it("restores a startup toggle and displays a refused persistence result", async () => {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, system: { launchAtStartup: false } } });
  window.aveApi = api as never;
  api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
  const { findByTestId } = render(<StartupTab />);
  const toggle = await findByTestId("startup-launch-at-startup");
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle);
  await expect(findByTestId("startup-save-error")).resolves.toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("restores a captured global binding and reports a rejected write", async () => {
  const { api } = makeMockAveApi({ settings: MOCK_DEFAULT_SETTINGS });
  window.aveApi = api as never;
  api.updateSettings.mockRejectedValueOnce(new Error("The settings write failed."));
  const { findByTestId } = render(<StartupTab />);
  const record = await findByTestId("startup-accelerator-record");
  await waitFor(() => expect(record).not.toBeDisabled());
  const capture = await findByTestId("startup-accelerator-capture");
  const before = capture.textContent;
  fireEvent.click(record);
  fireEvent.keyDown(capture, { key: "j", ctrlKey: true, shiftKey: true });
  await expect(findByTestId("startup-save-error")).resolves.toBeTruthy();
  expect(capture.textContent).toBe(before);
});
