// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpTab } from "../McpTab.js";
import { SettingsEditorProvider, _unregisteredSettingsControlsForTest } from "../../context/SettingsEditorContext.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { t } from "../../../../i18n/runtime.js";

const id = "local-notes";
afterEach(() => vi.unstubAllGlobals());
function install() {
  let present = true;
  const mcp = {
    servers: vi.fn(async () => []),
    getConfigs: vi.fn(async () => [{ id, transport: "stdio", command: "notes-server", auth: "api-key" }]),
    getConfigPath: vi.fn(async () => "mcp/servers.json"),
    getManagementState: vi.fn(async () => ({ policyPath: "governance/mcp-policy.json", policyStatus: "absent", userServersAllowed: true, managedServerIds: [],
      hasApiKey: { [id]: present }, servers: { [id]: { fingerprint: "a".repeat(64), trusted: true, arguments: [], argumentCount: 0, environmentKeys: [] } } })),
    clearApiKey: vi.fn(async () => { present = false; }),
  };
  vi.stubGlobal("ave", { mcp });
  const { api } = makeMockAveApi();
  return { mcp, api };
}

describe("MCP modified settings", () => {
  it("registers secret presence with an owning reset without reading its value", async () => {
    const { api, mcp } = install();
    render(<SettingsEditorProvider api={api as never} modifiedOnly={false}><McpTab /></SettingsEditorProvider>);
    const label = t("mcpTab.credentialSetting", { id });
    const reset = await screen.findByRole("button", { name: t("settingsEditor.resetLabel", { label }) });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    await waitFor(() => expect(mcp.clearApiKey).toHaveBeenCalledExactlyOnceWith(id));
    expect(await screen.findByText(t("mcpTab.missingApiKey"))).toBeVisible();
    expect(mcp).not.toHaveProperty("getApiKey");
  });

  it("marks new-server drafts transient and identifies the write-only persisted key editor", async () => {
    const { api } = install();
    const { container } = render(<SettingsEditorProvider api={api as never} modifiedOnly={false}><McpTab /></SettingsEditorProvider>);
    await screen.findByText(id);
    const edit = screen.getByRole("button", { name: t("mcpTab.setKeyButton") });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    expect(container.querySelector('input[data-setting-id="mcp.apiKey.local-notes"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("mcpTab.addServerButton") }));
    expect(container.querySelector('[data-settings-transient="mcp-server-draft"] input')).toBeTruthy();
    expect(_unregisteredSettingsControlsForTest(container)).toEqual([]);
  });

  it("keeps a failed presence read visible and retries on the editor reload epoch", async () => {
    const { api, mcp } = install();
    mcp.getManagementState.mockRejectedValueOnce(new Error("Presence read failed"));
    const { rerender } = render(<SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={0}><McpTab /></SettingsEditorProvider>);
    expect(await screen.findAllByText(/Presence read failed/)).not.toHaveLength(0);
    rerender(<SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={1}><McpTab /></SettingsEditorProvider>);
    await waitFor(() => expect(mcp.getManagementState).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: t("mcpTab.clearApiKey") })).toBeVisible();
  });
  it("ignores an older presence response after the editor reloads", async () => {
    const { api, mcp } = install();
    const old = await mcp.getManagementState();
    mcp.getManagementState.mockClear();
    let resolve!: (value: typeof old) => void;
    const pending = new Promise<typeof old>((done) => { resolve = done; });
    mcp.getManagementState.mockImplementationOnce(() => pending)
      .mockResolvedValueOnce({ ...old, hasApiKey: { [id]: false } });
    const { rerender } = render(<SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={0}><McpTab /></SettingsEditorProvider>);
    await waitFor(() => expect(mcp.getManagementState).toHaveBeenCalledOnce());
    rerender(<SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={1}><McpTab /></SettingsEditorProvider>);
    expect(await screen.findByText(t("mcpTab.missingApiKey"))).toBeVisible();
    await act(async () => { resolve(old); });
    expect(screen.getByText(t("mcpTab.missingApiKey"))).toBeVisible();
    expect(screen.queryByRole("button", { name: t("mcpTab.clearApiKey") })).toBeNull();
  });

});
