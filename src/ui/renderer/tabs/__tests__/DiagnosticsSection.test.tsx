import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MOCK_DEFAULT_SETTINGS, installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { DiagnosticsSection } from "../DiagnosticsSection.js";
import { t } from "../../../../i18n/runtime.js";
import { SavedToastProvider } from "../../context/SavedToastContext.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import type { SettingsUpdateResult } from "../../types.js";

function installDiagnosticsApi() {
  const api = installMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, diagnostics: { includeCrashDumps: false, logRetentionDays: 7 } } });
  const tail = vi.fn(async (_args?: unknown): Promise<unknown> => ({ ok: true, lines: ["latest log"] }));
  const exportBundle = vi.fn(async (): Promise<unknown> => ({ ok: false, canceled: true }));
  const crashList = vi.fn(async (): Promise<unknown> => ({ ok: true, dumps: [] }));
  Object.assign(api, {
    logs: { tail },
    diagnostics: { export: exportBundle, crashList },
  });
  return { api, tail, exportBundle, crashList };
}

function renderDiagnostics(from = "2026-01-01", to = "2026-01-31", saved = vi.fn()) {
  return { ...render(<SavedToastProvider value={saved}><DiagnosticsSection defaultDateFrom={from} defaultDateTo={to} /></SavedToastProvider>), saved };
}

describe("DiagnosticsSection filters", () => {
  it("loads changed log levels immediately and ignores older responses", async () => {
    const { tail } = installDiagnosticsApi();
    let finishOld: (result: { ok: boolean; lines: string[] }) => void = () => { throw new Error("not requested"); };
    tail.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const view = renderDiagnostics();
    await waitFor(() => expect(tail).toHaveBeenCalledTimes(1));
    fireEvent.change(view.getByRole("combobox", { name: t("auditTab.logLevel") }), { target: { value: "error" } });
    await view.findByText("latest log");
    expect(tail).toHaveBeenLastCalledWith({ lines: 200, level: "error" });
    await act(async () => finishOld({ ok: true, lines: ["stale log"] }));
    expect(view.queryByText("stale log")).toBeNull();
  });

  it("names the bundle export range and refuses reversed dates before IPC", async () => {
    const { exportBundle } = installDiagnosticsApi();
    const view = renderDiagnostics("2026-02-01", "2026-01-01");
    expect(view.getByTestId("diagnostics-export-range")).toHaveTextContent("2026-02-01");
    expect(view.getByTestId("diagnostics-export-range")).toHaveTextContent("2026-01-01");
    await waitFor(() => expect(view.getByRole("button", { name: t("auditTab.bundleExportButton") })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: t("auditTab.bundleExportButton") }));
    await view.findByText(t("auditTab.invalidDateRange"));
    expect(exportBundle).not.toHaveBeenCalled();
  });
});

describe("DiagnosticsSection crash-dump consent persistence", () => {
  it.each(["rejected", "refused"] as const)("rolls back a %s save and only reports saved after a corrected retry persists", async (failure) => {
    const { api } = installDiagnosticsApi();
    if (failure === "rejected") api.updateSettings.mockRejectedValueOnce(new Error("Storage unavailable"));
    else api.updateSettings.mockResolvedValueOnce({ ok: false, error: "invalid-args" });
    const view = renderDiagnostics();
    const checkbox = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await view.findByRole("alert");
    expect(checkbox).not.toBeChecked();
    expect((await api.getSettings()).diagnostics.includeCrashDumps).toBe(false);
    expect(view.saved).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(view.saved).toHaveBeenCalledOnce());
    expect(checkbox).toBeChecked();
    expect((await api.getSettings()).diagnostics.includeCrashDumps).toBe(true);
    expect(view.queryByRole("alert")).toBeNull();
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("disables consent and export while saving and rolls back to the latest stored broadcast", async () => {
    const { api, exportBundle } = installDiagnosticsApi();
    const normalUpdate = api.updateSettings.getMockImplementation();
    if (!normalUpdate) throw new Error("Settings update implementation is missing.");
    const pending = deferred<SettingsUpdateResult>();
    api.updateSettings.mockReturnValueOnce(pending.promise);
    const view = renderDiagnostics();
    const checkbox = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
    const exportButton = view.getByRole("button", { name: t("auditTab.bundleExportButton") });
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(exportButton).toBeDisabled();
    fireEvent.click(exportButton);
    expect(exportBundle).not.toHaveBeenCalled();
    await act(async () => { await normalUpdate({ diagnostics: { includeCrashDumps: true } }); });
    await act(async () => { pending.resolve({ ok: false, error: "invalid-args" }); });
    await view.findByRole("alert");
    expect(checkbox).toBeChecked();
    expect((await api.getSettings()).diagnostics.includeCrashDumps).toBe(true);
    expect(checkbox).toBeEnabled();
    expect(exportButton).toBeEnabled();
    expect(view.saved).not.toHaveBeenCalled();
  });

  it("shows an initial load error and only enables export after an explicit successful retry", async () => {
    const { api } = installDiagnosticsApi();
    const stored = await api.getSettings();
    api.getSettings.mockRejectedValueOnce(new Error("Storage unavailable"));
    api.getSettings.mockResolvedValueOnce({ ...stored, diagnostics: { ...stored.diagnostics, includeCrashDumps: true } });
    const view = renderDiagnostics();
    const checkbox = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
    const exportButton = view.getByRole("button", { name: t("auditTab.bundleExportButton") });
    expect(checkbox).toBeDisabled();
    expect(exportButton).toBeDisabled();
    expect(await view.findByRole("alert")).toHaveTextContent(t("auditTab.bundleConsentLoadFailed"));
    expect(checkbox).toBeDisabled();
    fireEvent.click(view.getByRole("button", { name: t("common.retry") }));
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).toBeChecked();
    expect(exportButton).toBeEnabled();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.saved).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("treats an incomplete consent snapshot as a visible load failure", async () => {
    const { api } = installDiagnosticsApi();
    api.getSettings.mockResolvedValueOnce({ ...MOCK_DEFAULT_SETTINGS });
    const view = renderDiagnostics();
    expect(await view.findByRole("alert")).toHaveTextContent(t("auditTab.bundleConsentLoadFailed"));
    expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toBeDisabled();
    expect(view.saved).not.toHaveBeenCalled();
  });
});

it("keeps a newer stored broadcast when an earlier successful save response arrives late", async () => {
  const { api } = installDiagnosticsApi();
  const normalUpdate = api.updateSettings.getMockImplementation();
  if (!normalUpdate) throw new Error("Settings update implementation is missing.");
  const pending = deferred<SettingsUpdateResult>();
  const snapshot = await api.getSettings();
  api.updateSettings.mockReturnValueOnce(pending.promise);
  const view = renderDiagnostics();
  const checkbox = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
  await waitFor(() => expect(checkbox).toBeEnabled());
  fireEvent.click(checkbox);
  await act(async () => { await normalUpdate({ diagnostics: { includeCrashDumps: false } }); });
  await act(async () => { pending.resolve({ ...snapshot, diagnostics: { ...snapshot.diagnostics, includeCrashDumps: true } }); });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).not.toBeChecked();
  expect((await api.getSettings()).diagnostics.includeCrashDumps).toBe(false);
  expect(view.saved).toHaveBeenCalledOnce();
});

it("does not report saved when a write response lacks its persisted consent", async () => {
  const { api } = installDiagnosticsApi();
  api.updateSettings.mockResolvedValueOnce({});
  const view = renderDiagnostics();
  const checkbox = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
  await waitFor(() => expect(checkbox).toBeEnabled());
  fireEvent.click(checkbox);
  expect(await view.findByRole("alert")).toHaveTextContent(t("auditTab.bundleConsentLoadFailed"));
  expect(checkbox).not.toBeChecked();
  expect(view.saved).not.toHaveBeenCalled();
});

describe("DiagnosticsSection response contracts", () => {
  it("shows a log error when the response contains a non-string line", async () => {
    const { tail } = installDiagnosticsApi();
    tail.mockResolvedValueOnce({ ok: true, lines: [42] });
    const view = renderDiagnostics();
    await view.findByText(t("auditTab.errLogsTailFailed"));
    expect(view.queryByText("latest log")).toBeNull();
  });

  it("shows a crash-list error when metadata does not match the host contract", async () => {
    const { crashList } = installDiagnosticsApi();
    crashList.mockResolvedValueOnce({ ok: true, dumps: [{ name: "invalid.dmp", mtime: new Date().toISOString(), size: "wrong" }] });
    const view = renderDiagnostics();
    await view.findByText(t("auditTab.errCrashListFailed"));
    expect(view.queryByText("invalid.dmp")).toBeNull();
  });

  it.each([undefined, { ok: true }, { ok: true, path: "/tmp/diagnostics.zip", bytes: -1 }])("shows an export error for malformed host result %j", async (result) => {
    const { exportBundle } = installDiagnosticsApi();
    exportBundle.mockResolvedValueOnce(result);
    const view = renderDiagnostics();
    const exportButton = view.getByRole("button", { name: t("auditTab.bundleExportButton") });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await view.findByText(t("auditTab.errExportFailed"));
    expect(view.queryByText(t("auditTab.bundleExportCanceled"))).toBeNull();
  });

  it("renders valid metadata and reports an actual successful export", async () => {
    const { crashList, exportBundle } = installDiagnosticsApi();
    crashList.mockResolvedValueOnce({ ok: true, dumps: [{ name: "fixture.dmp", mtime: "2026-11-16T00:00:00.000Z", size: 1024 }] });
    exportBundle.mockResolvedValueOnce({ ok: true, path: "/tmp/diagnostics.zip", bytes: 1024 });
    const view = renderDiagnostics();
    await view.findByText("fixture.dmp");
    const exportButton = view.getByRole("button", { name: t("auditTab.bundleExportButton") });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await view.findByText(t("auditTab.bundleExportSuccess", { bytes: "1.0 KB" }));
    expect(view.queryByText(t("auditTab.errExportFailed"))).toBeNull();
  });
});
