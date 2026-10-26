import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { TelemetrySection } from "../TelemetrySection.js";
import { installMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

const BASE_SETTINGS = {
  ...MOCK_DEFAULT_SETTINGS,
  telemetry: { enabled: false, crashReportingEnabled: false },
};

describe("TelemetrySection", () => {
  it("turns telemetry back off after a consent answer that turned it on", async () => {
    const api = installMockAveApi({
      settings: {
        ...BASE_SETTINGS,
        telemetry: { enabled: true, telemetryPromptAnswered: true },
      },
    });
    const { findByTestId } = render(<TelemetrySection />);
    const toggle = await findByTestId("telemetry-enabled");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { enabled: false, telemetryPromptAnswered: true },
      });
    });
  });

  it("marks the consent prompt answered when the switch is the answer", async () => {
    const api = installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<TelemetrySection />);
    const toggle = await findByTestId("telemetry-enabled");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { enabled: true, telemetryPromptAnswered: true },
      });
    });
  });

  it("loads the stored endpoint and persists an edited one on save", async () => {
    const api = installMockAveApi({
      settings: {
        ...BASE_SETTINGS,
        telemetry: { enabled: true, endpoint: "https://old.example.com/v1" },
      },
    });
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-endpoint")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("https://old.example.com/v1"));
    fireEvent.change(input, { target: { value: "  https://new.example.com/v1  " } });
    fireEvent.click(await findByTestId("telemetry-endpoint-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { endpoint: "https://new.example.com/v1" },
      });
    });
  });

  it("shows the allowed hosts the endpoint is bounded by", async () => {
    installMockAveApi({ settings: BASE_SETTINGS, telemetryAllowedHosts: ["metrics.corp.example", "localhost"] });
    const { findByTestId } = render(<TelemetrySection />);
    const hosts = await findByTestId("telemetry-allowed-hosts");
    await waitFor(() => {
      expect(hosts.textContent).toContain("metrics.corp.example, localhost");
    });
  });

  it("locks the Sentry DSN and says why when the environment supplies it", async () => {
    installMockAveApi({ settings: BASE_SETTINGS, envForcedSettings: ["telemetry.sentryDsn"] });
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-sentry-dsn")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    const notice = await findByTestId("telemetry-sentry-dsn-forced");
    expect(notice.textContent).toContain("AVE_SENTRY_DSN");
  });

  it("keeps the crash-report endpoint unreachable while crash reporting is off", async () => {
    installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-crash-endpoint")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    fireEvent.click(await findByTestId("telemetry-crash-reporting"));
    await waitFor(() => expect(input.disabled).toBe(false));
  });
});
