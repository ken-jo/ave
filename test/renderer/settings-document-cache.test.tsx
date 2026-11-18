import "./setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { installSettingsEditor } from "../../src/__tests__/support/settings-editor-fixture.js";

import { DiagnosticsSection } from "../../src/ui/renderer/tabs/DiagnosticsSection.js";
import { MessagingConnectionsSection } from "../../src/ui/renderer/tabs/MessagingConnectionsSection.js";
import { GitMarketplaceTab } from "../../src/ui/renderer/tabs/git-marketplace/GitMarketplaceTab.js";
import { fakeMarketplace } from "../../src/ui/renderer/tabs/git-marketplace/__tests__/fixtures.js";
import { DEFAULT_SETTINGS } from "../../src/data/settings-defaults.js";
import { t } from "../../src/i18n/runtime.js";
import { DocumentSettingsContent } from "../../src/ui/renderer/tabs/DocumentSettingsContent.js";
import { RolesTab } from "../../src/ui/renderer/tabs/RolesTab.js";
import { requiredFixture } from "../../src/__tests__/support/required-fixture.js";
import { deferred } from "../../src/__tests__/support/deferred.js";
import { SettingsEditorProvider } from "../../src/ui/renderer/context/SettingsEditorContext.js";
import { SavedToastProvider } from "../../src/ui/renderer/context/SavedToastContext.js";

afterEach(() => { vi.unstubAllGlobals(); });

it("follows marketplace flag updates while its settings document copy stays mounted", async () => {
  const fixture = installSettingsEditor();
  const fake = fakeMarketplace();
  Object.assign(fixture.api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
  const view = render(fixture.content(<GitMarketplaceTab api={fixture.api as never} onOpenMcpSettings={() => {}} />));
  const toggle = await view.findByRole("switch", { name: t("gitMarketplace.maintenance.updateCheck") });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await act(async () => { await fixture.api.updateSettings({ marketplace: { updateCheckEnabled: false } }); });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
});

it("follows installed messaging updates while its settings document copy stays mounted", async () => {
  const fixture = installSettingsEditor();
  Object.assign(fixture.api, { telegramConnection: { snapshot: vi.fn(async () => ({ ok: false, error: "connection-unavailable" })), onChanged: vi.fn(() => () => {}) } });
  const view = render(fixture.content(<MessagingConnectionsSection api={fixture.api as never} expandedRowIds={[]} onToggleRow={() => {}} onRowCompleted={() => {}} />));
  await view.findByTestId("messaging-connections-content");
  await act(async () => { await fixture.api.updateSettings({ marketplace: { installedMessagingConnections: [{ connectionId: "team-messages", label: "Team messages", summary: "Team inbox", pairing: "one-time-code", credentials: [], egress: [] }] } }); });
  expect(await view.findByText("Team messages")).toBeVisible();
});

it("retries a failed consent projection from the store instead of its invalid held document", async () => {
  const fixture = installSettingsEditor();
  fixture.api.getSettings.mockResolvedValue({ ...structuredClone(DEFAULT_SETTINGS), diagnostics: { logRetentionDays: 7 } } as never);
  const view = render(fixture.content(<DiagnosticsSection defaultDateFrom="" defaultDateTo="" />));
  const retry = await view.findByRole("button", { name: t("common.retry") });
  const reads = fixture.api.getSettings.mock.calls.length;
  fixture.api.getSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
  fireEvent.click(retry);
  const consent = view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") });
  await waitFor(() => expect(consent).toBeEnabled());
  expect(fixture.api.getSettings).toHaveBeenCalledTimes(reads + 1);
  expect(view.queryByRole("button", { name: t("common.retry") })).toBeNull();
  view.rerender(fixture.content(null));
  view.rerender(fixture.content(<DiagnosticsSection defaultDateFrom="" defaultDateTo="" />));
  await waitFor(() => expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toBeEnabled());
});

it.each(["documents", "diagnostics", "roles"] as const)("updates the mounted %s projection after the editor reloads", async (section) => {
  const fixture = installSettingsEditor();
  const initial = structuredClone(DEFAULT_SETTINGS);
  initial.homeDocs.keepLatest = false;
  fixture.api.getSettings.mockResolvedValue(initial);
  const next = structuredClone(initial);
  next.documents.openMode = "link";
  next.diagnostics.includeCrashDumps = true;
  next.homeDocs.keepLatest = true;
  const panel = section === "documents" ? <DocumentSettingsContent />
    : section === "diagnostics" ? <DiagnosticsSection defaultDateFrom="" defaultDateTo="" /> : <RolesTab api={fixture.api as never} />;
  const view = render(fixture.content(panel));
  const control = () => section === "documents" ? requiredFixture(view.container.querySelector('[data-testid="document-open-mode"] [data-value="link"]'))
    : section === "diagnostics" ? view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") }) : view.getByTestId("roles-tab:keep-latest");
  await waitFor(() => expect(control()).toBeEnabled());
  fixture.api.getSettings.mockResolvedValue(next);
  view.rerender(fixture.content(panel, 1));
  await waitFor(() => expect(fixture.api.getSettings).toHaveBeenCalledTimes(2));
  await waitFor(() => {
    if (section === "diagnostics") expect(control()).toBeChecked();
    else expect(control()).toHaveAttribute("aria-checked", "true");
  });
});

it("keeps a successful retry newer than the editor's pending initial document read", async () => {
  const fixture = installSettingsEditor();
  const invalid = { ...structuredClone(DEFAULT_SETTINGS), diagnostics: { logRetentionDays: 7 } };
  const initial = deferred<typeof invalid>();
  fixture.api.getSettings.mockResolvedValueOnce(invalid as never).mockReturnValueOnce(initial.promise)
    .mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
  const content = (visible: boolean) => <SettingsEditorProvider api={fixture.api as never} modifiedOnly={false}><SavedToastProvider value={fixture.saved}>
    {visible && <DiagnosticsSection defaultDateFrom="" defaultDateTo="" />}
  </SavedToastProvider></SettingsEditorProvider>;
  const view = render(content(true));
  fireEvent.click(await view.findByRole("button", { name: t("common.retry") }));
  await waitFor(() => expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toBeEnabled());
  await act(async () => { initial.resolve(invalid); });
  view.rerender(content(false));
  view.rerender(content(true));
  await waitFor(() => expect(view.getByRole("checkbox", { name: t("auditTab.bundleIncludeCrashDumps") })).toBeEnabled());
  expect(view.queryByRole("button", { name: t("common.retry") })).toBeNull();
});
