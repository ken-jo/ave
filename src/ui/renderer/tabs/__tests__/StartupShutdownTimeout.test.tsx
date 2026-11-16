import "../../../../../test/renderer/setup.js";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { StartupTab } from "../StartupTab.js";

it("shows an exact saved shutdown deadline outside the offered presets", async () => {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, system: { shutdownCleanupTimeoutMs: 45_001 } } });
  window.aveApi = api as never;
  const { findByTestId } = render(<StartupTab />);
  const select = await findByTestId("startup-shutdown-timeout") as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("45001"));
  expect(select.selectedOptions[0].textContent).toContain("45.001");
  expect(api.updateSettings).not.toHaveBeenCalled();
});

it("does not write the selected deadline again when unchanged", async () => {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, system: { shutdownCleanupTimeoutMs: 60_000 } } });
  window.aveApi = api as never;
  const { findByTestId } = render(<StartupTab />);
  const select = await findByTestId("startup-shutdown-timeout") as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("60000"));
  fireEvent.change(select, { target: { value: "60000" } });
  expect(api.updateSettings).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "120000" } });
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ system: { shutdownCleanupTimeoutMs: 120_000 } }));
});
