import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../../../../data/settings-defaults.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { SettingsEditorProvider } from "../../context/SettingsEditorContext.js";
import { SavedToastProvider } from "../../context/SavedToastContext.js";
import { AuditTab } from "../AuditTab.js";
import { DiagnosticsSection } from "../DiagnosticsSection.js";
import { RolesTab } from "../RolesTab.js";
import { UsageDashboard } from "../../components/UsageDashboard.js";
import { t } from "../../../../i18n/runtime.js";
import type { AveApi } from "../../types.js";
import type { ReactNode } from "react";

vi.mock("../TelemetrySection.js", () => ({ TelemetrySection: () => null }));

function installApi(change: (settings: typeof DEFAULT_SETTINGS) => void = () => {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  change(settings);
  const { api } = makeMockAveApi({ settings });
  Object.assign(api, {
    audit: { search: vi.fn(async () => ({ entries: [], total: 0 })), getStats: vi.fn(async () => ({ totalByType: {}, totalByDay: {}, sensitiveOps: 0 })) },
    logs: { tail: vi.fn(async () => ({ ok: true, lines: [] })) },
    diagnostics: { export: vi.fn(async () => ({ ok: false, canceled: true })), crashList: vi.fn(async () => ({ ok: true, dumps: [] })) },
    getUsageRange: vi.fn(async () => {
      const empty = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
      return { today: empty, thisWeek: empty, thisMonth: empty, perVendor: [], perModel: [], trend: [], topConversations: [], generatedAt: new Date().toISOString() };
    }),
    exportUsageCsv: vi.fn(async () => ({ ok: false, canceled: true })),
  });
  window.aveApi = api as never;
  return { api, settings };
}

function renderEditor(api: ReturnType<typeof makeMockAveApi>["api"], content: ReactNode, modifiedOnly = false) {
  return render(<SavedToastProvider value={vi.fn()}><SettingsEditorProvider api={api as unknown as AveApi} modifiedOnly={modifiedOnly}>{content}</SettingsEditorProvider></SavedToastProvider>);
}

function assertEditableControlCoverage(container: HTMLElement) {
  const registeredIds = new Set(Array.from(container.querySelectorAll('[data-setting-registered="true"]'), (row) => row.getAttribute("data-setting-id")));
  const controls = container.querySelectorAll('input:not([type="hidden"]):not([aria-hidden="true"]),textarea:not([readonly]),select,[role="switch"],[role="checkbox"]');
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const id = control.getAttribute("data-setting-id");
    const transient = control.getAttribute("data-settings-transient") === "true";
    expect(Boolean(id) !== transient, control.outerHTML).toBe(true);
    if (id) expect(registeredIds.has(id), id).toBe(true);
  }
}

describe("data settings control registrations", () => {
  it("registers stored crash consent and explicitly identifies audit and log query controls", async () => {
    const { api } = installApi();
    const view = renderEditor(api, <AuditTab />);
    await waitFor(() => expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toBeEnabled());
    await waitFor(() => assertEditableControlCoverage(view.container));
    expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toHaveAttribute("data-setting-id", "diagnostics.includeCrashDumps");
    expect(view.getByRole("combobox", { name: t("auditTab.logLevel") })).toHaveAttribute("data-settings-transient", "true");
    expect(view.getByTestId("audit-date-from")).toHaveAttribute("data-settings-transient", "true");
    expect(view.getByTestId("audit-date-to")).toHaveAttribute("data-settings-transient", "true");
  });

  it("keeps usage date ranges as query controls without writing a synthetic setting", async () => {
    const { api } = installApi();
    const view = renderEditor(api, <UsageDashboard api={api as unknown as AveApi} onNavigate={vi.fn()} />);
    fireEvent.click(view.getByRole("button", { name: t("usageDashboard.presetCustom") }));
    await view.findByLabelText(t("usageDashboard.dateFrom"));
    assertEditableControlCoverage(view.container);
    expect(view.getByLabelText(t("usageDashboard.dateFrom"))).toHaveAttribute("data-settings-transient", "true");
    expect(view.getByLabelText(t("usageDashboard.dateTo"))).toHaveAttribute("data-settings-transient", "true");
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("registers document owners and saved personas without offering a destructive document reset", async () => {
    const { api } = installApi((settings) => { settings.homeDocs.keepLatest = true; });
    api.homeDocsGetCustom.mockResolvedValue("User-owned custom instructions");
    api.listPersonaPrompts.mockResolvedValue({ prompts: [{ id: "review-persona", name: "Review persona", systemPromptAdd: "Review the proposal" }] });
    const view = renderEditor(api, <RolesTab api={api as unknown as AveApi} />);
    await waitFor(() => expect(view.getByTestId("roles-tab:agents-editor")).toHaveValue("User-owned custom instructions"));
    await waitFor(() => assertEditableControlCoverage(view.container));
    const customRow = await waitFor(() => {
      const row = view.container.querySelector('[data-setting-registered="true"][data-setting-id="homeDocuments.customAgents"]');
      expect(row).not.toBeNull();
      if (row === null) throw new Error("Custom instruction setting row is missing.");
      return row;
    });
    expect(customRow).toHaveAttribute("data-setting-modified", "true");
    expect(customRow.querySelector("button")).toBeDisabled();
    expect(customRow).toHaveTextContent(t("rolesTab.customResetUnavailable"));
    fireEvent.click(view.getByRole("button", { name: t("rolesTab.editButton") }));
    expect(view.getByLabelText(t("rolesTab.namePlaceholder"))).toHaveAttribute("data-setting-id", "personaPrompts.review-persona");
    expect(view.getByLabelText(t("rolesTab.systemPromptPlaceholder"))).toHaveAttribute("data-setting-id", "personaPrompts.review-persona");
    assertEditableControlCoverage(view.container);
    expect(api.homeDocsUpdateCustom).not.toHaveBeenCalled();
    expect(api.memoryUpdateAgentsMd).not.toHaveBeenCalled();
    expect(api.memoryUpdateUserPrefs).not.toHaveBeenCalled();
    expect(api.deletePersonaPrompt).not.toHaveBeenCalled();
  });

  it("resets crash consent to the canonical default and updates the actual checkbox", async () => {
    const { api } = installApi((settings) => { settings.diagnostics.includeCrashDumps = true; });
    const view = renderEditor(api, <DiagnosticsSection defaultDateFrom="2026-01-01" defaultDateTo="2026-01-31" />, true);
    const reset = await view.findByRole("button", { name: t("settingsEditor.resetLabel", { label: t("auditTab.bundleIncludeCrashDumps") }) });
    fireEvent.click(reset);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ diagnostics: { includeCrashDumps: DEFAULT_SETTINGS.diagnostics.includeCrashDumps } }));
    await waitFor(() => expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).not.toBeChecked());
  });

  it("resets keep-latest through its setting without clearing any document", async () => {
    const { api } = installApi((settings) => { settings.homeDocs.keepLatest = true; });
    const view = renderEditor(api, <RolesTab api={api as unknown as AveApi} />, true);
    await waitFor(() => expect(view.getByTestId("roles-tab:keep-latest")).toHaveAttribute("aria-checked", "true"));
    const reset = await view.findByRole("button", { name: t("settingsEditor.resetLabel", { label: t("rolesTab.keepLatestLabel") }) });
    fireEvent.click(reset);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ homeDocs: { keepLatest: DEFAULT_SETTINGS.homeDocs.keepLatest } }));
    await waitFor(() => expect(view.getByTestId("roles-tab:keep-latest")).toHaveAttribute("aria-checked", "false"));
    expect(api.homeDocsUpdateCustom).not.toHaveBeenCalled();
    expect(api.memoryUpdateAgentsMd).not.toHaveBeenCalled();
  });

  it("keeps a newer setting broadcast when the initial document-source settings read arrives late", async () => {
    const { api, settings } = installApi((current) => { current.homeDocs.keepLatest = true; });
    const initial = deferred<typeof DEFAULT_SETTINGS>();
    api.getSettings.mockReturnValueOnce(initial.promise);
    const view = render(<SavedToastProvider value={vi.fn()}><RolesTab api={api as unknown as AveApi} /></SavedToastProvider>);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledOnce());
    await act(async () => { await api.updateSettings({ homeDocs: { keepLatest: false } }); });
    await act(async () => { initial.resolve(settings); });
    expect(view.getByTestId("roles-tab:keep-latest")).toHaveAttribute("aria-checked", "false");
  });
});
