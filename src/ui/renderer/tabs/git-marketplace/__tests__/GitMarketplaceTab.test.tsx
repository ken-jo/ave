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

    finish({ ok: true, value: { key: calendar.key, version: "1.0.0", action: { action: "install" }, rungs: [{ rung: "release", outcome: "used" }], connectionWarning: null } });
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

  it("says when an installed MCP server did not connect", async () => {
    const weather = entry("team", "mcp", "weather");
    const fake = fakeMarketplace({ sources: [team], entries: [weather] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(weather) });
    fake.market.executeInstall.mockResolvedValue({
      ok: true,
      value: { key: weather.key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: "Request timeout (10000ms): server/discover" },
    });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:mcp:weather")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));
    expect(await within(sheet).findByTestId("git-marketplace:done:connection")).toHaveTextContent("아직 연결되지 않았습니다: Request timeout (10000ms): server/discover");
  });

  it("closes the sheet from its close button", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [entry("team", "skill", "proofread")] });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:skill:proofread")).getByTestId("git-marketplace:card:state"));
    fireEvent.click(await screen.findByTestId("git-marketplace:sheet:close"));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:sheet")).toBeNull());
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

describe("GitMarketplaceTab deep links (blueprint 4.6)", () => {
  it("opens the package's sheet for an install link held before the tab opened, and takes it once", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar], deepLink: { action: "install", key: { sourceId: "team", kind: "plugin", name: "calendar" } } });
    renderTab(fake);

    expect(await screen.findByTestId("git-marketplace:sheet")).toBeInTheDocument();
    expect(fake.market.packageDetail).toHaveBeenCalledWith({ sourceId: "team", kind: "plugin", name: "calendar" });
    // The sheet asks; nothing is planned or installed until the user confirms there.
    expect(fake.market.planInstall).not.toHaveBeenCalled();
    expect(fake.market.executeInstall).not.toHaveBeenCalled();
    expect(fake.market.takeDeepLink).toHaveBeenCalledTimes(1);
  });

  it("leaves the sources view for the sheet when a link arrives while the tab is open", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    renderTab(fake);
    await screen.findByTestId("git-marketplace:card:team:plugin:calendar");
    fireEvent.click(screen.getByTestId("git-marketplace:open-sources"));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:card:team:plugin:calendar")).toBeNull());

    fake.deliverDeepLink({ action: "uninstall", key: { sourceId: "team", kind: "plugin", name: "calendar" } });

    expect(await screen.findByTestId("git-marketplace:sheet")).toBeInTheDocument();
    expect(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).toBeInTheDocument();
    expect(fake.market.uninstall).not.toHaveBeenCalled();
  });

  it("opens the Add dialog with an add link's address filled in, unchecked, and takes the next link's address", async () => {
    const fake = fakeMarketplace({ sources: [team], deepLink: { action: "add", url: "https://github.com/acme/tools" } });
    renderTab(fake);

    const input = await screen.findByTestId<HTMLInputElement>("git-marketplace:add:url");
    expect(input.value).toBe("https://github.com/acme/tools");
    expect(fake.market.previewSource).not.toHaveBeenCalled();
    expect(fake.market.addSource).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:add")).toBeNull());
    fake.deliverDeepLink({ action: "add", url: "acme/other" });
    expect((await screen.findByTestId<HTMLInputElement>("git-marketplace:add:url")).value).toBe("acme/other");
  });
});

describe("GitMarketplaceTab boot-install notice (design §15.1)", () => {
  const notice = {
    forYou: [
      { sourceId: "ave-official", kind: "mcp" as const, name: "weather" },
      { sourceId: "ave-official", kind: "theme" as const, name: "tokyo-night" },
    ],
    required: [{ sourceId: "corp", kind: "plugin" as const, name: "vpn" }],
  };

  it("lists what the boot installed, uninstalls a default install keeping MCP data, and dismisses", async () => {
    const fake = fakeMarketplace({ sources: [official], bootNotice: notice });
    renderTab(fake);

    const banner = await screen.findByTestId("git-marketplace:boot-notice");
    expect(banner).toHaveTextContent("tokyo-night");
    expect(banner).toHaveTextContent("vpn");
    expect(within(banner).queryByTestId("git-marketplace:boot-notice:uninstall:plugin:vpn")).toBeNull();

    fireEvent.click(within(banner).getByTestId("git-marketplace:boot-notice:uninstall:mcp:weather"));
    await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledWith({ sourceId: "ave-official", kind: "mcp", name: "weather", removeData: false }));
    await waitFor(() => expect(within(banner).queryByTestId("git-marketplace:boot-notice:uninstall:mcp:weather")).toBeNull());
    expect(within(banner).getByTestId("git-marketplace:boot-notice:uninstall:theme:tokyo-night")).toBeInTheDocument();

    fireEvent.click(within(banner).getByTestId("git-marketplace:boot-notice:dismiss"));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:boot-notice")).toBeNull());
    expect(fake.market.dismissBootInstallNotice).toHaveBeenCalledTimes(1);
  });

  it("shows a notice the boot step publishes after the tab opened", async () => {
    const fake = fakeMarketplace({ sources: [official] });
    renderTab(fake);
    await waitFor(() => expect(fake.market.bootInstallNotice).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("git-marketplace:boot-notice")).toBeNull();

    fake.applyBootInstalls(notice);
    expect(await screen.findByTestId("git-marketplace:boot-notice")).toHaveTextContent("weather");
  });
});
