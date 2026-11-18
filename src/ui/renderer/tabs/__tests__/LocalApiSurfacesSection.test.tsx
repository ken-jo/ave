import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { LocalApiSurfacesSection } from "../LocalApiSurfacesSection.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const envForcedSettings = vi.fn();
const remoteA2aStatus = vi.fn();
const onSettingsUpdated = vi.fn();
let broadcastSettings: ((settings: unknown) => void) | undefined;

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings, onSettingsUpdated, envForcedSettings, remoteA2a: { status: remoteA2aStatus } }),
}));

let localeBeforeTest = getLocale();

beforeEach(() => {
  window.ave = { permission: { updateSecuritySettings: updateSettings } } as never;
  localeBeforeTest = getLocale();
  setLocale("en");
  getSettings.mockResolvedValue({ system: {}, features: {} });
  let stored = { system: {}, features: {} };
  updateSettings.mockImplementation(async (patch: typeof stored) => { stored = { system: { ...stored.system, ...patch.system }, features: { ...stored.features, ...patch.features } }; return stored; });
  onSettingsUpdated.mockImplementation((listener) => { broadcastSettings = listener; return () => { broadcastSettings = undefined; }; });
  envForcedSettings.mockResolvedValue([]);
  remoteA2aStatus.mockResolvedValue({ ok: false, error: "a2a-remote-disabled" });
});

afterEach(() => {
  setLocale(localeBeforeTest);
  vi.clearAllMocks();
});

describe("LocalApiSurfacesSection", () => {
  it("offers all four gates a packaged app had no way to reach", async () => {
    render(<LocalApiSurfacesSection />);

    for (const id of [
      "local-api-surfaces-local-api",
      "local-api-surfaces-a2a-loopback",
      "local-api-surfaces-a2a-remote-routing",
      "local-api-surfaces-a2a-remote-receiver",
    ]) {
      await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
    }
    // The gates are read once at boot, so the section must not imply the surface came up the moment the switch moved.
    expect(screen.getByTestId("local-api-surfaces-restart-note")).toBeTruthy();
  });

  it("writes only the settings key behind the switch that moved", async () => {
    render(<LocalApiSurfacesSection />);
    const toggle = await screen.findByTestId("local-api-surfaces-a2a-remote-routing");

    fireEvent.click(toggle);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      features: { a2aRemoteRouting: true },
    }));
  });

  it("puts the switch back when the host refuses the change", async () => {
    updateSettings.mockResolvedValue({ ok: false, error: "managed", message: "Untrusted host diagnostic" });
    render(<LocalApiSurfacesSection />);
    const toggle = await screen.findByTestId("local-api-surfaces-local-api");

    fireEvent.click(toggle);

    const error = await screen.findByTestId("local-api-surfaces-error");
    expect(error).toHaveTextContent(t("formatIpcError.managed"));
    expect(error.textContent).not.toContain("Untrusted host diagnostic");
    expect(toggle).not.toBeDisabled();
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("names the variable when the environment is forcing a gate on", async () => {
    envForcedSettings.mockResolvedValue(["system.localApiServer"]);
    render(<LocalApiSurfacesSection />);

    const note = await screen.findByTestId("local-api-surfaces-local-api-forced");
    expect(note.textContent).toContain("AVE_LOCAL_API");
    // Only the forced gate says so.
    expect(screen.queryByTestId("local-api-surfaces-a2a-loopback-forced")).toBeNull();
  });

  it("reflects what is already saved rather than defaulting to off", async () => {
    getSettings.mockResolvedValue({
      system: { localApiServer: true },
      features: { a2aLoopbackServer: true },
    });

    render(<LocalApiSurfacesSection />);

    await waitFor(() => expect(
      screen.getByTestId("local-api-surfaces-local-api").getAttribute("aria-checked"),
    ).toBe("true"));
    expect(screen.getByTestId("local-api-surfaces-a2a-loopback").getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByTestId("local-api-surfaces-a2a-remote-routing").getAttribute("aria-checked"))
      .toBe("false");
  });

  it("says why a switched-on remote gate did not start, instead of reading it as off", async () => {
    getSettings.mockResolvedValue({ system: {}, features: { a2aRemoteRouting: true } });
    remoteA2aStatus.mockResolvedValue({
      ok: false,
      error: "a2a-remote-start-failed",
      reason: "a2a-remote-outbound-config-incomplete",
    });
    render(<LocalApiSurfacesSection />);

    const notice = await screen.findByTestId("local-api-surfaces-remote-a2a-start-failed");
    expect(notice.textContent).toContain("did not start this launch");
    expect(notice.textContent).toContain("have not been provisioned");
    expect(notice.textContent).not.toContain("turned off");
    // The owner's switch still reads as they set it.
    expect(screen.getByTestId("local-api-surfaces-a2a-remote-routing").getAttribute("aria-checked"))
      .toBe("true");
  });

  it("names an unclassified start failure by its code rather than guessing", async () => {
    remoteA2aStatus.mockResolvedValue({ ok: false, error: "a2a-remote-start-failed", reason: "a2a-remote-store-unreadable" });
    render(<LocalApiSurfacesSection />);

    const notice = await screen.findByTestId("local-api-surfaces-remote-a2a-start-failed");
    expect(notice.textContent).toContain("(a2a-remote-store-unreadable)");
  });

  it("says a switch changed since launch waits for a restart, and re-reads after a toggle", async () => {
    render(<LocalApiSurfacesSection />);
    await screen.findByTestId("local-api-surfaces-local-api");
    expect(screen.queryByTestId("local-api-surfaces-remote-a2a-restart-pending")).toBeNull();

    remoteA2aStatus.mockResolvedValue({ ok: false, error: "a2a-remote-disabled", restartPending: true });
    fireEvent.click(screen.getByTestId("local-api-surfaces-a2a-remote-routing"));

    const notice = await screen.findByTestId("local-api-surfaces-remote-a2a-restart-pending");
    expect(notice.textContent).toContain("Restart Ave");
    expect(screen.queryByTestId("local-api-surfaces-remote-a2a-start-failed")).toBeNull();
  });

  it("names the inbound receiver's port this launch so the tunnel can be pointed at it", async () => {
    remoteA2aStatus.mockResolvedValue({ ok: false, error: "a2a-remote-disabled", restartPending: false, receiverPort: 48_123 });
    render(<LocalApiSurfacesSection />);
    const port = await screen.findByTestId("local-api-surfaces-remote-a2a-receiver-port");
    expect(port.textContent).toContain("127.0.0.1:48123");
  });

  it("shows no start-failure notice when the runtime is merely off or unreadable", async () => {
    render(<LocalApiSurfacesSection />);
    await screen.findByTestId("local-api-surfaces-local-api");
    expect(screen.queryByTestId("local-api-surfaces-remote-a2a-start-failed")).toBeNull();

    remoteA2aStatus.mockRejectedValue(new Error("ipc closed"));
    render(<LocalApiSurfacesSection />);
    await waitFor(() => expect(screen.getAllByTestId("local-api-surfaces-local-api")).toHaveLength(2));
    expect(screen.queryByTestId("local-api-surfaces-remote-a2a-start-failed")).toBeNull();
  });
});

it('restores security toggle state and permits retry after an IPC rejection', async () => {
  updateSettings.mockRejectedValueOnce(new Error('Disconnected host'));
  render(<LocalApiSurfacesSection />);
  const toggle = await screen.findByTestId('local-api-surfaces-a2a-remote-routing');
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  expect(toggle).not.toBeDisabled();
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  expect(updateSettings).toHaveBeenCalledTimes(2);
});

it('reconciles a persisted reset broadcast without remounting the security section', async () => {
  getSettings.mockResolvedValue({ system: {}, features: { a2aRemoteRouting: true } });
  render(<LocalApiSurfacesSection />);
  const toggle = await screen.findByTestId('local-api-surfaces-a2a-remote-routing');
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  act(() => requiredFixture(broadcastSettings)({ system: {}, features: { a2aRemoteRouting: false } }));
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  expect(updateSettings).not.toHaveBeenCalled();
});
