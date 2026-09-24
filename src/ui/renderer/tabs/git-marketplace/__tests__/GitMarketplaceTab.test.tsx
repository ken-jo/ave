/**
 * The git marketplace tab (design §15.1–§15.3): browsing by kind, the first
 * sync of a never-read source, the installed view with a package bound to no
 * source, and a package's sheet from detail through review to the result.
 */
// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeMockAveApi } from "../../../../../../test/renderer/mock-ave-api.js";
import type { AveApi } from "../../../types.js";
import { GitMarketplaceTab } from "../GitMarketplaceTab.js";
import { COMMIT_A, COMMIT_B, entry, fakeMarketplace, installPlan, source } from "./fixtures.js";

function renderTab(fake: ReturnType<typeof fakeMarketplace>) {
  const { api } = makeMockAveApi();
  Object.assign(api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
  const onOpenMcpSettings = vi.fn();
  render(<GitMarketplaceTab api={api as unknown as AveApi} onOpenMcpSettings={onOpenMcpSettings} />);
  return { api, onOpenMcpSettings };
}

const official = source({ id: "ave-official", origin: "official", label: "Ave Official", canRemove: false, canDisable: false });
const team = source({ id: "team", label: "Team tools" });

describe("GitMarketplaceTab browse", () => {
  it("lists every shown source's packages and filters them by kind", async () => {
    const fake = fakeMarketplace({
      sources: [official, team],
      entries: [entry("ave-official", "plugin", "calendar"), entry("team", "skill", "proofread"), entry("team", "mcp", "weather")],
    });
    renderTab(fake);

    expect(await screen.findByTestId("git-marketplace:card:ave-official:plugin:calendar")).toBeInTheDocument();
    expect(screen.getByTestId("git-marketplace:summary").textContent).toContain("소스 2개의 패키지 3개");

    fireEvent.click(screen.getByTestId("git-marketplace:kind:skill"));
    expect(screen.getByTestId("git-marketplace:card:team:skill:proofread")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:card:ave-official:plugin:calendar")).toBeNull();
    expect(screen.queryByTestId("git-marketplace:card:team:mcp:weather")).toBeNull();
  });

  it("syncs a shown source that was never read, once", async () => {
    const fake = fakeMarketplace({ sources: [source({ id: "team", status: { state: "never-synced" }, pinnedCommit: null })] });
    renderTab(fake);

    await waitFor(() => expect(fake.market.refreshSources).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("git-marketplace:empty")).toHaveTextContent("소스를 처음으로 읽는 중");
    fake.emitSyncProgress({ sourceId: "team", state: "done" });
    await waitFor(() => expect(fake.market.listSources).toHaveBeenCalledTimes(2));
    fake.emitCatalogChanged();
    await waitFor(() => expect(fake.market.listSources).toHaveBeenCalledTimes(3));
    expect(fake.market.refreshSources).toHaveBeenCalledTimes(1);
  });

  it("searches without re-subscribing to the marketplace events", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [entry("team", "skill", "proofread")] });
    renderTab(fake);
    await screen.findByTestId("git-marketplace:card:team:skill:proofread");

    fireEvent.change(screen.getByTestId("git-marketplace:search"), { target: { value: "proof" } });
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenLastCalledWith({ query: "proof" }));
    expect(fake.market.onCatalogChanged).toHaveBeenCalledTimes(1);
    expect(fake.market.listSources).toHaveBeenCalledTimes(1);

    // The event re-reads with the filter now in the box.
    fake.emitCatalogChanged();
    await waitFor(() => expect(fake.market.listSources).toHaveBeenCalledTimes(2));
    expect(fake.market.listCatalog).toHaveBeenLastCalledWith({ query: "proof" });
  });

  it("uninstalls an MCP server bound to no source from Installed, keeping its data", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [
        entry("team", "skill", "proofread", { state: { state: "installed", version: "1.0.0" } }),
        entry(null, "mcp", "weather", { state: { state: "unbound", version: null }, sourceOrigin: null, sourceLabel: null }),
      ],
    });
    renderTab(fake);
    await screen.findByTestId("git-marketplace:card:team:skill:proofread");

    fireEvent.click(screen.getByTestId("git-marketplace:installed"));
    const card = await screen.findByTestId("git-marketplace:card:unbound:mcp:weather");
    fireEvent.click(within(card).getByRole("button", { name: "제거" }));

    await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledWith({ sourceId: null, kind: "mcp", name: "weather", removeData: false }));
  });

  it("opens on the kind another settings tab asked for", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [entry("team", "skill", "proofread"), entry("team", "theme", "dusk")] });
    const { api } = makeMockAveApi();
    Object.assign(api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
    render(<GitMarketplaceTab api={api as unknown as AveApi} initialKind="theme" onOpenMcpSettings={vi.fn()} />);

    expect(await screen.findByTestId("git-marketplace:card:team:theme:dusk")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:card:team:skill:proofread")).toBeNull();
  });
});

describe("GitMarketplaceTab package sheet", () => {
  it("reviews the plan and installs exactly the plan it showed", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar) });
    let finish: (value: unknown) => void = () => undefined;
    fake.market.executeInstall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    expect(await within(sheet).findByText("https://github.com/example/market.git")).toBeInTheDocument();
    expect(within(sheet).getByText("네트워크: api.example.com")).toBeInTheDocument();

    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    await within(sheet).findByTestId("git-marketplace:review");
    expect(fake.market.planInstall).toHaveBeenCalledWith({ sourceId: "team", kind: "plugin", name: "calendar" });
    expect(within(sheet).getByText(/커밋 aaaaaaa에 고정/)).toBeInTheDocument();

    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1");
    await within(sheet).findByTestId("git-marketplace:installing");
    fake.emitInstallProgress({ planId: "other-plan", phase: "activating", rung: null, bytes: null, total: null });
    fake.emitInstallProgress({ planId: "plan-1", phase: "downloading", rung: "release", bytes: 10, total: 100 });
    await waitFor(() => expect(within(sheet).getByTestId("git-marketplace:installing")).toHaveTextContent("아티팩트 내려받고 검증하는 중"));

    finish({ ok: true, value: { key: calendar.key, version: "1.0.0", action: { action: "install" }, rungs: [{ rung: "release", outcome: "used" }] } });
    expect(await within(sheet).findByTestId("git-marketplace:done")).toHaveTextContent("calendar 1.0.0을(를) 설치했습니다.");
    await waitFor(() => expect(fake.market.listCatalog.mock.calls.length).toBeGreaterThan(1));
  });

  it("holds a source switch until the switch is acknowledged", async () => {
    const calendar = entry("team", "plugin", "calendar", { state: { state: "installed-elsewhere", sourceId: "ave-official", version: "0.9.0" } });
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar, { action: { action: "switch", fromSource: "ave-official", from: "0.9.0" } }) });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    await within(sheet).findByTestId("git-marketplace:review");
    expect(fake.market.planInstall).toHaveBeenCalledWith({ sourceId: "team", kind: "plugin", name: "calendar", switchSource: true });
    expect(within(sheet).getByText(/플러그인 데이터는 유지되므로/)).toBeInTheDocument();

    const confirm = within(sheet).getByTestId("git-marketplace:confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(sheet).getByTestId("git-marketplace:switch-consent"));
    expect(confirm).toBeEnabled();
  });

  it("opens an update on its plan and asks to trust rewritten history", async () => {
    const calendar = entry("team", "plugin", "calendar", { state: { state: "update", from: "1.0.0", to: "1.1.0" } });
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planUpdate.mockResolvedValue({
      ok: true,
      value: {
        ...installPlan(calendar, { version: "1.1.0", action: { action: "replace", direction: "upgrade", from: "1.0.0" }, versionCommit: COMMIT_B }),
        from: "1.0.0",
        commitRange: { from: COMMIT_A, to: COMMIT_B },
        authorityDelta: { added: { capabilities: [], networkHosts: ["upload.example.com"], secrets: [], pluginAccess: [], dependencies: [] }, removed: { capabilities: [], networkHosts: [], secrets: [], pluginAccess: [], dependencies: [] } },
        historyRewritten: { pinned: COMMIT_A, candidate: COMMIT_B },
        needsConfirmation: true,
      },
    });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    await within(sheet).findByTestId("git-marketplace:rewritten");
    expect(fake.market.planUpdate).toHaveBeenCalledWith({ sourceId: "team", kind: "plugin", name: "calendar" });
    expect(within(sheet).getByText("+ 네트워크: upload.example.com")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "1.0.0 유지" })).toBeInTheDocument();

    const confirm = within(sheet).getByTestId("git-marketplace:confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(sheet).getByTestId("git-marketplace:trust-rewrite"));
    expect(confirm).toBeEnabled();
  });

  it("does not offer to install a plan that has expired", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar, { expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    expect(await within(sheet).findByTestId("git-marketplace:confirm")).toBeDisabled();
  });

  it("shows the failure's sentence and a diagnostic naming the plan", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar) });
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "PLAN_EXPIRED", message: "plan plan-1 expired" });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));

    const failed = await within(sheet).findByTestId("git-marketplace:failed");
    expect(failed).toHaveTextContent("이 계획은 더 이상 유효하지 않습니다.");
    expect(failed).toHaveTextContent("PLAN_EXPIRED · plugin calendar 1.0.0 from team");
  });

  it("uninstalls an MCP server with its data only when asked", async () => {
    const weather = entry("team", "mcp", "weather", { state: { state: "installed", version: "1.0.0" } });
    const fake = fakeMarketplace({ sources: [team], entries: [weather] });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:mcp:weather")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByRole("checkbox"));
    fireEvent.click(within(sheet).getByTestId("git-marketplace:uninstall"));
    await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledWith({ sourceId: "team", kind: "mcp", name: "weather", removeData: true }));
  });

  it("offers no uninstall for a package the policy requires", async () => {
    const calendar = entry("team", "plugin", "calendar", { state: { state: "installed", version: "1.0.0" }, required: true });
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    renderTab(fake);

    const card = await screen.findByTestId("git-marketplace:card:team:plugin:calendar");
    expect(within(card).queryByTestId("git-marketplace:card:state")).toBeNull();
    fireEvent.click(within(card).getAllByRole("button")[0]!);
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    await within(sheet).findByText("https://github.com/example/market.git");
    expect(within(sheet).queryByTestId("git-marketplace:uninstall")).toBeNull();
    expect(within(sheet).getByText("조직에서 필수로 지정")).toBeInTheDocument();
  });
});
