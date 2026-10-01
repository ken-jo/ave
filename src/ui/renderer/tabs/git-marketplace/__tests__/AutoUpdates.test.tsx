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
import type { PackageUpdateView, UpdatePlanView } from "../../../../../shared/git-marketplace.js";
import type { AveApi } from "../../../types.js";
import { GitMarketplaceTab } from "../GitMarketplaceTab.js";
import { requestUpdateReview } from "../update-review-request.js";
import { COMMIT_A, COMMIT_B, entry, fakeMarketplace, installPlan, source, updateStatus } from "./fixtures.js";

function renderTab(fake: ReturnType<typeof fakeMarketplace>, overrides: Parameters<typeof makeMockAveApi>[0] = {}) {
  const { api } = makeMockAveApi(overrides);
  Object.assign(api, { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime });
  const onOpenPluginSettings = vi.fn();
  render(<GitMarketplaceTab api={api as unknown as AveApi} onOpenMcpSettings={vi.fn()} onOpenPluginSettings={onOpenPluginSettings} />);
  return { api, onOpenPluginSettings };
}

const team = source({ id: "team", label: "Team tools" });
const lan = source({ id: "lan", label: "LAN tools" });
const meetingKey = { sourceId: "team", kind: "plugin" as const, name: "meeting" };
const notesKey = { sourceId: "team", kind: "agent-plugin" as const, name: "notes" };
const pkg = (overrides: Partial<PackageUpdateView> & Pick<PackageUpdateView, "state">): PackageUpdateView => ({
  key: meetingKey, displayName: "Meeting", from: "1.0.0", to: "1.1.0", ...overrides,
});
const switchOn = { effective: true, override: null, lockedByPolicy: false };

describe("the switches (§18.7.2)", () => {
  it("writes the global switch, and shows the organization's lock instead of letting it change", async () => {
    const fake = fakeMarketplace({ sources: [team] });
    const { api } = renderTab(fake);
    const toggle = await screen.findByTestId("git-marketplace:updates:automatic");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ marketplace: { autoUpdate: false } }));

    act(() => fake.emitUpdateStatus(updateStatus({ autoUpdate: { enabled: false, lockedByPolicy: "off", sources: [] } })));
    await waitFor(() => expect(screen.getByTestId("git-marketplace:updates:automatic")).toBeDisabled());
    expect(screen.getByTestId("git-marketplace:updates:automatic:policy")).toHaveTextContent("조직이 설정함: 검토한 업데이트만 설치됩니다.");
  });

  it("rewrites a package's switch map from the saved settings, and Default removes the package's own switch", async () => {
    const fake = fakeMarketplace({
      sources: [team],
      updateStatus: updateStatus({ packages: [pkg({ state: "manual", reasons: ["switched-off"], autoUpdate: { effective: false, override: "off", lockedByPolicy: false } })] }),
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
            { id: "team", label: "Team tools", switch: switchOn, needsUnencryptedUpdates: false },
            { id: "lan", label: "LAN tools", switch: { effective: false, override: null, lockedByPolicy: false }, needsUnencryptedUpdates: true },
          ],
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

    act(() => requestUpdateReview([pkg({ state: "needs-review" })]));
    await waitFor(() => expect(fake.market.planUpdate).toHaveBeenCalledWith(meetingKey));
  });
});
