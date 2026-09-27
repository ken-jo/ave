/**
 * The git marketplace tab (design §15.1–§15.3): browsing by kind, the first
 * sync of a never-read source, the installed view with a package bound to no
 * source, and a package's sheet from detail through review to the result.
 */
// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeMockAveApi } from "../../../../../../test/renderer/mock-ave-api.js";
import type { AveApi } from "../../../types.js";
import { GitMarketplaceTab } from "../GitMarketplaceTab.js";
import { requestUpdateReview } from "../update-review-request.js";
import { COMMIT_A, COMMIT_B, detail, entry, fakeMarketplace, installPlan, source } from "./fixtures.js";

function renderTab(fake: ReturnType<typeof fakeMarketplace>, overrides: Parameters<typeof makeMockAveApi>[0] = {}) {
  const { api } = makeMockAveApi(overrides);
  Object.assign(api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
  const onOpenMcpSettings = vi.fn();
  const onOpenPluginSettings = vi.fn();
  render(<GitMarketplaceTab api={api as unknown as AveApi} onOpenMcpSettings={onOpenMcpSettings} onOpenPluginSettings={onOpenPluginSettings} />);
  return { api, onOpenMcpSettings, onOpenPluginSettings };
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
    expect(screen.getByTestId("git-marketplace:kind:plugin")).toHaveTextContent("익스텐션");

    fireEvent.click(screen.getByTestId("git-marketplace:kind:skill"));
    expect(screen.getByTestId("git-marketplace:card:team:skill:proofread")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:card:ave-official:plugin:calendar")).toBeNull();
    expect(screen.queryByTestId("git-marketplace:card:team:mcp:weather")).toBeNull();
  });

  it("opens several updates as the whole installed list, whatever it was filtered to", async () => {
    const fake = fakeMarketplace({
      sources: [official, team],
      entries: [
        entry("ave-official", "plugin", "calendar", { state: { state: "update", from: "1.0.0", to: "1.1.0" } }),
        entry("team", "skill", "proofread", { state: { state: "update", from: "1.0.0", to: "2.0.0" } }),
      ],
    });
    renderTab(fake);
    await screen.findByTestId("git-marketplace:card:team:skill:proofread");
    fireEvent.click(screen.getByTestId("git-marketplace:kind:skill"));
    fireEvent.change(screen.getByTestId("git-marketplace:search"), { target: { value: "proof" } });
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenLastCalledWith({ query: "proof" }));

    act(() => {
      requestUpdateReview([
        { key: { sourceId: "ave-official", kind: "plugin", name: "calendar" }, displayName: "Calendar", from: "1.0.0", to: "1.1.0" },
        { key: { sourceId: "team", kind: "skill", name: "proofread" }, displayName: "Proofread", from: "1.0.0", to: "2.0.0" },
      ]);
    });

    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenLastCalledWith({ installedOnly: true }));
    expect(screen.getByTestId("git-marketplace:search")).toHaveValue("");
    expect(await screen.findByTestId("git-marketplace:card:ave-official:plugin:calendar")).toBeInTheDocument();
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

  it("offers both installed plugin export projections", async () => {
    const item = entry(null, "agent-plugin", "hook-kit", { state: { state: "unbound", version: "1.0.0" },
      sourceOrigin: null, sourceLabel: null });
    const fake = fakeMarketplace({ entries: [item] });
    const { api } = renderTab(fake);
    const exportInstalled = vi.fn(async () => ({ ok: true as const, value: null }));
    Object.assign(api, { pluginStudio: { exportInstalled } });
    fireEvent.click(screen.getByTestId("git-marketplace:installed"));
    const card = await screen.findByTestId("git-marketplace:card:unbound:agent-plugin:hook-kit");
    const trigger = within(card).getByTestId("plugin-studio:export-installed:hook-kit");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "호환 파일 포함" }));
    await waitFor(() => expect(exportInstalled).toHaveBeenCalledWith("hook-kit", true));
  });

  it("labels an installed code package from its catalog kind", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry(null, "plugin", "calendar", { state: { state: "unbound", version: null } })],
    });
    renderTab(fake);
    fireEvent.click(screen.getByTestId("git-marketplace:installed"));

    const card = await screen.findByTestId("git-marketplace:card:unbound:plugin:calendar");
    expect(within(card).getByText("익스텐션")).toBeInTheDocument();
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

describe("GitMarketplaceTab search answers", () => {
  it("keeps the newest query's answer when an older one returns later", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [entry("team", "skill", "proofread"), entry("team", "skill", "profile")] });
    renderTab(fake);
    await screen.findByTestId("git-marketplace:card:team:skill:proofread");

    const answers = new Map<string, (value: unknown) => void>();
    const catalogOf = (name: string) => ({ ok: true, value: { entries: [entry("team", "skill", name)], counts: { plugin: 0, mcp: 0, skill: 1, agent: 0, theme: 0, font: 0, language: 0, provider: 0, "messaging-connection": 0 }, sourceCount: 1, syncedAt: null } });
    fake.market.listCatalog.mockImplementation((query: { query?: string }) => new Promise((resolve) => answers.set(query.query ?? "", resolve)));
    fireEvent.change(screen.getByTestId("git-marketplace:search"), { target: { value: "pro" } });
    fireEvent.change(screen.getByTestId("git-marketplace:search"), { target: { value: "proof" } });
    await waitFor(() => expect(answers.has("proof")).toBe(true));

    answers.get("proof")!(catalogOf("proofread"));
    await screen.findByTestId("git-marketplace:card:team:skill:proofread");
    answers.get("pro")!(catalogOf("profile"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("git-marketplace:card:team:skill:profile")).toBeNull();
    expect(screen.getByTestId("git-marketplace:card:team:skill:proofread")).toBeInTheDocument();
  });
});

describe("GitMarketplaceTab package sheet", () => {
  it("shows the localized process-entry refusal from the install result", async () => {
    const item = entry("team", "plugin", "process-kit");
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item) });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item) });
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "process-entry-unsupported", message: "This app cannot run process-entry extensions yet." });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:process-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));
    expect(await within(sheet).findByText("이 앱은 아직 프로세스 진입점이 있는 익스텐션을 실행할 수 없습니다.")).toBeInTheDocument();
  });

  it("passes only separately selected plugin servers with their reviewed digests", async () => {
    const item = entry("team", "agent-plugin", "meeting-kit");
    const components = { skills: [], prompts: [], agents: [], routineTemplates: [], hooks: [],
      mcpServers: {
        notes: { transport: "stdio" as const, command: "./server/run", cwd: "${PLUGIN_ROOT}", digest: "a".repeat(64) },
        remote: { transport: "http" as const, url: "https://example.test/mcp", digest: "b".repeat(64) },
      } };
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item, { components }) });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item, { components }) });
    fake.market.executeInstall.mockResolvedValue({ ok: true, value: { key: item.key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:agent-plugin:meeting-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    const review = await within(sheet).findByTestId("git-marketplace:review");
    expect(review).toHaveTextContent("./server/run");
    fireEvent.click(within(review).getByTestId("git-marketplace:mcp-consent:notes").querySelector('[role="checkbox"]')!);
    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    await waitFor(() => expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1", [{ name: "notes", digest: "a".repeat(64) }]));
  });

  it("sends only selected hook generations with their reviewed digests", async () => {
    const item = entry("team", "agent-plugin", "hook-kit");
    const components = { skills: [], prompts: [], agents: [], routineTemplates: [], mcpServers: {},
      hooks: [{ event: "pre", command: ["node", "${PLUGIN_ROOT}/server/hook.js"], timeoutMs: 1200, digest: "a".repeat(64) }] };
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item, { components }) });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item, { components }) });
    fake.market.executeInstall.mockResolvedValue({ ok: true, value: { key: item.key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:agent-plugin:hook-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    const review = await within(sheet).findByTestId("git-marketplace:review");
    expect(review).toHaveTextContent("운영체제 격리가 없습니다");
    expect(review).toHaveTextContent("${PLUGIN_ROOT}/server/hook.js");
    fireEvent.click(within(review).getByTestId("git-marketplace:hook-consent:0").querySelector('[role="checkbox"]')!);
    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    await waitFor(() => expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1", [{ kind: "hook", index: 0, digest: "a".repeat(64) }]));
  });

  it("states the active hook confinement and refuses consent when unavailable", async () => {
    const item = entry("team", "agent-plugin", "hook-kit");
    const components = { skills: [], prompts: [], agents: [], routineTemplates: [], mcpServers: {},
      hooks: [{ event: "pre", command: ["./hook"], timeoutMs: 1200, digest: "a".repeat(64) }] };
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item, { components }) });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item, { components, hookConfinement: "unavailable" }) });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:agent-plugin:hook-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    const review = await within(sheet).findByTestId("git-marketplace:review");
    expect(review).toHaveTextContent("Windows 운영체제 샌드박스가 켜져 있는 동안 훅을 실행할 수 없습니다");
    expect(within(review).getByTestId("git-marketplace:hook-consent:0").querySelector('[role="checkbox"]')).toBeDisabled();
  });

  it("shows plugin components and their digest changes before an update", async () => {
    const item = entry("team", "agent-plugin", "writer-plugin", { state: { state: "update", from: "1.0.0", to: "1.1.0" } });
    const components = { skills: [{ name: "draft", hasScripts: false, digest: "a".repeat(64) }], mcpServers: {}, prompts: [], agents: [], routineTemplates: [], hooks: [] };
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item, { components }) });
    fake.market.planUpdate.mockResolvedValue({ ok: true, value: {
      ...installPlan(item, { components }), from: "1.0.0", commitRange: { from: COMMIT_A, to: COMMIT_B },
      authorityDelta: null, componentsDelta: { added: [], removed: [], changed: [{ kind: "skill", name: "draft", digest: "b".repeat(64) }] },
      historyRewritten: null, needsConfirmation: false,
    } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:agent-plugin:writer-plugin")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    const review = await within(sheet).findByTestId("git-marketplace:review");
    expect(review).toHaveTextContent("스킬 · draft");
    expect(review).toHaveTextContent("변경됨 · 스킬 · draft");
  });

  it("reviews the plan and installs exactly the plan it showed", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar) });
    let finish: (value: unknown) => void = () => undefined;
    fake.market.executeInstall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { api, onOpenPluginSettings } = renderTab(fake);
    Object.assign(api, { alerts: {
      listKinds: async () => [{ pluginId: "calendar", choice: { enabled: true } }],
      onKindsChanged: () => () => {},
    } });
    api.getSettings.mockResolvedValue({ alerts: { osNotificationsEnabled: false } });

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
    const alertNotice = await within(sheet).findByTestId("installed-plugin-alerts");
    expect(alertNotice).toHaveTextContent("알림 유형 1개 사용 가능");
    expect(alertNotice).not.toHaveTextContent("모두 꺼짐");
    fireEvent.click(within(alertNotice).getByRole("button", { name: "알림 설정 열기" }));
    expect(onOpenPluginSettings).toHaveBeenCalledWith("calendar");
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:sheet")).toBeNull());
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
    expect(within(sheet).getByText(/익스텐션 데이터는 유지되므로/)).toBeInTheDocument();

    const confirm = within(sheet).getByTestId("git-marketplace:confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(sheet).getByTestId("git-marketplace:switch-consent"));
    expect(confirm).toBeEnabled();
  });

  it("shows filesystem grants in the package and install review", async () => {
    const item = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    const authority = { ...detail(item).authority!, filesystem: [{ access: "write" as const, target: "config.workspace", why: "Store project data" }] };
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(item, { authority }) });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item, { authority }) });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    expect(await within(sheet).findByText("파일 접근: write: config.workspace — Store project data")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByTestId("git-marketplace:plan"));
    await within(sheet).findByTestId("git-marketplace:review");
    expect(within(sheet).getByText("파일 접근: write: config.workspace — Store project data")).toBeInTheDocument();
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
        authorityDelta: { added: { capabilities: [], networkHosts: ["upload.example.com"], secrets: [], pluginAccess: [], dependencies: [], filesystem: [] }, removed: { capabilities: [], networkHosts: [], secrets: [], pluginAccess: [], dependencies: [], filesystem: [] } },
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

  it("says to show a hidden source again when its plan is refused", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: false, code: "SOURCE_DISABLED", message: "source team is hidden; show it again to install or update from it" });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    expect(await within(sheet).findByTestId("git-marketplace:failed")).toHaveTextContent("이 패키지의 마켓플레이스가 숨겨져 있습니다. 소스에서 다시 표시해야 설치하거나 업데이트할 수 있습니다.");
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

describe("GitMarketplaceTab deep links", () => {
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
    unmanaged: [],
    lostGrants: [],
    revoked: [],
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

  it("names what the first-boot migration unlocked and which grants it did not keep, and stays until the last default is removed", async () => {
    const migrated = {
      forYou: [{ sourceId: "ave", kind: "theme" as const, name: "nord" }],
      required: [],
      unmanaged: ["orion"],
      lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai", "llm.apiKey.claude"] }],
      revoked: [
        { key: { sourceId: "acme", kind: "mcp" as const, name: "scraper" }, version: "1.2.0", reason: "exfiltrates cookies", outcome: "uninstalled" as const },
        { key: { sourceId: "corp", kind: "plugin" as const, name: "vpn" }, version: "2.0.0", reason: "bad build", outcome: "required" as const },
      ],
    };
    const fake = fakeMarketplace({ sources: [official], bootNotice: migrated });
    renderTab(fake);

    const banner = await screen.findByTestId("git-marketplace:boot-notice");
    expect(within(banner).getByTestId("git-marketplace:boot-notice:unmanaged")).toHaveTextContent("ep은(는) 더 이상 Ave가 관리하지 않습니다");
    expect(within(banner).getByTestId("git-marketplace:boot-notice:lost-grants")).toHaveTextContent("meeting은(는) 업데이트하기 전까지 llm.apiKey.openai, llm.apiKey.claude");
    const revoked = within(banner).getByTestId("git-marketplace:boot-notice:revoked");
    expect(revoked).toHaveTextContent("acme이(가) scraper 1.2.0을(를) 철회해 제거했습니다: exfiltrates cookies");
    expect(revoked).toHaveTextContent("corp이(가) vpn 2.0.0을(를) 철회했지만 조직이 요구하는 패키지라 설치된 채로 둡니다: bad build");

    // The unlocked and lost-grant lines are still news after the default is removed.
    fireEvent.click(within(banner).getByTestId("git-marketplace:boot-notice:uninstall:theme:nord"));
    await waitFor(() => expect(within(banner).queryByTestId("git-marketplace:boot-notice:uninstall:theme:nord")).toBeNull());
    expect(screen.getByTestId("git-marketplace:boot-notice")).toBeInTheDocument();
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

describe("GitMarketplaceTab maintenance", () => {
  it("holds the switches until the saved values arrive, then writes what the user flips", async () => {
    let answer: (settings: unknown) => void = () => {};
    const fake = fakeMarketplace({ sources: [team] });
    const { api } = renderTab(fake, {
      getSettings: () => new Promise((resolve) => {
        answer = resolve;
      }),
    });

    const notices = await screen.findByTestId("git-marketplace:update-check");
    expect(notices).toBeDisabled();
    answer({ marketplace: { updateCheckEnabled: false, offlineCacheEnabled: true } });
    await waitFor(() => expect(notices).toBeEnabled());
    expect(notices).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByTestId("git-marketplace:offline-cache"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { offlineCacheEnabled: false } }));
  });

  it("keeps the switches off and says why when the saved values cannot be read", async () => {
    renderTab(fakeMarketplace({ sources: [team] }), { getSettings: () => Promise.reject(new Error("settings.json is unreadable")) });

    expect(await screen.findByTestId("git-marketplace:maintenance:error")).toHaveTextContent("마켓플레이스가 응답하지 못했습니다. settings.json is unreadable");
    expect(screen.getByTestId("git-marketplace:update-check")).toBeDisabled();
    expect(screen.getByTestId("git-marketplace:offline-cache")).toBeDisabled();
  });

  it("says when the environment decides a switch", async () => {
    renderTab(fakeMarketplace({ sources: [team] }), { envForcedSettings: ["marketplace.offlineCacheEnabled"] });

    expect(await screen.findByTestId("git-marketplace:offline-cache:forced")).toHaveTextContent("AVE_MARKETPLACE_USE_CACHE");
    expect(screen.queryByTestId("git-marketplace:update-check:forced")).toBeNull();
  });
});
