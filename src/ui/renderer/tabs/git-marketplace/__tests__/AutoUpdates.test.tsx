/**
 * Automatic updates in the marketplace tab (design §18.7, §18.9): the
 * switches, *Apply now*, the rows that need the user and their actions, the
 * recent automatic updates, the boot notice's "Updated automatically", the
 * update review's consent rows and approvals, and the component approval of
 * an `approval-pending` agent plugin.
 */
// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeMockAveApi } from "../../../../../../test/renderer/mock-ave-api.js";
import type { PackageUpdateView, UnmetRequirementView, UpdatePlanView } from "../../../../../shared/git-marketplace.js";
import type { AveApi } from "../../../types.js";
import { GitMarketplaceTab } from "../GitMarketplaceTab.js";
import { requestUpdateReview } from "../update-review-request.js";
import { COMMIT_A, COMMIT_B, entry, fakeMarketplace, installPlan, source, updateStatus } from "./fixtures.js";

function renderTab(fake: ReturnType<typeof fakeMarketplace>, overrides: Parameters<typeof makeMockAveApi>[0] = {}) {
  const { api } = makeMockAveApi(overrides);
  Object.assign(api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
  const onOpenPluginSettings = vi.fn();
  const view = render(<GitMarketplaceTab api={api as unknown as AveApi} onOpenMcpSettings={vi.fn()} onOpenPluginSettings={onOpenPluginSettings} />);
  return { api, onOpenPluginSettings, unmount: view.unmount };
}

const team = source({ id: "team", label: "Team tools" });
const lan = source({ id: "lan", label: "LAN tools" });
const meetingKey = { sourceId: "team", kind: "plugin" as const, name: "meeting" };
const notesKey = { sourceId: "team", kind: "agent-plugin" as const, name: "notes" };
const pkg = (overrides: Partial<PackageUpdateView> & Pick<PackageUpdateView, "state">): PackageUpdateView => ({
  key: meetingKey, displayName: "Meeting", from: "1.0.0", to: "1.1.0", ...overrides,
});
const switchOn = { effective: true, override: null, lockedByPolicy: false, required: false };

describe("the switches (§18.7.2)", () => {
  it("writes the global switch, and shows the organization's lock instead of letting it change", async () => {
    const fake = fakeMarketplace({ sources: [team] });
    const { api } = renderTab(fake);
    const toggle = await screen.findByTestId("git-marketplace:updates:automatic");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { autoUpdate: false } }));

    act(() => fake.emitUpdateStatus(updateStatus({ autoUpdate: { enabled: false, lockedByPolicy: "off", sources: [], packages: [] } })));
    await waitFor(() => expect(screen.getByTestId("git-marketplace:updates:automatic")).toBeDisabled());
    expect(screen.getByTestId("git-marketplace:updates:automatic:policy")).toHaveTextContent("조직이 설정함: 검토한 업데이트만 설치됩니다.");
  });

  it("rewrites a package's switch map from the saved settings, and Default removes the package's own switch", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ packages: [pkg({ state: "manual", reasons: ["switched-off"], autoUpdate: { effective: false, override: "off", lockedByPolicy: false, required: false } })] }),
    });
    const { api } = renderTab(fake, { getSettings: async () => ({ marketplace: { autoUpdatePackages: { "plugin:other": "on", meeting: "off" } } }) });
    const row = await screen.findByTestId("git-marketplace:updates:row:team:plugin:meeting");
    expect(within(row).getByTestId("git-marketplace:updates:reasons")).toHaveTextContent("자동 업데이트가 꺼져 있습니다");
    const select = within(row).getByTestId("git-marketplace:updates:package-switch:team:plugin:meeting");
    fireEvent.change(select, { target: { value: "default" } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { autoUpdatePackages: { "plugin:other": "on" } } }));
    fireEvent.change(select, { target: { value: "on" } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ marketplace: { autoUpdatePackages: { "plugin:other": "on", meeting: "on" } } }));
  });

  it("asks before turning on an http source, accepts unencrypted-updates for it, then writes the switch", async () => {
    const fake = fakeMarketplace({
      sources: [team, lan],
      updateStatus: updateStatus({
        autoUpdate: {
          enabled: true,
          lockedByPolicy: null,
          sources: [
            { id: "team", label: "Team tools", origin: "custom", switch: switchOn, needsUnencryptedUpdates: false },
            { id: "lan", label: "LAN tools", origin: "custom", switch: { effective: false, override: null, lockedByPolicy: false, required: false }, needsUnencryptedUpdates: true },
          ],
          packages: [],
        },
      }),
    });
    fake.market.acknowledgeSource.mockResolvedValue({ ok: true, value: lan });
    const { api } = renderTab(fake, { getSettings: async () => ({ marketplace: {} }) });
    const row = await screen.findByTestId("git-marketplace:updates:source:lan");
    const select = within(row).getByTestId("git-marketplace:updates:source-switch:lan");
    expect(within(select).getByRole("option", { name: "기본값(끔)" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "on" } });
    const confirm = await within(row).findByTestId("git-marketplace:updates:unencrypted");
    expect(confirm).toHaveTextContent("LAN tools의 업데이트는 http로 전달됩니다.");
    expect(api.updateSettings).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByTestId("git-marketplace:updates:unencrypted:continue"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { autoUpdateSources: { lan: "on" } } }));
    expect(fake.market.acknowledgeSource).toHaveBeenCalledWith("lan", ["unencrypted-updates"]);
    expect(fake.market.acknowledgeSource.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(api.updateSettings).mock.invocationCallOrder[0]!);

    // An https source needs no confirmation.
    fireEvent.change(within(screen.getByTestId("git-marketplace:updates:source:team")).getByTestId("git-marketplace:updates:source-switch:team"), { target: { value: "off" } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ marketplace: { autoUpdateSources: { team: "off" } } }));
  });
});

describe("switches wherever a package or source is shown (§18.7.2, §18.9)", () => {
  it("an installed package's switch is in its sheet before it has an update, and Off writes its own entry", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry("team", "plugin", "meeting", { state: { state: "installed", version: "1.0.0" } })],
      updateStatus: updateStatus({ autoUpdate: { enabled: true, lockedByPolicy: null, sources: [], packages: [{ key: meetingKey, switch: switchOn }] } }),
    });
    const { api } = renderTab(fake, { getSettings: async () => ({ marketplace: {} }) });
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:meeting")).getByTestId("git-marketplace:card:state"));
    const select = await screen.findByTestId("git-marketplace:auto-update:switch:team:plugin:meeting");
    expect(select).toHaveValue("default");
    expect(within(select).getByRole("option", { name: "기본값(켬)" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { autoUpdatePackages: { meeting: "off" } } }));
  });

  it("under the organization's lock a select shows what takes effect, not the stored choice it overrides", async () => {
    const locked = { effective: true, override: "off" as const, lockedByPolicy: true, required: false };
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({
        autoUpdate: { enabled: true, lockedByPolicy: "on", sources: [{ id: "team", label: "Team tools", origin: "custom", switch: { ...locked, override: null }, needsUnencryptedUpdates: false }], packages: [] },
        packages: [pkg({ state: "waiting", autoUpdate: locked })],
      }),
    });
    renderTab(fake);
    const select = await screen.findByTestId("git-marketplace:updates:package-switch:team:plugin:meeting");
    expect(select).toHaveValue("on");
    expect(select).toBeDisabled();
    expect(screen.getByTestId("git-marketplace:updates:source-switch:team")).toHaveValue("on");
    expect(screen.getByTestId("git-marketplace:updates:automatic")).toHaveAttribute("aria-checked", "true");
  });

  it("shows a required package's switch on and locked, with why, in its row and in its sheet, though its own switch and the policy say off", async () => {
    const required = { effective: true, override: "off" as const, lockedByPolicy: true, required: true };
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry("team", "plugin", "meeting", { state: { state: "installed", version: "1.0.0" } })],
      updateStatus: updateStatus({
        autoUpdate: { enabled: false, lockedByPolicy: "off", sources: [], packages: [{ key: meetingKey, switch: required }] },
        packages: [pkg({ state: "waiting", required: true, autoUpdate: required })],
      }),
    });
    renderTab(fake, { getSettings: async () => ({ marketplace: {} }) });
    const row = await screen.findByTestId("git-marketplace:updates:package-switch:team:plugin:meeting");
    expect(row).toHaveValue("on");
    expect(row).toBeDisabled();
    expect(screen.getByTestId("git-marketplace:updates:required")).toHaveTextContent("조직이 필수로 지정한 패키지입니다. 이 스위치와 상관없이 자동으로 업데이트됩니다.");
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:meeting")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:auto-update:switch:team:plugin:meeting");
    expect(sheet).toHaveValue("on");
    expect(sheet).toBeDisabled();
    expect(screen.getByTestId("git-marketplace:auto-update:required:team:plugin:meeting")).toHaveTextContent("조직이 필수로 지정한 패키지입니다.");
    // The policy's own sentence would say the opposite of what happens to this package.
    expect(within(screen.getByTestId("git-marketplace:auto-update:team:plugin:meeting")).queryByText(/조직이 설정함/u)).toBeNull();
  });

  it("names the official source by its origin's name, as Sources does", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ autoUpdate: { enabled: true, lockedByPolicy: null, sources: [{ id: "ave", label: "ave", origin: "official", switch: switchOn, needsUnencryptedUpdates: false }], packages: [] } }),
    });
    renderTab(fake);
    const row = await screen.findByTestId("git-marketplace:updates:source:ave");
    expect(row).toHaveTextContent("Ave 공식");
    expect(row).not.toHaveTextContent(/^ave/u);
  });
});

describe("the queue and the rows (§18.7.4, §18.7.5)", () => {
  it("offers Apply now while updates wait, and says when they have waited 30 minutes", async () => {
    const waiting = updateStatus({ waitingSince: new Date().toISOString(), packages: [pkg({ state: "waiting" })] });
    const fake = fakeMarketplace({ sources: [team], updateStatus: waiting });
    renderTab(fake);
    const applyNow = await screen.findByTestId("git-marketplace:updates:apply-now");
    expect(screen.queryByTestId("git-marketplace:updates:escalated")).toBeNull();
    expect(screen.getByTestId("git-marketplace:updates:row:team:plugin:meeting")).toHaveTextContent("대화가 멈추면 적용합니다");

    act(() => fake.emitUpdateStatus({ ...waiting, escalated: true }));
    expect(await screen.findByTestId("git-marketplace:updates:escalated")).toHaveTextContent("업데이트 1개가 대화가 멈추기를 기다리고 있습니다.");
    fireEvent.click(applyNow);
    await waitFor(() => expect(fake.market.applyUpdatesNow).toHaveBeenCalledOnce());
  });

  it("shows a failed update's attempts, its sentence behind Details, and retries through the review", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry("team", "plugin", "meeting", { state: { state: "update", from: "1.0.0", to: "1.1.0" } })],
      updateStatus: updateStatus({ packages: [pkg({ state: "failed", reasons: ["failed-three-times"], failure: { code: "SOURCE_UNREACHABLE", detail: { reason: "offline" }, message: "getaddrinfo ENOTFOUND", attempts: 3 } })] }),
    });
    fake.market.planUpdate.mockImplementation(() => new Promise(() => {}));
    renderTab(fake);
    const row = await screen.findByTestId("git-marketplace:updates:row:team:plugin:meeting");
    expect(within(row).getByTestId("git-marketplace:updates:attempts")).toHaveTextContent("이 버전의 실패한 시도: 3회");
    expect(within(row).getByTestId("git-marketplace:updates:reasons")).toHaveTextContent("자동 시도가 세 번 실패했습니다");
    expect(within(row).queryByTestId("git-marketplace:updates:failure")).toBeNull();
    fireEvent.click(within(row).getByTestId("git-marketplace:updates:details"));
    const failure = within(row).getByTestId("git-marketplace:updates:failure");
    expect(failure).not.toHaveTextContent("ENOTFOUND");
    fireEvent.click(within(row).getByTestId("git-marketplace:updates:retry"));
    await waitFor(() => expect(fake.market.planUpdate).toHaveBeenCalledWith(meetingKey));
  });

  it("lists recent automatic updates apart from what needs the user, with What changed", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ packages: [pkg({ state: "applied", appliedAt: new Date().toISOString(), commitRange: { from: COMMIT_A, to: COMMIT_B } })] }),
    });
    renderTab(fake);
    const recent = await screen.findByTestId("git-marketplace:updates:recent:team:plugin:meeting");
    expect(screen.queryByTestId("git-marketplace:updates:list")).toBeNull();
    fireEvent.click(within(recent).getByTestId("git-marketplace:updates:what-changed"));
    expect(within(recent).getByTestId("git-marketplace:updates:commit-range")).toHaveTextContent("aaaaaaa");
    expect(within(recent).getByTestId("git-marketplace:updates:commit-range")).toHaveTextContent("bbbbbbb");
  });

  it("opens an extension's settings for its components waiting for approval", async () => {
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ packages: [pkg({ state: "approval-pending" })] }) });
    const { onOpenPluginSettings } = renderTab(fake);
    const row = await screen.findByTestId("git-marketplace:updates:row:team:plugin:meeting");
    fireEvent.click(within(row).getByTestId("git-marketplace:updates:review"));
    expect(onOpenPluginSettings).toHaveBeenCalledWith("meeting");
  });
});

describe("required installs not met (§10.2)", () => {
  const unmet = (reason: UnmetRequirementView["reason"], name: string, extra: Partial<UnmetRequirementView> = {}): UnmetRequirementView => ({
    key: { sourceId: "corp", kind: "skill", name }, sourceLabel: "Corp tools", reason, minAppVersion: null, installedFrom: null, ...extra,
  });

  it("says why each is not met, with the action each reason has, and opens the install in the way in its sheet", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      entries: [entry("team", "skill", "notes", { state: { state: "installed", version: "1.0.0" } })],
      updateStatus: updateStatus({
        unmetRequired: [
          unmet("source-missing", "notes", { installedFrom: { sourceId: "team", label: "Team tools", removal: "sheet" } }),
          unmet("source-hidden", "draft"),
          unmet("source-unreachable", "lint"),
          unmet("not-in-catalog", "audit"),
          unmet("incompatible", "review", { minAppVersion: "9.0.0" }),
          unmet("rollout-held", "beta"),
          unmet("not-offered", "triage"),
        ],
      }),
    });
    renderTab(fake);
    const card = await screen.findByTestId("git-marketplace:updates:unmet");
    expect(card).toHaveTextContent("조직이 필수로 지정했지만 설치되지 않은 패키지");
    const names = ["notes", "draft", "lint", "audit", "review", "beta", "triage"];
    const row = (name: string) => screen.getByTestId(`git-marketplace:updates:unmet:corp:skill:${name}`);
    const reason = (name: string) => within(row(name)).getByTestId("git-marketplace:updates:unmet:reason");
    const having = (testId: string) => names.filter((name) => within(row(name)).queryByTestId(`git-marketplace:updates:unmet:${testId}`));
    expect(reason("notes")).toHaveTextContent("조직이 Corp tools의 notes을(를) 필수로 지정했지만, 이 마켓플레이스가 Ave에 추가되어 있지 않습니다.");
    expect(reason("draft")).toHaveTextContent("이 마켓플레이스가 숨겨져 있어 아무것도 설치되지 않습니다. 소스에서 다시 표시하세요.");
    expect(reason("lint")).toHaveTextContent("아직 이 마켓플레이스에 연결하지 못했습니다.");
    expect(reason("audit")).toHaveTextContent("이 마켓플레이스 목록에 없습니다.");
    expect(reason("review")).toHaveTextContent("Ave 9.0.0 이상이 필요합니다.");
    // A rollout hold is availability, not this app's version.
    // Waiting alone is not promised to help: a pre-release-only catalog needs a release offered to this device.
    expect(reason("beta")).toHaveTextContent("아직 이 기기에 제공되는 릴리스가 없습니다: 릴리스가 단계적 배포로 보류되었거나 사전 릴리스뿐입니다. 이 기기에 릴리스가 제공되면 설치할 수 있습니다.");
    expect(reason("beta")).not.toHaveTextContent("Ave");
    expect(reason("triage")).toHaveTextContent("이 마켓플레이스가 이 설치에 제공하는 릴리스가 없습니다.");
    // The administrator is the next step except where the user acts (a hidden source) or waits (a rollout).
    expect(names.filter((name) => row(name).textContent!.includes("해결되지 않으면 관리자에게 문의하세요."))).toEqual(["notes", "lint", "audit", "review", "triage"]);
    // Refresh is offered only where a sync can change the answer; Show sources only for a hidden source.
    expect(having("refresh")).toEqual(["lint", "audit"]);
    expect(having("show-sources")).toEqual(["draft"]);
    fireEvent.click(within(row("lint")).getByTestId("git-marketplace:updates:unmet:refresh"));
    await waitFor(() => expect(fake.market.refreshSources).toHaveBeenCalledWith("corp"));

    expect(within(row("notes")).getByTestId("git-marketplace:updates:unmet:installed-from")).toHaveTextContent("notes이(가) 대신 Team tools에서 설치되어 있어");
    expect(having("remove")).toEqual(["notes"]);
    fireEvent.click(within(row("notes")).getByTestId("git-marketplace:updates:unmet:remove"));
    await screen.findByTestId("git-marketplace:sheet");
    await waitFor(() => expect(fake.market.packageDetail).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "team", kind: "skill", name: "notes" })));
    expect(screen.queryByTestId("git-marketplace:updates:unmet:confirm-remove")).toBeNull();
  });

  it("opens Sources for a hidden source", async () => {
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [unmet("source-hidden", "draft")] }) });
    renderTab(fake);
    fireEvent.click(await screen.findByTestId("git-marketplace:updates:unmet:show-sources"));
    expect(await screen.findByTestId("git-marketplace:sources")).toBeInTheDocument();
  });

  it.each([
    ["a source that no longer lists it", { sourceId: "team", label: "Team tools" }],
    ["a removed source", { sourceId: "gone-tools", label: "gone-tools" }],
    ["a quarantined source, by its handle", { sourceId: `ave-legacy-${"0f".repeat(16)}`, label: "[REDACTED:TOKEN]" }],
  ])("uninstalls an install in the way from %s after asking, without a sheet that cannot load", async (_label, from) => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ unmetRequired: [unmet("not-in-catalog", "notes", { key: { sourceId: "corp", kind: "mcp", name: "notes" }, installedFrom: { ...from, removal: "confirm" } })] }),
    });
    fake.market.uninstall.mockResolvedValueOnce({ ok: false, code: "PACKAGE_ID_CONFLICT", message: "mcp notes is not installed from it" });
    renderTab(fake);
    const row = await screen.findByTestId("git-marketplace:updates:unmet:corp:mcp:notes");
    fireEvent.click(within(row).getByTestId("git-marketplace:updates:unmet:remove"));
    const confirm = within(row).getByTestId("git-marketplace:updates:unmet:confirm-remove");
    // Removing it does not make the required source able to provide the package: the copy promises no install.
    expect(confirm).toHaveTextContent(`${from.label}에서 설치된 notes을(를) 제거할까요? 조직이 요구하는 패키지가 아닙니다. 제거해도 그 패키지가 설치되지는 않으며, Corp tools에서 받을 수 있을 때까지 필수 요건은 충족되지 않은 채로 남습니다.`);
    expect(screen.queryByTestId("git-marketplace:sheet")).toBeNull();
    expect(fake.market.packageDetail).not.toHaveBeenCalled();
    // A failed uninstall says why and keeps the question open.
    fireEvent.click(within(confirm).getByTestId("git-marketplace:updates:unmet:confirm-uninstall"));
    expect(await within(row).findByTestId("git-marketplace:updates:unmet:remove-error")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByTestId("git-marketplace:updates:unmet:confirm-uninstall"));
    await waitFor(() => expect(within(row).queryByTestId("git-marketplace:updates:unmet:confirm-remove")).toBeNull());
    expect(fake.market.uninstall).toHaveBeenLastCalledWith({ sourceId: from.sourceId, kind: "mcp", name: "notes", removeData: false });
  });

  it("binds an open removal to the install it named: a status naming another install changes it into a notice, and nothing is removed", async () => {
    const row = (from: string) => unmet("not-in-catalog", "notes", { key: { sourceId: "corp", kind: "mcp", name: "notes" }, installedFrom: { sourceId: from, label: from, removal: "confirm" } });
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
    renderTab(fake);
    const card = await screen.findByTestId("git-marketplace:updates:unmet:corp:mcp:notes");
    fireEvent.click(within(card).getByTestId("git-marketplace:updates:unmet:remove"));
    expect(within(card).getByTestId("git-marketplace:updates:unmet:confirm-remove")).toHaveTextContent("team에서 설치된 notes");
    // notes is installed from another source now: the open question is not carried over to it.
    act(() => fake.emitUpdateStatus(updateStatus({ unmetRequired: [row("replacement")] })));
    const changed = await within(card).findByTestId("git-marketplace:updates:unmet:remove-changed");
    expect(changed).toHaveTextContent("제거를 고를 때와 달리 notes이(가) 더는 team에서 설치되어 있지 않아 아무것도 제거하지 않았습니다.");
    expect(within(card).queryByTestId("git-marketplace:updates:unmet:confirm-uninstall")).toBeNull();
    expect(fake.market.uninstall).not.toHaveBeenCalled();
    // Choosing Remove again asks about the install named now, and removes that one.
    fireEvent.click(within(card).getByTestId("git-marketplace:updates:unmet:remove"));
    expect(within(card).getByTestId("git-marketplace:updates:unmet:confirm-remove")).toHaveTextContent("replacement에서 설치된 notes");
    fireEvent.click(within(card).getByTestId("git-marketplace:updates:unmet:confirm-uninstall"));
    await waitFor(() => expect(fake.market.uninstall).toHaveBeenCalledTimes(1));
    expect(fake.market.uninstall).toHaveBeenCalledWith({ sourceId: "replacement", kind: "mcp", name: "notes", removeData: false });
  });

  it("ends an open removal when its row goes, so the row coming back asks afresh", async () => {
    const row = unmet("not-in-catalog", "notes", { key: { sourceId: "corp", kind: "mcp", name: "notes" }, installedFrom: { sourceId: "team", label: "team", removal: "confirm" } });
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row] }) });
    renderTab(fake);
    fireEvent.click(await screen.findByTestId("git-marketplace:updates:unmet:remove"));
    expect(screen.getByTestId("git-marketplace:updates:unmet:confirm-remove")).toBeInTheDocument();
    act(() => fake.emitUpdateStatus(updateStatus()));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:updates:unmet")).toBeNull());
    act(() => fake.emitUpdateStatus(updateStatus({ unmetRequired: [row] })));
    await screen.findByTestId("git-marketplace:updates:unmet:corp:mcp:notes");
    expect(screen.queryByTestId("git-marketplace:updates:unmet:confirm-remove")).toBeNull();
    expect(fake.market.uninstall).not.toHaveBeenCalled();
  });

  describe("each Remove click is its own question (§10.2)", () => {
    const row = (from: string | null) => unmet("not-in-catalog", "notes", {
      key: { sourceId: "corp", kind: "mcp", name: "notes" },
      installedFrom: from === null ? null : { sourceId: from, label: from, removal: "confirm" },
    });
    const push = (fake: ReturnType<typeof fakeMarketplace>, ...rows: UnmetRequirementView[]) => fake.emitUpdateStatus(updateStatus({ unmetRequired: rows }));
    const id = (name: string) => `git-marketplace:updates:unmet:${name}`;
    type Reply = Parameters<ReturnType<typeof fakeMarketplace>["market"]["uninstall"]["mockResolvedValueOnce"]>[0];
    /** The uninstall replies the test sends when it chooses, in call order. */
    function heldReplies(fake: ReturnType<typeof fakeMarketplace>) {
      const replies: Array<(reply: Reply) => void> = [];
      fake.market.uninstall.mockImplementation(() => new Promise<Reply>((resolve) => { replies.push(resolve); }));
      return replies;
    }
    const removed = (from: string) => ({ ok: true as const, value: { key: { sourceId: from, kind: "mcp" as const, name: "notes" }, keptDataDir: null } });
    const conflict = { ok: false as const, code: "PACKAGE_ID_CONFLICT" as const, message: "mcp notes is not installed from team" };
    async function opened(fake: ReturnType<typeof fakeMarketplace>) {
      const result = renderTab(fake);
      fireEvent.click(await screen.findByTestId(id("remove")));
      expect(screen.getByTestId(id("confirm-remove"))).toHaveTextContent("team에서 설치된 notes");
      return result;
    }

    it("is invalidated by every status it receives: one naming another install and the next naming its own again, before a frame, still remove nothing", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      await opened(fake);
      act(() => {
        push(fake, row("replacement"));
        push(fake, row("team"));
      });
      expect(screen.getByTestId(id("remove-changed"))).toBeInTheDocument();
      expect(screen.queryByTestId(id("confirm-uninstall"))).toBeNull();
      expect(fake.market.uninstall).not.toHaveBeenCalled();
    });

    it("ends when its row goes, also when the row comes back before a frame", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      await opened(fake);
      act(() => {
        push(fake);
        push(fake, row("team"));
      });
      expect(screen.getByTestId("git-marketplace:updates:unmet:corp:mcp:notes")).toBeInTheDocument();
      expect(screen.queryByTestId(id("confirm-remove"))).toBeNull();
      expect(fake.market.uninstall).not.toHaveBeenCalled();
    });

    it("judges a click by what is true when it lands: a confirmation drawn before a status that changed the install, or before Cancel, sends nothing", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      await opened(fake);
      const confirm = screen.getByTestId(id("confirm-uninstall"));
      act(() => {
        push(fake, row("replacement"));
        fireEvent.click(confirm);
      });
      expect(fake.market.uninstall).not.toHaveBeenCalled();
      // A new question, cancelled, and its confirmation clicked before the frame that drops it.
      fireEvent.click(screen.getByTestId(id("remove")));
      const cancel = within(screen.getByTestId(id("confirm-remove"))).getByText("취소");
      const again = screen.getByTestId(id("confirm-uninstall"));
      act(() => {
        fireEvent.click(cancel);
        fireEvent.click(again);
      });
      expect(screen.queryByTestId(id("confirm-remove"))).toBeNull();
      expect(fake.market.uninstall).not.toHaveBeenCalled();
    });

    it("sends once for a double click", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      const replies = heldReplies(fake);
      await opened(fake);
      const confirm = screen.getByTestId(id("confirm-uninstall"));
      act(() => {
        fireEvent.click(confirm);
        fireEvent.click(confirm);
      });
      expect(fake.market.uninstall).toHaveBeenCalledOnce();
      expect(screen.getByTestId(id("confirm-uninstall"))).toBeDisabled();
      await act(async () => replies[0]!(removed("team")));
      expect(screen.queryByTestId(id("confirm-remove"))).toBeNull();
    });

    it("takes a reply only for the question that sent it: an earlier request's failure neither frees nor fails the new one, and shows as its own", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      const replies = heldReplies(fake);
      await opened(fake);
      fireEvent.click(screen.getByTestId(id("confirm-uninstall")));
      act(() => push(fake, row("replacement")));
      expect(screen.getByTestId(id("remove-changed"))).toBeInTheDocument();
      fireEvent.click(screen.getByTestId(id("remove")));
      expect(screen.getByTestId(id("confirm-remove"))).toHaveTextContent("replacement에서 설치된 notes");
      fireEvent.click(screen.getByTestId(id("confirm-uninstall")));
      expect(fake.market.uninstall.mock.calls.map(([request]) => request.sourceId)).toEqual(["team", "replacement"]);
      await act(async () => replies[0]!(conflict));
      // The new request is still running, and its question shows no failure of its own.
      expect(screen.getByTestId(id("confirm-uninstall"))).toBeDisabled();
      expect(screen.queryByTestId(id("remove-error"))).toBeNull();
      expect(within(screen.getByTestId(id("earlier-remove"))).getByTestId(id("earlier-remove-error"))).toBeInTheDocument();
      expect(screen.getByTestId(id("earlier-remove"))).toHaveTextContent("앞서 요청한 team의 notes 제거를 마치지 못했습니다:");
      // Its own reply ends it; the earlier failure stays until Remove is chosen again.
      await act(async () => replies[1]!(removed("replacement")));
      expect(screen.queryByTestId(id("confirm-remove"))).toBeNull();
      expect(screen.getByTestId(id("earlier-remove"))).toBeInTheDocument();
      fireEvent.click(screen.getByTestId(id("remove")));
      expect(screen.queryByTestId(id("earlier-remove"))).toBeNull();
    });

    it("drops an earlier request's failure with its row, also when the row comes back before a frame", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      const replies = heldReplies(fake);
      await opened(fake);
      fireEvent.click(screen.getByTestId(id("confirm-uninstall")));
      act(() => push(fake, row("replacement")));
      fireEvent.click(screen.getByTestId(id("remove")));
      await act(async () => replies[0]!(conflict));
      expect(screen.getByTestId(id("earlier-remove"))).toBeInTheDocument();
      act(() => {
        push(fake);
        push(fake, row(null));
      });
      expect(screen.getByTestId("git-marketplace:updates:unmet:corp:mcp:notes")).toBeInTheDocument();
      expect(screen.queryByTestId(id("earlier-remove"))).toBeNull();
      expect(screen.queryByTestId(id("confirm-remove"))).toBeNull();
    });

    it("takes a reply only for the question that sent it: an earlier request's success does not close the new question", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      const replies = heldReplies(fake);
      await opened(fake);
      fireEvent.click(screen.getByTestId(id("confirm-uninstall")));
      act(() => push(fake, row("replacement")));
      fireEvent.click(screen.getByTestId(id("remove")));
      await act(async () => replies[0]!(removed("team")));
      expect(screen.getByTestId(id("confirm-remove"))).toHaveTextContent("replacement에서 설치된 notes");
      expect(screen.getByTestId(id("confirm-uninstall"))).toBeEnabled();
      expect(screen.queryByTestId(id("earlier-remove"))).toBeNull();
    });

    it("keeps a newer question open against a Close drawn for the one it replaced", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      await opened(fake);
      act(() => push(fake, row("replacement")));
      const close = within(screen.getByTestId(id("confirm-remove"))).getByText("닫기");
      const remove = screen.getByTestId(id("remove"));
      act(() => {
        fireEvent.click(remove);
        fireEvent.click(close);
      });
      expect(screen.getByTestId(id("confirm-remove"))).toHaveTextContent("replacement에서 설치된 notes");
    });

    it("lets a request finish after the card is gone", async () => {
      const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [row("team")] }) });
      const replies = heldReplies(fake);
      const errors = vi.spyOn(console, "error");
      try {
        const { unmount } = await opened(fake);
        fireEvent.click(screen.getByTestId(id("confirm-uninstall")));
        unmount();
        await act(async () => replies[0]!(conflict));
        await act(async () => push(fake, row(null)));
        expect(errors).not.toHaveBeenCalled();
        expect(fake.market.uninstall).toHaveBeenCalledOnce();
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("shows a refresh that failed, whether the reply failed or the source's sync did, and nothing once every requirement is met", async () => {
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ unmetRequired: [unmet("not-in-catalog", "audit")] }) });
    renderTab(fake);
    const refresh = await screen.findByTestId("git-marketplace:updates:unmet:refresh");
    // An ordinary sync failure arrives inside a successful reply, as the source's status.
    const unreachable = source({ id: "corp", label: "Corp tools", status: { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "offline" }, cached: true } });
    fake.market.refreshSources.mockResolvedValueOnce({ ok: true, value: [team, unreachable] });
    fireEvent.click(refresh);
    const failed = await screen.findByTestId("git-marketplace:updates:unmet:refresh-failed");
    expect(failed).toHaveTextContent("Corp tools 새로 고침을 마치지 못했습니다:");
    expect(failed).toHaveTextContent("연결할 수 없음");
    // A sync that succeeds clears it.
    fake.market.refreshSources.mockResolvedValueOnce({ ok: true, value: [team, source({ id: "corp", label: "Corp tools" })] });
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:updates:unmet:refresh-failed")).toBeNull());
    // The reply itself failing.
    fake.market.refreshSources.mockResolvedValueOnce({ ok: false, code: "SOURCE_UNREACHABLE", message: "network is unreachable", detail: { reason: "offline" } });
    fireEvent.click(refresh);
    expect(await screen.findByTestId("git-marketplace:updates:unmet:error")).toBeInTheDocument();
    act(() => fake.emitUpdateStatus(updateStatus()));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:updates:unmet")).toBeNull());
  });
});

describe("component approval of an approval-pending agent plugin (§18.7.5)", () => {
  const pending = (installId: string) => pkg({
    key: notesKey,
    displayName: "Notes",
    state: "approval-pending",
    pendingApproval: {
      installId,
      consentDelta: [{ field: "mcpServer:search", checkpoint: "staged", before: "a".repeat(64), after: "b".repeat(64) }],
      components: [{ name: "search", digest: "c".repeat(64), approvalDigest: "b".repeat(64) }],
    },
  });

  it("approves what it shows for the installed generation it shows", async () => {
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ packages: [pending("11111111-2222-4333-8444-555555555555")] }) });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:updates:row:team:agent-plugin:notes")).getByTestId("git-marketplace:updates:review"));
    const dialog = await screen.findByTestId("git-marketplace:approval");
    const approve = within(dialog).getByTestId("git-marketplace:approval:approve");
    expect(approve).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("git-marketplace:consent-approve:mcpServer:search"));
    fireEvent.click(approve);
    await waitFor(() => expect(fake.market.approveComponents).toHaveBeenCalledWith(notesKey, "11111111-2222-4333-8444-555555555555", [
      { name: "search", digest: "c".repeat(64), approvalDigest: "b".repeat(64) },
    ]));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:approval")).toBeNull());
  });

  it("says the package changed, approves nothing more, and shows the new generation once read again", async () => {
    const fake = fakeMarketplace({ sources: [team], updateStatus: updateStatus({ packages: [pending("11111111-2222-4333-8444-555555555555")] }) });
    fake.market.approveComponents.mockResolvedValue({ ok: false, code: "PLAN_EXPIRED", message: "package changed", detail: { reason: "package-changed" } });
    renderTab(fake);
    fireEvent.click(within(await screen.findByTestId("git-marketplace:updates:row:team:agent-plugin:notes")).getByTestId("git-marketplace:updates:review"));
    const dialog = await screen.findByTestId("git-marketplace:approval");
    fireEvent.click(within(dialog).getByTestId("git-marketplace:consent-approve:mcpServer:search"));
    fake.market.updateStatus.mockResolvedValue({ ok: true, value: updateStatus({ packages: [pending("99999999-2222-4333-8444-555555555555")] }) });
    fireEvent.click(within(dialog).getByTestId("git-marketplace:approval:approve"));
    expect(await within(dialog).findByTestId("git-marketplace:approval:error")).toHaveTextContent("검토한 뒤 이 패키지가 바뀌었습니다. 다시 검토하세요.");
    // The new generation is a new review: nothing stays checked.
    await waitFor(() => expect(within(dialog).getByTestId("git-marketplace:approval:approve")).toBeDisabled());
    fireEvent.click(within(dialog).getByTestId("git-marketplace:consent-approve:mcpServer:search"));
    fake.market.approveComponents.mockResolvedValue({ ok: true, value: updateStatus() });
    fireEvent.click(within(dialog).getByTestId("git-marketplace:approval:approve"));
    await waitFor(() => expect(fake.market.approveComponents).toHaveBeenLastCalledWith(notesKey, "99999999-2222-4333-8444-555555555555", expect.any(Array)));
  });
});

describe("the update review's consent rows (§18.7.3)", () => {
  const calendar = entry("team", "plugin", "calendar", { state: { state: "update", from: "1.0.0", to: "1.1.0" } });
  const hookConsent = { kind: "extension" as const, component: "hook" as const, localId: "audit", approvalDigest: "d".repeat(64) };
  const plan = (overrides: Partial<UpdatePlanView>): UpdatePlanView => ({
    ...installPlan(calendar, { version: "1.1.0", action: { action: "replace", direction: "upgrade", from: "1.0.0" } }),
    from: "1.0.0",
    commitRange: { from: COMMIT_A, to: COMMIT_B },
    authorityDelta: null,
    componentsDelta: null,
    historyRewritten: null,
    needsConfirmation: false,
    consentDelta: [],
    codeFreeChange: false,
    reviewComponents: [],
    ...overrides,
  });

  async function openReview(fake: ReturnType<typeof fakeMarketplace>) {
    fireEvent.click(within(await screen.findByTestId("git-marketplace:card:team:plugin:calendar")).getByTestId("git-marketplace:card:state"));
    const sheet = await screen.findByTestId("git-marketplace:sheet");
    await within(sheet).findByTestId("git-marketplace:review");
    expect(fake.market.planUpdate).toHaveBeenCalled();
    return sheet;
  }

  it("shows each changed field, and installs an extension's new hook only with its box checked", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planUpdate.mockResolvedValue({ ok: true, value: plan({
      consentDelta: [
        { field: "authority.capabilities", checkpoint: "catalog", before: ["notes:read"], after: ["notes:read", "notes:write"] },
        { field: "hook:audit", checkpoint: "staged", before: null, after: "d".repeat(64) },
        { field: "authority.networkAccess", checkpoint: "catalog", before: null, after: { allowedDomains: ["upload.example.com"], reasoning: "Uploads drafts." } },
      ],
      reviewComponents: [{ kind: "extension", field: "hook:audit", consent: hookConsent }],
    }) });
    fake.market.executeInstall.mockImplementation(() => new Promise(() => {}));
    renderTab(fake);
    const sheet = await openReview(fake);
    expect(within(sheet).getByTestId("git-marketplace:consent-row:authority.capabilities")).toHaveTextContent("권한notes:read → notes:read, notes:write");
    expect(within(sheet).getByTestId("git-marketplace:consent-row:hook:audit")).toHaveTextContent("없음 → dddddddddddd");
    expect(within(sheet).queryByTestId("git-marketplace:consent-approve:authority.capabilities")).toBeNull();
    expect(within(sheet).getByTestId("git-marketplace:consent-row:authority.networkAccess")).toHaveTextContent("allowedDomains: upload.example.com · reasoning: Uploads drafts.");

    fireEvent.click(within(sheet).getByTestId("git-marketplace:consent-approve:hook:audit"));
    fireEvent.click(within(sheet).getByTestId("git-marketplace:confirm"));
    expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1", [hookConsent]);
  });

  it("a code-free change is one row of non-code files and one Approve update that approves every changed component", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [calendar] });
    fake.market.planUpdate.mockResolvedValue({ ok: true, value: plan({
      consentDelta: [{ field: "hook:audit", checkpoint: "staged", before: "e".repeat(64), after: "d".repeat(64), changedFiles: { code: [], nonCode: ["dist/README.md"] } }],
      codeFreeChange: true,
      reviewComponents: [{ kind: "extension", field: "hook:audit", consent: hookConsent }],
    }) });
    fake.market.executeInstall.mockImplementation(() => new Promise(() => {}));
    renderTab(fake);
    const sheet = await openReview(fake);
    const row = within(sheet).getByTestId("git-marketplace:code-free");
    expect(row).toHaveTextContent("코드가 아닌 다음 파일만 바뀌었습니다:");
    expect(row).toHaveTextContent("dist/README.md");
    expect(within(sheet).queryByTestId("git-marketplace:consent-delta")).toBeNull();
    const confirm = within(sheet).getByTestId("git-marketplace:confirm");
    expect(confirm).toHaveTextContent("업데이트 승인");
    fireEvent.click(confirm);
    expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-1", [hookConsent]);
  });
});

describe("the boot notice's Updated automatically (§18.7.5)", () => {
  it("lists each automatic update with What changed, and sends an organization's update with components waiting to their approval", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      bootNotice: {
        forYou: [], required: [], unmanaged: [], lostGrants: [], revoked: [],
        autoUpdated: [
          { key: meetingKey, displayName: "Meeting", from: "1.0.0", to: "1.1.0", commitRange: { from: COMMIT_A, to: COMMIT_B }, required: false, state: "applied" },
          { key: { ...meetingKey, name: "vpn" }, displayName: "VPN", from: "2.0.0", to: "2.1.0", commitRange: { from: null, to: COMMIT_B }, required: true, state: "approval-pending" },
        ],
      },
    });
    const { onOpenPluginSettings } = renderTab(fake);
    const banner = await screen.findByTestId("git-marketplace:boot-notice");
    // Automatic updates alone arrive at any time: the title names no time.
    expect(within(banner).getByTestId("git-marketplace:boot-notice:title")).toHaveTextContent("마켓플레이스 변경 사항");
    const meeting = within(banner).getByTestId("git-marketplace:boot-notice:auto-updated:team:plugin:meeting");
    expect(meeting).toHaveTextContent("Meeting · 1.0.0 → 1.1.0");
    expect(within(meeting).queryByTestId("git-marketplace:boot-notice:review")).toBeNull();
    fireEvent.click(within(meeting).getByTestId("git-marketplace:boot-notice:what-changed"));
    expect(within(meeting).getByTestId("git-marketplace:boot-notice:commit-range")).toHaveTextContent("aaaaaaa");

    const vpn = within(banner).getByTestId("git-marketplace:boot-notice:auto-updated:team:plugin:vpn");
    expect(vpn).toHaveTextContent("VPN(조직이 적용)");
    fireEvent.click(within(vpn).getByTestId("git-marketplace:boot-notice:review"));
    expect(onOpenPluginSettings).toHaveBeenCalledWith("vpn");
  });
});

describe("the update pill's request (§18.7.5)", () => {
  it("opens the Updates card for an update already applied that still needs the user, and the review otherwise", async () => {
    const fake = fakeMarketplace({ sources: [team], entries: [entry("team", "plugin", "meeting", { state: { state: "update", from: "1.0.0", to: "1.1.0" } })] });
    fake.market.planUpdate.mockImplementation(() => new Promise(() => {}));
    renderTab(fake);
    await screen.findByTestId("git-marketplace:updates");
    const scroll = vi.fn();
    const section = document.querySelector('[data-settings-section="marketplace-maintenance"]') as HTMLElement;
    section.scrollIntoView = scroll;

    act(() => requestUpdateReview([pkg({ state: "applied-not-running" })]));
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    expect(fake.market.planUpdate).not.toHaveBeenCalled();

    // A wait past 30 minutes: the card, where Apply now is.
    act(() => requestUpdateReview([pkg({ state: "waiting", escalated: true })]));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    expect(fake.market.planUpdate).not.toHaveBeenCalled();

    act(() => requestUpdateReview([pkg({ state: "needs-review" })]));
    await waitFor(() => expect(fake.market.planUpdate).toHaveBeenCalledWith(meetingKey));
  });
});
