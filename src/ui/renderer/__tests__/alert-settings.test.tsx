import { triggerIntersection } from "../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginAlertsSection } from "../tabs/PluginAlertsSection.js";
import { InstalledPluginAlerts } from "../tabs/git-marketplace/InstalledPluginAlerts.js";
import { useAlertKinds } from "../hooks/use-alert-kinds.js";
import type { AlertKindRow } from "../../../shared/alerts-types.js";
import type { AveApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";

function row(pluginId = "fixturemail"): AlertKindRow {
  return { kindKey: `${pluginId}:reply`, pluginId, pluginLabel: "Mail", reasoning: "Explains why replies need attention.",
    declaration: { id: "reply", label: { en: "Reply needed" }, description: { en: "Review messages that need a reply." }, defaultEnabled: false, visibility: "user-visible", summary: { en: "Reply" }, prompt: { en: "Review" }, osNotification: { defaultEnabled: false, body: { en: "Reply needed" } } },
    choice: { enabled: false, osNotification: false, seenByUser: false, visibility: "user-visible" }, blockedByPredecessor: null, predecessor: null };
}
function harness(rows = [row()]) {
  let changed = () => {};
  const bridge = {
    listKinds: vi.fn(async () => [...rows]),
    onKindsChanged: vi.fn((callback: () => void) => { changed = callback; return vi.fn(); }),
    setKind: vi.fn(async (key: string, patch: object) => ({ ...rows.find((item) => item.kindKey === key)!, choice: { ...rows[0]!.choice, ...patch, seenByUser: true } })),
    setOsNotificationsEnabled: vi.fn(async (enabled: boolean) => ({ osNotificationsEnabled: enabled })),
    removePredecessor: vi.fn(async () => ({ ok: true as const, value: { key: { kind: "plugin" as const, name: "retired", sourceId: null }, keptDataDir: null } })),
    cardClosed: vi.fn(), listOpen: vi.fn(),
  };
  const api = { alerts: bridge, getSettings: vi.fn(async () => ({ alerts: { osNotificationsEnabled: false } })) } as unknown as AveApi;
  return { rows, bridge, api, changed: () => changed() };
}

describe("alert Settings controls", () => {
  it("marks only a visible row seen without changing either switch", async () => {
    const h = harness(); const refresh = vi.fn(async () => {});
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={refresh} />);
    expect(screen.getByText(t("alerts.new"))).toBeInTheDocument();
    expect(screen.getByText(h.rows[0]!.reasoning)).toBeInTheDocument();
    expect(h.bridge.setKind).not.toHaveBeenCalled();
    act(() => { triggerIntersection(screen.getByTestId("alert-kind:fixturemail:reply"), false); });
    expect(h.bridge.setKind).not.toHaveBeenCalled();
    act(() => { triggerIntersection(screen.getByTestId("alert-kind:fixturemail:reply")); });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(h.bridge.setKind).toHaveBeenCalledExactlyOnceWith("fixturemail:reply", {});
  });

  it.each(["rejected", "error-code"])("retries a %s acknowledgement only after another viewport entry", async (failure) => {
    const h = harness(); const refresh = vi.fn(async () => {});
    if (failure === "rejected") h.bridge.setKind.mockRejectedValueOnce(new Error("temporary"));
    else h.bridge.setKind.mockResolvedValueOnce({ error: "alerts-write-failed" } as never);
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={refresh} />);
    const control = screen.getByTestId("alert-kind:fixturemail:reply");
    act(() => { triggerIntersection(control); });
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getAllByRole("switch")[0]).toBeEnabled());
    act(() => { triggerIntersection(control); });
    expect(h.bridge.setKind).toHaveBeenCalledTimes(1);
    act(() => { triggerIntersection(control, false); triggerIntersection(control); });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(h.bridge.setKind).toHaveBeenNthCalledWith(2, "fixturemail:reply", {});
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => { triggerIntersection(control, false); triggerIntersection(control); });
    expect(h.bridge.setKind).toHaveBeenCalledTimes(2);
  });

  it("groups the built-in reasoning with its kind rather than the OS master", () => {
    const h = harness([row("@host")]);
    render(<PluginAlertsSection pluginId="@host" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    const kind = screen.getByTestId("alert-kind:@host:reply");
    expect(within(kind).getByText(h.rows[0]!.reasoning)).toBeInTheDocument();
    expect(within(kind).queryByRole("switch", { name: t("alerts.osMaster") })).toBeNull();
  });

  it("acknowledges a newly visible declaration after its visibility changes", async () => {
    const h = harness(); h.rows[0]!.declaration.visibility = "summary-only";
    const refresh = vi.fn(async () => {});
    const view = render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={refresh} />);
    act(() => { triggerIntersection(screen.getByTestId("alert-kind:fixturemail:reply")); });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    h.rows[0]!.declaration.visibility = "user-visible";
    view.rerender(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={refresh} />);
    act(() => { triggerIntersection(screen.getByTestId("alert-kind:fixturemail:reply")); });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(h.bridge.setKind).toHaveBeenLastCalledWith("fixturemail:reply", {});
  });

  it("writes enabled and OS switches independently, including while blocked", async () => {
    const h = harness(); h.rows[0]!.blockedByPredecessor = "retired";
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: t("alerts.enabledLabel", { label: "Reply needed" }) }));
    await waitFor(() => expect(h.bridge.setKind).toHaveBeenCalledWith("fixturemail:reply", { enabled: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: t("alerts.osLabel", { label: "Reply needed" }) })).toBeEnabled());
    fireEvent.click(screen.getByRole("switch", { name: t("alerts.osLabel", { label: "Reply needed" }) }));
    await waitFor(() => expect(h.bridge.setKind).toHaveBeenCalledWith("fixturemail:reply", { osNotification: true }));
  });

  it("omits an undeclared OS toggle and offers the built-in master without plugin rows", async () => {
    const h = harness(); delete h.rows[0]!.declaration.osNotification;
    const view = render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    view.rerender(<PluginAlertsSection pluginId="@host" rows={[]} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: t("alerts.osMaster") }));
    await waitFor(() => expect(h.bridge.setOsNotificationsEnabled).toHaveBeenCalledWith(true));
  });

  it("uses main's predecessor state and submits only a kind after confirmation", async () => {
    const h = harness(); const r = h.rows[0]!;
    r.blockedByPredecessor = "retired"; r.predecessor = { pluginId: "retired", label: "Previous helper", locked: false, restartRequired: true, removable: true };
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    expect(screen.getByText(t("alerts.waiting", { label: "Previous helper" }))).toBeInTheDocument();
    expect(screen.getByText(t("alerts.restart"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("alerts.remove") }));
    expect(h.bridge.removePredecessor).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t("alerts.remove") }));
    await waitFor(() => expect(h.bridge.removePredecessor).toHaveBeenCalledExactlyOnceWith("fixturemail:reply"));
  });

  it("shows managed copy without a Remove action for a locked predecessor", () => {
    const h = harness(); h.rows[0]!.blockedByPredecessor = "retired";
    h.rows[0]!.predecessor = { pluginId: "retired", label: "Previous helper", locked: true, restartRequired: false, removable: false };
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    expect(screen.getByText(t("alerts.managed"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("alerts.remove") })).toBeNull();
  });

  it("localizes rejected mutations without exposing main errors", async () => {
    const h = harness(); h.bridge.setKind.mockRejectedValueOnce(new Error("private host detail"));
    render(<PluginAlertsSection pluginId="fixturemail" rows={h.rows} api={h.bridge} osEnabled={false} refresh={async () => {}} />);
    fireEvent.click(screen.getAllByRole("switch")[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("alerts.saveFailed"));
    expect(screen.queryByText("private host detail")).toBeNull();
  });
});

describe("alert discovery", () => {
  it.each([false, true])("reports current post-install choices, enabled=%s, and opens the plugin", async (enabled) => {
    const h = harness(); h.rows[0]!.choice.enabled = enabled; const open = vi.fn();
    render(<InstalledPluginAlerts api={h.api} pluginId="fixturemail" onOpen={open} />);
    expect(await screen.findByText(t(enabled ? "alerts.available" : "alerts.availableAllOff", { count: 1 }))).toBeInTheDocument();
    expect(h.bridge.setKind).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("alerts.openSettings") }));
    expect(open).toHaveBeenCalledWith("fixturemail");
  });

  it("does not label mixed enabled choices all off and reacts to registration changes", async () => {
    const h = harness(); const second = { ...row(), kindKey: "fixturemail:new-kind", choice: { ...row().choice, enabled: true } };
    render(<InstalledPluginAlerts api={h.api} pluginId="fixturemail" onOpen={vi.fn()} />);
    await screen.findByText(t("alerts.availableAllOff", { count: 1 }));
    h.rows.push(second); act(h.changed);
    expect(await screen.findByText(t("alerts.available", { count: 2 }))).toBeInTheDocument();
  });

  it("discards an older read after a change and unsubscribes on unmount", async () => {
    const h = harness(); let resolveOld!: (rows: AlertKindRow[]) => void;
    h.bridge.listKinds.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const view = renderHook(() => useAlertKinds(h.api));
    act(h.changed);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    await act(async () => resolveOld([]));
    expect(view.result.current.rows).toHaveLength(1);
    const unsubscribe = h.bridge.onKindsChanged.mock.results[0]!.value;
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("allows a failed load to be retried", async () => {
    const h = harness(); h.bridge.listKinds.mockRejectedValueOnce(new Error("unavailable"));
    const view = renderHook(() => useAlertKinds(h.api));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.failed).toBe(false); expect(view.result.current.rows).toHaveLength(1);
  });
});
