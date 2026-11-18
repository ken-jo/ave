import "./setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { installSettingsEditor } from "../../src/__tests__/support/settings-editor-fixture.js";

import { McpTab } from "../../src/ui/renderer/tabs/McpTab.js";
import { t } from "../../src/i18n/runtime.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function installMcp() {
  const fixture = installSettingsEditor();
  const id = "local-notes";
  let connected = true;
  let present = true;
  const mcp = {
    servers: vi.fn(async () => [{ id, status: connected ? "connected" : "disconnected", registeredTools: [] }]),
    getConfigs: vi.fn(async () => [{ id, transport: "stdio", command: "notes-server", auth: "api-key" }]),
    getConfigPath: vi.fn(async () => "mcp/servers.json"),
    getManagementState: vi.fn(async () => ({ policyPath: "mcp/policy.json", policyStatus: "absent", userServersAllowed: true, managedServerIds: [], hasApiKey: { [id]: present },
      servers: { [id]: { fingerprint: "a".repeat(64), trusted: true, arguments: [], argumentCount: 0, environmentKeys: [] } } })),
  };
  Object.assign(fixture.ns, { mcp });
  return { ...fixture, mcp, disconnect: () => { connected = false; }, clearKey: () => { present = false; } };
}

it("revalidates server status when returning to its tab", async () => {
  const fixture = installMcp();
  const view = render(fixture.content(<McpTab />));
  await view.findByRole("button", { name: t("mcpTab.killButton") });
  view.rerender(fixture.content(null));
  fixture.disconnect();
  view.rerender(fixture.content(<McpTab />));
  await view.findByRole("button", { name: t("mcpTab.reconnect") });
  expect(fixture.mcp.servers).toHaveBeenCalledTimes(2);
});

it("refreshes management on focus and preserves that refresh across a remount", async () => {
  const fixture = installMcp();
  const view = render(fixture.content(<McpTab />));
  await view.findByRole("button", { name: t("mcpTab.killButton") });
  fixture.disconnect();
  fixture.clearKey();
  fireEvent(window, new Event("focus"));
  await view.findByText(t("mcpTab.missingApiKey"));
  expect(fixture.mcp.getConfigs).toHaveBeenCalledTimes(2);
  view.rerender(fixture.content(null));
  view.rerender(fixture.content(<McpTab />));
  expect(view.getByText(t("mcpTab.missingApiKey"))).toBeVisible();
  await waitFor(() => expect(fixture.mcp.getManagementState).toHaveBeenCalledTimes(3));
});

it("revalidates an already mounted search panel when its tab becomes active", async () => {
  const fixture = installMcp();
  const view = render(fixture.content(<McpTab active={false} />));
  await view.findByRole("button", { name: t("mcpTab.killButton") });
  fixture.disconnect();
  view.rerender(fixture.content(<McpTab active />));
  await view.findByRole("button", { name: t("mcpTab.reconnect") });
  expect(Object.values(fixture.mcp).map((read) => read.mock.calls.length)).toEqual([2, 2, 2, 2]);
  view.rerender(fixture.content(<McpTab active={false} />));
  expect(Object.values(fixture.mcp).map((read) => read.mock.calls.length)).toEqual([2, 2, 2, 2]);
});

it("preserves unchanged polled state and invalidates a changed status before a search remount", async () => {
  vi.useFakeTimers();
  const fixture = installMcp();
  Object.assign(fixture.mcp, { getConfigs: vi.fn(async () => [{ id: "local-notes", transport: "http", url: "https://notes.example.test/mcp", auth: "oauth" }]) });
  const view = render(fixture.content(<McpTab active={false} />));
  await act(() => Promise.resolve());
  expect(view.getByRole("button", { name: t("mcpTab.killButton") })).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(fixture.mcp.servers).toHaveBeenCalledTimes(2);
  view.rerender(fixture.content(null));
  await act(async () => { view.rerender(fixture.content(<McpTab active={false} />)); });
  expect(fixture.mcp.getConfigs).toHaveBeenCalledTimes(1);
  fixture.disconnect();
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(view.getByRole("button", { name: t("mcpTab.reconnect") })).toBeVisible();
  view.rerender(fixture.content(null));
  await act(async () => { view.rerender(fixture.content(<McpTab active={false} />)); });
  expect(view.getByRole("button", { name: t("mcpTab.reconnect") })).toBeVisible();
  expect(fixture.mcp.getConfigs).toHaveBeenCalledTimes(2);
});
