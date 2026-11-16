import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { TelemetrySection } from "../TelemetrySection.js";
import { installMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

const BASE_SETTINGS = { ...MOCK_DEFAULT_SETTINGS, telemetry: { level: "off", enabled: false, crashReportingEnabled: false } };

describe("TelemetrySection", () => {
  it.each([
    ["off", false, false], ["crash", false, true], ["error", true, true], ["all", true, true],
  ] as const)("records a coherent %s consent level", async (level, enabled, crashReportingEnabled) => {
    const initial = level === "off" ? "all" : "off";
    const api = installMockAveApi({ settings: { ...BASE_SETTINGS, telemetry: { ...BASE_SETTINGS.telemetry, level: initial } } });
    const { findByTestId } = render(<TelemetrySection />);
    const select = await findByTestId("telemetry-level") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(initial));
    fireEvent.change(select, { target: { value: level } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ telemetry: { level, enabled, crashReportingEnabled, telemetryPromptAnswered: true } }));
  });
  it("discloses preserved crash opt-out and asks for explicit confirmation", async () => {
    const api = installMockAveApi({ settings: { ...BASE_SETTINGS, telemetry: { enabled: true, level: "all", crashReportingEnabled: false } } });
    const { findByTestId } = render(<TelemetrySection />);
    const notice = await findByTestId("telemetry-legacy-consent");
    expect(api.updateSettings).not.toHaveBeenCalled();
    fireEvent.click(within(notice).getByRole("button"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ telemetry: { level: "all", enabled: true, crashReportingEnabled: true, telemetryPromptAnswered: true } }));
  });
  it("loads the stored endpoint and saves only authorized HTTPS destinations", async () => {
    const api = installMockAveApi({ settings: { ...BASE_SETTINGS, telemetry: { ...BASE_SETTINGS.telemetry, endpoint: "https://reports.example/old" } }, telemetryAllowedHosts: ["reports.example"] });
    const { findByTestId, getByRole } = render(<TelemetrySection />);
    const input = await findByTestId("telemetry-endpoint") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "http://reports.example/unsafe" } });
    fireEvent.click(await findByTestId("telemetry-endpoint-save"));
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(getByRole("alert")).toBeTruthy();
    expect(input.value).toBe("http://reports.example/unsafe");
    fireEvent.change(input, { target: { value: " https://reports.example/new " } });
    fireEvent.click(await findByTestId("telemetry-endpoint-save"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ telemetry: { endpoint: "https://reports.example/new" } }));
  });
  it("keeps the previous consent visible and reports a rejected save", async () => {
    const api = installMockAveApi({ settings: BASE_SETTINGS });
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: "invalid-input" });
    const { findByTestId, findByRole } = render(<TelemetrySection />);
    const select = await findByTestId("telemetry-level") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "all" } });
    await findByRole("alert");
    expect(select.value).toBe("off");
  });
  it("shows the enforced host list and removes the inactive integration field", async () => {
    installMockAveApi({ settings: BASE_SETTINGS, telemetryAllowedHosts: ["metrics.example"] });
    const { findByTestId, queryByTestId } = render(<TelemetrySection />);
    await waitFor(async () => expect((await findByTestId("telemetry-allowed-hosts")).textContent).toContain("metrics.example"));
    expect(queryByTestId("telemetry-sentry-dsn")).toBeNull();
  });
  it("allows configuring the crash destination before granting reporting consent", async () => {
    installMockAveApi({ settings: BASE_SETTINGS, telemetryAllowedHosts: ["metrics.example"] });
    const { findByTestId } = render(<TelemetrySection />);
    const input = await findByTestId("telemetry-crash-endpoint") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
  });
});
