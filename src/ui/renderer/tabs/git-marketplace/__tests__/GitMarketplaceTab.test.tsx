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
import { deferred } from "../../../../../../test/renderer/helpers.js";
import type { AveApi } from "../../../types.js";
import { GitMarketplaceTab } from "../GitMarketplaceTab.js";
import { PackageSheet } from "../PackageSheet.js";
import type { GitMarketplaceApi } from "../../../../../shared/git-marketplace.js";
import { requestUpdateReview } from "../update-review-request.js";
import { COMMIT_A, COMMIT_B, detail, entry, fakeMarketplace, folderSource, installPlan, marketplacePreview, source, updateStatus } from "./fixtures.js";

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
        { key: { sourceId: "ave-official", kind: "plugin", name: "calendar" } },
        { key: { sourceId: "team", kind: "skill", name: "proofread" } },
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

  it("says an export that failed in its own words, with the studio's text only behind Copy details", async () => {
    const item = entry(null, "agent-plugin", "hook-kit", { state: { state: "unbound", version: "1.0.0" },
      sourceOrigin: null, sourceLabel: null });
    const { api } = renderTab(fakeMarketplace({ entries: [item] }));
    const exportInstalled = vi.fn(async () => ({ ok: false as const, code: "unavailable" as const, message: "Installed content is unavailable" }));
    Object.assign(api, { pluginStudio: { exportInstalled } });
    fireEvent.click(screen.getByTestId("git-marketplace:installed"));
    const card = await screen.findByTestId("git-marketplace:card:unbound:agent-plugin:hook-kit");
    const trigger = within(card).getByTestId("plugin-studio:export-installed:hook-kit");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "호환 파일 포함" }));

    const problem = await screen.findByTestId("git-marketplace:action-error");
    expect(problem).toHaveTextContent("hook-kit을(를) 내보내지 못했습니다.");
    expect(problem).not.toHaveTextContent("Installed content is unavailable");
    expect(screen.queryByTestId("git-marketplace:error")).toBeNull();
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
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "process-entry-requires-pinned-artifact", message: "This extension runs its own program." });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:process-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));
    expect(await within(sheet).findByText(/이 사본은 거부되었습니다\. 릴리스를 고정한 마켓플레이스에서 설치하세요\./)).toBeInTheDocument();
  });

  it("marks a legacy grant pin and offers no install for it (design §16.3)", async () => {
    const item = entry("team", "plugin", "fixturepin");
    const fake = fakeMarketplace({ sources: [team], entries: [item] });
    fake.market.packageDetail.mockResolvedValue({
      ok: true,
      value: detail(item, {
        provenance: { sourceLabel: "Team", repository: "https://github.com/example/market.git", folder: null, path: "plugins/fixturepin", snapshotCommit: COMMIT_A, versionCommit: null, publishedAt: null },
        rungs: [],
        versions: [
          { version: "0.9.0", commit: null, publishedAt: "2026-10-12T00:00:00.000Z", minAppVersion: "0.7.0", legacyPin: true, excluded: ["yanked"], yankedReason: "Legacy field pin.", rolloutPercent: null, installed: false, candidate: false },
        ],
      }),
    });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:fixturepin")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    expect(await within(sheet).findByTestId("git-marketplace:version:0.9.0:legacy-pin")).toHaveTextContent("권한 기록 전용");
    expect(within(within(sheet).getByTestId("git-marketplace:version:0.9.0")).queryByRole("button")).toBeNull();
    expect(within(sheet).queryByTestId("git-marketplace:delivery-help")).toBeNull();
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
    const pendingDetail = deferred<Awaited<ReturnType<GitMarketplaceApi["packageDetail"]>>>();
    fake.market.packageDetail.mockReturnValueOnce(pendingDetail.promise);
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(item, { components }) });
    fake.market.executeInstall.mockResolvedValue({ ok: true, value: { key: item.key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:agent-plugin:meeting-kit")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    // The sheet opens before its detail response makes the install action available.
    expect(within(sheet).queryByTestId("git-marketplace:plan")).toBeNull();
    expect(fake.market.planInstall).not.toHaveBeenCalled();
    pendingDetail.resolve({ ok: true, value: detail(item, { components }) });
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
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
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
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
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
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
      historyRewritten: null, needsConfirmation: false, consentDelta: [], codeFreeChange: false, reviewComponents: [],
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

    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    await within(sheet).findByTestId("git-marketplace:review");
    expect(fake.market.planInstall).toHaveBeenCalledWith({ sourceId: "team", kind: "plugin", name: "calendar" });
    expect(within(sheet).getByText(/커밋 aaaaaaa에 고정/)).toBeInTheDocument();

    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1");
    await within(sheet).findByTestId("git-marketplace:installing");
    fake.emitInstallProgress({ planId: "other-plan", phase: "activating", rung: null, bytes: null, total: null });
    fake.emitInstallProgress({ planId: "plan-1", phase: "downloading", rung: "release", bytes: 10, total: 100 });
    await waitFor(() => expect(within(sheet).getByTestId("git-marketplace:installing")).toHaveTextContent("아티팩트 내려받고 검증하는 중"));

    finish({ ok: true, value: { key: calendar.key, version: "1.0.0", action: { action: "install" }, rungs: [{ rung: "release", outcome: "used", unencrypted: false }], connectionWarning: null } });
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
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
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
        consentDelta: [{ field: "authority.networkAccess", checkpoint: "catalog", before: [], after: ["upload.example.com"] }],
        codeFreeChange: false,
        reviewComponents: [],
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

  it("shows the failure's sentence and copies a diagnostic naming the plan", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
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
    expect(failed).toHaveTextContent("검토한 내용이 더 이상 유효하지 않습니다.");
    expect(failed).not.toHaveTextContent("plan plan-1 expired");
    fireEvent.click(within(failed).getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith("PLAN_EXPIRED · plugin calendar 1.0.0 from team\nplan plan-1 expired");
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

  describe("a package whose source's stored id looks like a token (§18.8)", () => {
    const HANDLE = "ave-legacy-0123456789abcdef0123456789abcdef";
    const QUARANTINE = { ok: false as const, code: "SOURCE_ID_INVALID" as const, message: "this source's id looks like a password or token", detail: { reason: "stored-id-holds-credential" } };

    it.each([
      ["while its source is listed", "installed"],
      ["after its source is removed", "source-removed"],
    ] as const)("keeps Uninstall, by its row's handle, beside the reason its detail is refused, %s", async (_label, state) => {
      const note = entry(HANDLE, "skill", "note", { sourceLabel: HANDLE, state: { state, version: "1.0.0" } });
      const fake = fakeMarketplace({ entries: [note] });
      fake.market.packageDetail.mockResolvedValue(QUARANTINE);
      renderTab(fake);

      fireEvent.click(within(await screen.findByTestId(`git-marketplace:card:${HANDLE}:skill:note`)).getByTestId("git-marketplace:card:state"));
      const sheet = await screen.findByTestId("git-marketplace:sheet");
      expect(await within(sheet).findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여 Ave가 동기화하거나 패키지를 제공하지 않습니다/u)).toBeInTheDocument();
      fireEvent.click(within(sheet).getByTestId("git-marketplace:uninstall"));
      await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledWith({ sourceId: HANDLE, kind: "skill", name: "note" }));
    });

    it("shows a required package as required, with no Uninstall, when its detail is refused", async () => {
      const note = entry(HANDLE, "skill", "note", { sourceLabel: HANDLE, state: { state: "installed", version: "1.0.0" }, required: true });
      const fake = fakeMarketplace({ entries: [note] });
      fake.market.packageDetail.mockResolvedValue(QUARANTINE);
      renderTab(fake);

      const card = await screen.findByTestId(`git-marketplace:card:${HANDLE}:skill:note`);
      fireEvent.click(within(card).getAllByRole("button")[0]!);
      const sheet = await screen.findByTestId("git-marketplace:sheet");
      await within(sheet).findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u);
      expect(await within(sheet).findByTestId("git-marketplace:sheet:required")).toHaveTextContent("조직에서 필수로 지정");
      expect(within(sheet).queryByTestId("git-marketplace:uninstall")).toBeNull();
    });

    it.each([
      ["installed from the link's key", { state: "installed", version: "1.0.0" }, false, true],
      ["required by the policy", { state: "installed", version: "1.0.0" }, true, false],
      ["not installed from the link's key", { state: "install", version: "1.0.0" }, false, false],
    ] as const)("offers Uninstall to an uninstall link only for a package %s, from the Installed list", async (_label, state, required, offered) => {
      const note = entry(HANDLE, "skill", "note", { sourceLabel: HANDLE, state, required });
      const key = { sourceId: HANDLE, kind: "skill" as const, name: "note" };
      const fake = fakeMarketplace({ entries: [note], deepLink: { action: "uninstall", key } });
      fake.market.packageDetail.mockResolvedValue(QUARANTINE);
      renderTab(fake);

      const sheet = await screen.findByTestId("git-marketplace:sheet");
      await within(sheet).findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u);
      await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledWith({ installedOnly: true }));
      if (offered) {
        fireEvent.click(await within(sheet).findByTestId("git-marketplace:uninstall"));
        await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledWith(key));
      } else {
        if (required) expect(await within(sheet).findByTestId("git-marketplace:sheet:required")).toBeInTheDocument();
        expect(within(sheet).queryByTestId("git-marketplace:uninstall")).toBeNull();
        expect(fake.market.uninstall).not.toHaveBeenCalled();
      }
    });

    it("offers no Uninstall for a key nothing is installed from, even when a same-named package is installed from another source", async () => {
      const elsewhere = entry("team", "skill", "note", { state: { state: "installed", version: "1.0.0" } });
      const fake = fakeMarketplace({ sources: [team], entries: [elsewhere], deepLink: { action: "uninstall", key: { sourceId: HANDLE, kind: "skill", name: "note" } } });
      const installedLookup = deferred<unknown>();
      const readCatalog = fake.market.listCatalog.getMockImplementation() as GitMarketplaceApi["listCatalog"];
      fake.market.listCatalog.mockImplementation((query: { installedOnly?: boolean }) => query.installedOnly ? installedLookup.promise : readCatalog(query));
      fake.market.packageDetail.mockResolvedValue(QUARANTINE);
      renderTab(fake);

      const sheet = await screen.findByTestId("git-marketplace:sheet");
      await within(sheet).findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u);
      await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledWith({ installedOnly: true }));
      await act(async () => {
        installedLookup.resolve(await readCatalog({ installedOnly: true }));
        await installedLookup.promise;
      });
      expect(within(sheet).queryByTestId("git-marketplace:uninstall")).toBeNull();
    });

    it("offers no Uninstall when the row that opened the sheet says nothing is installed from it", async () => {
      const note = entry(HANDLE, "skill", "note", { sourceLabel: HANDLE, state: { state: "install", version: "1.0.0" } });
      const fake = fakeMarketplace({ entries: [note] });
      fake.market.packageDetail.mockResolvedValue(QUARANTINE);
      renderTab(fake);

      fireEvent.click(within(await screen.findByTestId(`git-marketplace:card:${HANDLE}:skill:note`)).getByTestId("git-marketplace:card:state"));
      const sheet = await screen.findByTestId("git-marketplace:sheet");
      await within(sheet).findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u);
      expect(within(sheet).queryByTestId("git-marketplace:uninstall")).toBeNull();
    });
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

  it.each([
    ["while the dialog stays open", false],
    ["after Cancel", true],
  ])("keeps a dialog opened for another address when an earlier add finishes (%s), and still refreshes the sources", async (_order, cancelFirst) => {
    const fake = fakeMarketplace({ sources: [team], deepLink: { action: "add", url: "https://github.com/acme/first" } });
    fake.market.previewSource.mockResolvedValue({
      ok: true,
      value: {
        type: "marketplace",
        previewId: "preview-first",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        url: "https://github.com/acme/first.git",
        badges: [],
        ref: null,
        commit: COMMIT_A,
        marketplace: { name: "first", displayName: "First tools", description: null, owner: "acme" },
        counts: { skill: 1 },
        codeRunning: 0,
        diagnostics: [],
        credentialHelper: false,
        suggestedId: "first",
      },
    });
    let finishFirst: (value: unknown) => void = () => {};
    fake.market.addSource.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    renderTab(fake);

    await screen.findByTestId("git-marketplace:add:url");
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    fireEvent.click(await screen.findByTestId("git-marketplace:add:confirm"));
    await waitFor(() => expect(fake.market.addSource).toHaveBeenCalledTimes(1));

    if (cancelFirst) {
      fireEvent.keyDown(screen.getByTestId("git-marketplace:add"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("git-marketplace:add")).toBeNull());
    }
    fake.deliverDeepLink({ action: "add", url: "https://github.com/acme/second" });
    await waitFor(() => expect(screen.getByTestId<HTMLInputElement>("git-marketplace:add:url").value).toBe("https://github.com/acme/second"));
    const listed = fake.market.listSources.mock.calls.length;

    // The first add finishes: the source lists refresh, and the dialog for the second address stays as it is.
    await act(async () => finishFirst({ ok: true, value: source({ id: "first", label: "First tools" }) }));
    await waitFor(() => expect(fake.market.listSources.mock.calls.length).toBeGreaterThan(listed));
    expect(screen.getByTestId("git-marketplace:add")).toBeInTheDocument();
    expect(screen.getByTestId<HTMLInputElement>("git-marketplace:add:url").value).toBe("https://github.com/acme/second");
    expect(screen.queryByTestId("git-marketplace:sheet")).toBeNull();
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

describe("GitMarketplaceTab target classes (§18.3, §18.5)", () => {
  it("opens the Add dialog empty for a link that named a folder, and says why", async () => {
    const fake = fakeMarketplace({ sources: [team], deepLink: { action: "add-refused", reason: "deep-link-path" } });
    renderTab(fake);

    const input = await screen.findByTestId<HTMLInputElement>("git-marketplace:add:url");
    expect(input.value).toBe("");
    expect(await screen.findByTestId("git-marketplace:add:error")).toHaveTextContent("링크로는 이 컴퓨터의 폴더를 지정할 수 없어 아무것도 채우지 않았습니다.");
    expect(fake.market.previewSource).not.toHaveBeenCalled();
  });

  it("shows a source's badges on its package cards", async () => {
    const calendar = entry("team", "plugin", "calendar", { sourceBadges: ["unencrypted"] });
    renderTab(fakeMarketplace({ sources: [team], entries: [calendar] }));
    const badge = await screen.findByTestId("git-marketplace:card:team:calendar:badge:unencrypted");
    expect(badge).toHaveTextContent("암호화 안 됨(http)");
    expect(badge.getAttribute("title")).toContain("업데이트는 자동으로 설치되지 않습니다");
  });

  it("says a plain http download is verified by its pinned sha256", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.packageDetail.mockResolvedValue({ ok: true, value: detail(calendar, { rungs: [{ rung: "archive", declared: true, pinned: true, detail: "downloads.example.com", unencrypted: true }] }) });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    expect(await screen.findByTestId("git-marketplace:rung:archive:unencrypted")).toHaveTextContent("암호화되지 않은 다운로드 — 고정된 sha256으로 검증");
  });

  it("labels the rung that delivered when its bytes arrived over plain http, though the declared URL was https", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar, { rungs: [{ rung: "archive", declared: true, pinned: true, detail: "downloads.example.com", unencrypted: false }] }) });
    fake.market.executeInstall.mockResolvedValue({ ok: true, value: { key: calendar.key, version: "1.0.0", action: { action: "install" }, rungs: [
      { rung: "release", outcome: "skipped", reason: "NOT_DECLARED" },
      { rung: "archive", outcome: "used", unencrypted: true },
    ], connectionWarning: null } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    await within(sheet).findByTestId("git-marketplace:review");
    expect(within(sheet).queryByTestId("git-marketplace:rung:archive:unencrypted")).toBeNull();
    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    const done = await within(sheet).findByTestId("git-marketplace:done");
    expect(within(done).getByTestId("git-marketplace:done:rung:archive:unencrypted")).toHaveTextContent("암호화되지 않은 다운로드 — 고정된 sha256으로 검증");
    expect(within(done).queryByTestId("git-marketplace:done:rung:release:unencrypted")).toBeNull();
  });

  it("offers Allow internal downloads when an install needs it, then reviews again", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar) });
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "SOURCE_CONFIRMATION_REQUIRED", message: "internal", detail: { reason: "internal-downloads", source: "Team tools", host: "10.0.0.9" } });
    fake.market.acknowledgeSource.mockResolvedValue({ ok: true, value: { ...team, acknowledged: ["internal-downloads"], badges: ["internal-downloads"] } });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));
    const failed = await within(sheet).findByTestId("git-marketplace:failed");
    expect(failed).toHaveAttribute("data-tone", "warning");
    expect(failed).toHaveTextContent("Team tools 마켓플레이스가 다른 사내 주소 10.0.0.9에서 내려받게 합니다.");
    const allow = within(failed).getByTestId("git-marketplace:failed:allow");
    expect(allow).toHaveTextContent("사내 다운로드 허용");
    fireEvent.click(allow);
    await waitFor(() => expect(fake.market.acknowledgeSource).toHaveBeenCalledWith("team", ["internal-downloads"]));
    await waitFor(() => expect(fake.market.planInstall).toHaveBeenCalledTimes(2));
    expect(await within(sheet).findByTestId("git-marketplace:review")).toBeInTheDocument();
  });

  it("reviews again with a fresh plan after the organization's policy changed", async () => {
    const calendar = entry("team", "plugin", "calendar");
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(calendar) });
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "PLAN_EXPIRED", message: "policy changed", detail: { reason: "policy-changed" } });
    renderTab(fake);

    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    fireEvent.click(await within(sheet).findByTestId("git-marketplace:confirm"));
    expect(await within(sheet).findByTestId("git-marketplace:failed")).toHaveTextContent("검토하는 사이 조직 정책이 바뀌었습니다.");
    fireEvent.click(within(sheet).getByTestId("git-marketplace:review-again"));
    await waitFor(() => expect(fake.market.planInstall).toHaveBeenCalledTimes(2));
    expect(await within(sheet).findByTestId("git-marketplace:review")).toBeInTheDocument();
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
    autoUpdated: [],
  };

  it("lists what the boot installed, uninstalls a default install keeping MCP data, and dismisses", async () => {
    const fake = fakeMarketplace({ sources: [official], bootNotice: notice });
    renderTab(fake);

    const banner = await screen.findByTestId("git-marketplace:boot-notice");
    // What the boot pass did is a start-up change.
    expect(within(banner).getByTestId("git-marketplace:boot-notice:title")).toHaveTextContent("Ave 시작 시 변경됨");
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
      unmanaged: ["sampleportal"],
      lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai", "llm.apiKey.claude"] }],
      revoked: [
        { key: { sourceId: "acme", kind: "mcp" as const, name: "scraper" }, version: "1.2.0", reason: "exfiltrates cookies", outcome: "uninstalled" as const },
        { key: { sourceId: "corp", kind: "plugin" as const, name: "vpn" }, version: "2.0.0", reason: "bad build", outcome: "required" as const },
      ],
      autoUpdated: [],
    };
    const fake = fakeMarketplace({ sources: [official], bootNotice: migrated });
    renderTab(fake);

    const banner = await screen.findByTestId("git-marketplace:boot-notice");
    expect(within(banner).getByTestId("git-marketplace:boot-notice:unmanaged")).toHaveTextContent("sampleportal은(는) 더 이상 Ave가 관리하지 않습니다");
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
    const initialNotice = deferred<Awaited<ReturnType<GitMarketplaceApi["bootInstallNotice"]>>>();
    fake.market.bootInstallNotice.mockReturnValueOnce(initialNotice.promise);
    renderTab(fake);
    await waitFor(() => expect(fake.market.bootInstallNotice).toHaveBeenCalledTimes(1));
    await act(async () => {
      initialNotice.resolve({ ok: true, value: null });
      await initialNotice.promise;
    });
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

    const problem = await screen.findByTestId("git-marketplace:maintenance:error");
    expect(problem).toHaveTextContent("마켓플레이스가 시작하거나 응답하지 못했습니다.");
    // The reason is behind Copy details (§18.8).
    expect(problem).not.toHaveTextContent("settings.json is unreadable");
    expect(screen.getByTestId("git-marketplace:update-check")).toBeDisabled();
    expect(screen.getByTestId("git-marketplace:offline-cache")).toBeDisabled();
  });

  it("says a switch it could not save in its own words, not as the marketplace failing", async () => {
    const { api } = renderTab(fakeMarketplace({ sources: [team] }), { getSettings: async () => ({ marketplace: { updateCheckEnabled: true, offlineCacheEnabled: true } }) });
    Object.assign(api, { updateSettings: vi.fn(async () => ({ ok: false, error: "settings-write-failed", message: "EACCES: settings.json" })) });
    const offline = await screen.findByTestId("git-marketplace:offline-cache");
    await waitFor(() => expect(offline).toBeEnabled());

    fireEvent.click(offline);
    const problem = await screen.findByTestId("git-marketplace:maintenance:save-error");
    expect(problem).toHaveTextContent("설정을 저장하지 못해 이전 값이 그대로 적용됩니다.");
    expect(problem).not.toHaveTextContent("EACCES");
    expect(screen.queryByTestId("git-marketplace:error")).toBeNull();
  });

  it("says when the environment decides a switch", async () => {
    renderTab(fakeMarketplace({ sources: [team] }), { envForcedSettings: ["marketplace.offlineCacheEnabled"] });

    expect(await screen.findByTestId("git-marketplace:offline-cache:forced")).toHaveTextContent("AVE_MARKETPLACE_USE_CACHE");
    expect(screen.queryByTestId("git-marketplace:update-check:forced")).toBeNull();
  });
});

describe("GitMarketplaceTab Updates card (design §18.9)", () => {
  const meeting = { key: { sourceId: "team", kind: "plugin" as const, name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "1.1.0" };
  const checked = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const next = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  it("says when it checks and when it last did, and opens an update's review from its row", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry("team", "plugin", "meeting", { state: { state: "update", from: "1.0.0", to: "1.1.0" } })],
      updateStatus: updateStatus({
        discovery: { lastAttemptAt: checked, lastSuccessAt: checked, result: "ok", nextAt: next },
        applyCheckAt: checked,
        packages: [{ ...meeting, state: "manual" }],
      }),
    });
    renderTab(fake);

    const cadence = await screen.findByTestId("git-marketplace:updates:cadence");
    expect(cadence).toHaveTextContent("시작할 때와 하루에 한 번 업데이트를 확인합니다");
    expect(cadence).toHaveTextContent("마지막 확인 5분 전");
    expect(cadence).toHaveTextContent("다음 확인 6시간 후");
    const row = screen.getByTestId("git-marketplace:updates:row:team:plugin:meeting");
    expect(row).toHaveTextContent("1.0.0 → 1.1.0");
    expect(within(row).getByTestId("git-marketplace:updates:state")).toHaveTextContent("업데이트 가능");
    // One switch decides whether packages update by themselves.
    expect(within(screen.getByTestId("git-marketplace:updates")).getByTestId("git-marketplace:updates:automatic")).toHaveAttribute("aria-checked", "true");

    // The update review plans the update; that it opens is what this row owes.
    fake.market.planUpdate.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(within(row).getByRole("button", { name: "검토" }));
    await waitFor(() => expect(fake.market.planUpdate).toHaveBeenCalledWith(meeting.key));
  });

  it("says an offline check, a partial one with the way to the sources, a failed one and a lost history", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ discovery: { lastAttemptAt: checked, lastSuccessAt: checked, result: "offline", nextAt: next } }),
    });
    renderTab(fake);
    expect(await screen.findByTestId("git-marketplace:updates:offline")).toHaveTextContent("오프라인 — 마지막 확인 5분 전. 네트워크가 돌아오면 다시 확인합니다.");

    act(() => fake.emitUpdateStatus(updateStatus({ discovery: { lastAttemptAt: checked, lastSuccessAt: null, result: "error", nextAt: next }, historyReset: true })));
    expect(await screen.findByTestId("git-marketplace:updates:failed")).toHaveTextContent("마지막 확인을 끝내지 못해");
    expect(screen.getByTestId("git-marketplace:updates:history-reset")).toHaveTextContent("marketplaces/updates.json");
    expect(screen.getByTestId("git-marketplace:updates:cadence")).toHaveTextContent("아직 확인하지 않음");

    act(() => fake.emitUpdateStatus(updateStatus({ discovery: { lastAttemptAt: checked, lastSuccessAt: checked, result: "partial", nextAt: next } })));
    const partial = await screen.findByTestId("git-marketplace:updates:partial");
    expect(partial).toHaveTextContent("일부 소스에 연결하지 못해");
    fireEvent.click(within(partial).getByRole("button", { name: "소스 보기" }));
    expect(await screen.findByText("Team tools")).toBeInTheDocument();
  });

  it("checks now, and shows the answer", async () => {
    const fake = fakeMarketplace({ sources: [team] });
    let answer: (value: unknown) => void = () => {};
    fake.market.checkUpdates.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    renderTab(fake);
    const button = await screen.findByTestId("git-marketplace:updates:check");
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("확인 중…");
    answer({ ok: true, value: updateStatus({ discovery: { lastAttemptAt: checked, lastSuccessAt: checked, result: "ok", nextAt: next }, applyCheckAt: checked }) });
    // Not "up to date": a skipped version is left out of the list, so the list says only that nothing waits for review.
    expect(await screen.findByTestId("git-marketplace:updates:none")).toHaveTextContent("검토할 업데이트가 없습니다.");
    expect(button).toBeEnabled();
    expect(fake.market.checkUpdates).toHaveBeenCalledOnce();
  });

  it("says in its own words when the scheduler does not answer, with main's message only behind Copy details, scrubbed", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const fake = fakeMarketplace({ sources: [team] });
    fake.market.updateStatus.mockResolvedValue({ ok: false, code: "unavailable", message: "update checks have not started; token=s3cretvalue" });
    renderTab(fake);
    const problem = await screen.findByTestId("git-marketplace:updates:error");
    expect(problem).toHaveTextContent("지금은 업데이트를 확인할 수 없습니다.");
    expect(problem).not.toHaveTextContent("update checks have not started");
    fireEvent.click(within(problem).getByRole("button", { name: "세부 정보 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const [copied] = writeText.mock.calls[0] as unknown as [string];
    expect(copied).toContain("unavailable\nupdate checks have not started");
    expect(copied).not.toContain("s3cretvalue");
  });

  it("marks an update whose source the last check did not reach as an earlier check's", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({
        discovery: { lastAttemptAt: checked, lastSuccessAt: checked, result: "partial", nextAt: next },
        packages: [{ ...meeting, state: "manual", stale: true }, { ...meeting, key: { ...meeting.key, name: "notes" }, displayName: "Notes", state: "manual" }],
      }),
    });
    renderTab(fake);
    const row = await screen.findByTestId("git-marketplace:updates:row:team:plugin:meeting");
    expect(within(row).getByTestId("git-marketplace:updates:stale")).toHaveTextContent("마지막 확인에서 소스에 연결하지 못해 이전 확인의 상태로 표시합니다.");
    expect(within(screen.getByTestId("git-marketplace:updates:row:team:plugin:notes")).queryByTestId("git-marketplace:updates:stale")).toBeNull();
  });
});

describe("Show <id> on a folder that overlaps a source (§18.8)", () => {
  it("closes the Add dialog and opens Sources with that source's row marked", async () => {
    const shared = folderSource({ id: "shared", path: "/m" });
    const fake = fakeMarketplace({ sources: [official, team, shared] });
    fake.market.previewSource.mockResolvedValue({
      ok: true,
      value: { ...marketplacePreview, transport: "folder", url: null, path: "/m/inner", badges: ["local-folder"], commit: `local-${"d".repeat(64)}`, suggestedId: "inner" },
    });
    fake.market.addSource.mockResolvedValue({ ok: false, code: "SOURCE_ID_TAKEN", message: "inside", detail: { reason: "folder-inside-source", path: "/m/inner", existingId: "shared", existingPath: "/m" } });
    renderTab(fake);

    const menu = await screen.findByTestId("git-marketplace:add-menu");
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: "마켓플레이스 추가…" }));
    fireEvent.change(await screen.findByTestId("git-marketplace:add:url"), { target: { value: "/m/inner" } });
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    fireEvent.click(await screen.findByTestId("git-marketplace:add:confirm"));
    fireEvent.click(await screen.findByTestId("git-marketplace:add:error:show-source"));

    await waitFor(() => expect(screen.queryByTestId("git-marketplace:add")).toBeNull());
    const row = await screen.findByTestId("git-marketplace:source:shared");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("git-marketplace:source:team")).not.toHaveAttribute("aria-current");

    // Leaving Sources drops the mark: coming back shows no stale highlight.
    fireEvent.click(screen.getByTestId("git-marketplace:open-sources"));
    fireEvent.click(await screen.findByTestId("git-marketplace:open-sources"));
    expect(await screen.findByTestId("git-marketplace:source:shared")).not.toHaveAttribute("aria-current");
  });
});

describe("a package from a folder (§18.4.8)", () => {
  const market = folderSource({ id: "market", label: "My folder" });
  const REVISION = `local-${"c".repeat(64)}`;
  const DIGEST = "d".repeat(64);

  it("names the folder, when it was read and its contents, offers only the version in the folder, and lists what the install leaves out", async () => {
    const notes = entry("market", "plugin", "notes", { sourceBadges: ["local-folder"] });
    const fake = fakeMarketplace({ sources: [market], entries: [notes] });
    fake.market.packageDetail.mockResolvedValue({
      ok: true,
      value: detail(notes, {
        provenance: { sourceLabel: "My folder", repository: null, folder: { path: "/Users/example/market", readAt: new Date(Date.now() - 4 * 60_000).toISOString(), contents: DIGEST }, path: "plugins/notes", snapshotCommit: REVISION, versionCommit: REVISION, publishedAt: null },
        rungs: [{ rung: "folder", declared: true, pinned: false, detail: null, unencrypted: false }],
        versions: [
          { version: "1.1.0", commit: REVISION, publishedAt: "2026-09-30T00:00:00.000Z", minAppVersion: "1.0.0", legacyPin: false, excluded: [], yankedReason: null, rolloutPercent: null, installed: false, candidate: true },
          { version: "1.0.0", commit: COMMIT_A, publishedAt: "2026-09-20T00:00:00.000Z", minAppVersion: "1.0.0", legacyPin: false, excluded: [], yankedReason: null, rolloutPercent: null, installed: false, candidate: false },
        ],
      }),
    });
    fake.market.planInstall.mockResolvedValue({ ok: true, value: installPlan(notes, { snapshotCommit: REVISION, versionCommit: REVISION, rungs: [{ rung: "folder", declared: true, pinned: false, detail: null, unencrypted: false }], notInstalled: ["node_modules/", "package.json", "src/"] }) });
    renderTab(fake);

    expect(await screen.findByTestId("git-marketplace:card:market:notes:badge:local-folder")).toHaveTextContent("로컬 폴더");
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:market:plugin:notes")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    expect(await within(sheet).findByTestId("git-marketplace:provenance:folder")).toHaveTextContent("/Users/example/market");
    expect(within(sheet).getByTestId("git-marketplace:provenance:read")).toHaveTextContent("4분 전");
    const contents = within(sheet).getByTestId("git-marketplace:provenance:contents");
    expect(contents).toHaveTextContent("dddddddddddd");
    expect(contents).toHaveAttribute("title", DIGEST);
    expect(within(sheet).queryByText("저장소")).toBeNull();
    expect(within(sheet).getByTestId("git-marketplace:versions:folder")).toHaveTextContent("폴더에 있는 버전만 설치할 수 있습니다.");
    // The older listed version is history, not an offer.
    expect(within(within(sheet).getByTestId("git-marketplace:version:1.0.0")).queryByRole("button")).toBeNull();
    expect(within(sheet).getByText(/폴더의 빌드된 트리/)).not.toHaveTextContent("sha256");
    expect(within(sheet).getByTestId("git-marketplace:delivery-help")).toHaveTextContent("아무것도 내려받거나 이 컴퓨터에서 빌드하지 않으며");

    fireEvent.click(await within(sheet).findByTestId("git-marketplace:plan"));
    expect(await within(sheet).findByTestId("git-marketplace:review:not-installed")).toHaveTextContent("node_modules/, package.json, src/");
    expect(within(sheet).getByTestId("git-marketplace:review")).toHaveTextContent("폴더 내용 ccccccc에 고정");
  });
});

describe("PackageSheet: the Installed lookup behind a refused detail decides only the opening it was asked for (§18.8)", () => {
  const HANDLE = "ave-legacy-0123456789abcdef0123456789abcdef";
  const KEY = { sourceId: HANDLE, kind: "skill" as const, name: "note" };
  const QUARANTINE = { ok: false as const, code: "SOURCE_ID_INVALID" as const, message: "this source's id looks like a password or token", detail: { reason: "stored-id-holds-credential" } };
  const installed = (required = false) => entry(HANDLE, "skill", "note", { sourceLabel: HANDLE, state: { state: "installed", version: "1.0.0" }, required });
  const listed = (entries: ReturnType<typeof entry>[]) => ({ ok: true as const, value: { entries, counts: {}, sourceCount: 1, syncedAt: null } });
  const UNAVAILABLE = { ok: false as const, code: "unavailable" as const, message: "the list could not be read" };

  function sheet(fake: ReturnType<typeof fakeMarketplace>) {
    const props = { api: fake.market as unknown as GitMarketplaceApi, source: null, onClose: vi.fn(), onChanged: vi.fn(), onAutoUpdateSwitch: vi.fn(async () => null) };
    const view = render(<PackageSheet {...props} target={{ key: KEY, mode: "detail" }} />);
    return {
      close: () => view.rerender(<PackageSheet {...props} target={null} />),
      reopen: () => view.rerender(<PackageSheet {...props} target={{ key: KEY, mode: "detail" }} />),
    };
  }

  /** The quarantine sentence is shown: the refused detail of the current opening has arrived. */
  const refusalShown = () => screen.findByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u);

  it.each([
    ["fails", UNAVAILABLE, false],
    ["finds no install", listed([]), false],
    ["says the policy requires it", listed([installed(true)]), true],
  ] as const)("ignores an earlier opening's lookup that lands late when the reopened sheet's lookup %s", async (_label, current, required) => {
    const fake = fakeMarketplace();
    fake.market.packageDetail.mockResolvedValue(QUARANTINE);
    const earlier = deferred<unknown>();
    fake.market.listCatalog.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(current);
    const { close, reopen } = sheet(fake);
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(1));

    close();
    reopen();
    await refusalShown();
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(2));
    await act(async () => {
      earlier.resolve(listed([installed()]));
      await earlier.promise;
    });

    expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull();
    if (required) expect(screen.getByTestId("git-marketplace:sheet:required")).toBeInTheDocument();
  });

  it("ignores an earlier opening's lookup that completes in order, before the reopened sheet's own detail and lookup", async () => {
    const fake = fakeMarketplace();
    const secondDetail = deferred<unknown>();
    fake.market.packageDetail.mockResolvedValueOnce(QUARANTINE).mockReturnValueOnce(secondDetail.promise);
    const earlier = deferred<unknown>();
    const currentLookup = deferred<unknown>();
    fake.market.listCatalog.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(currentLookup.promise);
    const { close, reopen } = sheet(fake);
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(1));

    close();
    reopen();
    // The earlier lookup lands while the reopened sheet still waits for its detail.
    await act(async () => {
      earlier.resolve(listed([installed()]));
      await earlier.promise;
    });
    expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull();
    await act(async () => {
      secondDetail.resolve(QUARANTINE);
      await secondDetail.promise;
    });
    await refusalShown();
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(2));
    await act(async () => {
      currentLookup.resolve(UNAVAILABLE);
      await currentLookup.promise;
    });
    expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull();
  });

  it("ignores an earlier opening's detail that lands after the reopened sheet's refusal", async () => {
    const fake = fakeMarketplace();
    const earlierDetail = deferred<unknown>();
    fake.market.packageDetail.mockReturnValueOnce(earlierDetail.promise).mockResolvedValueOnce(QUARANTINE);
    fake.market.listCatalog.mockResolvedValue(listed([]));
    const { close, reopen } = sheet(fake);
    await waitFor(() => expect(fake.market.packageDetail).toHaveBeenCalledTimes(1));

    close();
    reopen();
    await refusalShown();
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(1));
    await act(async () => {
      earlierDetail.resolve({ ok: true, value: detail(installed()) });
      await earlierDetail.promise;
    });
    expect(screen.getByText(/이 소스의 ID가 비밀번호나 토큰처럼 보여/u)).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull();
  });

  it("drops Uninstall when the install goes away while the sheet is open, on the event that refreshes the cards", async () => {
    const fake = fakeMarketplace();
    fake.market.packageDetail.mockResolvedValue(QUARANTINE);
    fake.market.listCatalog.mockResolvedValueOnce(listed([installed()])).mockResolvedValueOnce(listed([]));
    sheet(fake);
    expect(await screen.findByTestId("git-marketplace:uninstall")).toBeInTheDocument();

    act(() => fake.emitCatalogChanged());
    await waitFor(() => expect(fake.market.listCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull());
  });

  it("follows the required flag as it changes while the sheet is open", async () => {
    const fake = fakeMarketplace();
    fake.market.packageDetail.mockResolvedValue(QUARANTINE);
    fake.market.listCatalog
      .mockResolvedValueOnce(listed([installed()]))
      .mockResolvedValueOnce(listed([installed(true)]))
      .mockResolvedValueOnce(listed([installed()]));
    sheet(fake);
    expect(await screen.findByTestId("git-marketplace:uninstall")).toBeInTheDocument();

    act(() => fake.emitCatalogChanged());
    expect(await screen.findByTestId("git-marketplace:sheet:required")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:uninstall")).toBeNull();

    act(() => fake.emitCatalogChanged());
    expect(await screen.findByTestId("git-marketplace:uninstall")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:sheet:required")).toBeNull();
  });
});
