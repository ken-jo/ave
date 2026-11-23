// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  onPluginBackgroundEffectsAnswered,
  PluginBackgroundEffectsPrompt,
  requestPluginBackgroundEffectsReview,
} from "../PluginBackgroundEffectsPrompt.js";

const ID = "digest-plugin";
const A = "a".repeat(64);
const B = "b".repeat(64);

interface UpgradeRow { pluginId: string; name: string; reviewSha256: string | null; effects: Record<string, unknown> }

/** A host that answers like the IPC handler: unavailable until the plugin runs, approval only for the review it shows. */
function fakeHost(upgrade?: { reviews: readonly UpgradeRow[] } | "fails") {
  const runtime = new Set<(payload: { pluginId: string }) => void>();
  const enabled = new Set<(payload: { pluginId: string; enabled: boolean }) => void>();
  const uninstalled = new Set<(payload: { slug: string; success: boolean }) => void>();
  const state = {
    running: true,
    sha: A as string | null,
    approved: new Set<string>(),
    domains: ["api.example.test"],
    llm: false,
    saveError: null as string | null,
  };
  const getPluginBackgroundEffects = vi.fn(async (pluginId: string) => state.running
    ? {
      ok: true as const, pluginId, name: "Digest Plugin", reviewSha256: state.sha, declared: state.sha !== null,
      approved: state.sha !== null && state.approved.has(state.sha),
      effects: {
        ownStorage: true as const, networkDestinations: state.domains, alertKinds: [], suggestionSources: [], llm: state.llm, workers: state.llm,
      },
    }
    : { ok: false as const, error: "background-effects-unavailable" });
  const approvePluginBackgroundEffects = vi.fn(async (input: { pluginId: string; reviewSha256: string }) => {
    if (state.saveError) return { ok: false as const, error: state.saveError };
    if (input.reviewSha256 !== state.sha) return { ok: false as const, error: "background-effects-review-stale" };
    state.approved.add(input.reviewSha256);
    return { ok: true as const, ...input };
  });
  const getPluginBackgroundEffectsUpgrade = vi.fn(async () => {
    if (upgrade === "fails") throw new Error("host unavailable");
    return { ok: true as const, reviews: upgrade?.reviews ?? [] };
  });
  const finishPluginBackgroundEffectsUpgrade = vi.fn(async () => ({ ok: true as const }));
  const subscribe = <T,>(set: Set<T>) => (handler: T) => {
    set.add(handler);
    return () => { set.delete(handler); };
  };
  Object.defineProperty(window, "aveApi", {
    value: {
      getPluginBackgroundEffects,
      approvePluginBackgroundEffects,
      ...(upgrade === undefined ? {} : { getPluginBackgroundEffectsUpgrade, finishPluginBackgroundEffectsUpgrade }),
      onPluginRuntimeUpdated: subscribe(runtime),
      onPluginEnabledChanged: subscribe(enabled),
      onPluginUninstallResult: subscribe(uninstalled),
    },
    writable: true,
    configurable: true,
  });
  const settle = async (reads: number) => {
    await waitFor(() => expect(getPluginBackgroundEffects).toHaveBeenCalledTimes(reads));
    await act(async () => { await Promise.resolve(); });
  };
  return {
    state, getPluginBackgroundEffects, approvePluginBackgroundEffects, getPluginBackgroundEffectsUpgrade, finishPluginBackgroundEffectsUpgrade, settle,
    started: () => act(() => { for (const handler of runtime) handler({ pluginId: ID }); }),
    enabledChanged: (value: boolean) => act(() => { for (const handler of enabled) handler({ pluginId: ID, enabled: value }); }),
    uninstalled: () => act(() => {
      state.approved.clear();
      for (const handler of uninstalled) handler({ slug: ID, success: true });
    }),
  };
}

const card = () => screen.findByTestId("plugin-background-effects-dialog");
const noCard = () => expect(screen.queryByTestId("plugin-background-effects-dialog")).toBeNull();
const answer = async (label: "허용" | "취소") => {
  fireEvent.click(within(await card()).getByRole("button", { name: label }));
  await waitFor(noCard);
};

afterEach(() => cleanup());

describe("the background effects card owner", () => {
  it("asks when an installed plugin starts with an unapproved scope, approves what it showed, and stays quiet for the same scope", async () => {
    const host = fakeHost();
    const answered = vi.fn();
    const stop = onPluginBackgroundEffectsAnswered(answered);
    render(<PluginBackgroundEffectsPrompt />);

    host.started();
    const dialog = await card();
    expect(within(dialog).getByText("'Digest Plugin'의 백그라운드 작업을 허용할까요?")).toBeInTheDocument();
    expect(within(dialog).getByText("api.example.test")).toBeInTheDocument();
    await answer("허용");
    expect(host.approvePluginBackgroundEffects).toHaveBeenCalledWith({ pluginId: ID, reviewSha256: A });
    expect(answered).toHaveBeenCalledWith(ID);

    host.started();
    await host.settle(2);
    noCard();
    stop();
  });

  it("asks again when an update changes the declared scope", async () => {
    const host = fakeHost();
    host.state.approved.add(A);
    render(<PluginBackgroundEffectsPrompt />);
    host.started();
    await host.settle(1);
    noCard();

    host.state.sha = B;
    host.state.domains = ["api.example.test", "upload.example.test"];
    host.started();
    expect(within(await card()).getByText("upload.example.test")).toBeInTheDocument();
  });

  it("shows one card for an enable, and none when an approved plugin is disabled and enabled again", async () => {
    const host = fakeHost();
    render(<PluginBackgroundEffectsPrompt />);
    host.started();
    host.enabledChanged(true);
    await card();
    expect(screen.getAllByTestId("plugin-background-effects-dialog")).toHaveLength(1);
    await answer("허용");
    await host.settle(2);
    noCard();

    host.state.running = false;
    host.enabledChanged(false);
    host.state.running = true;
    host.started();
    host.enabledChanged(true);
    await host.settle(4);
    noCard();
  });

  it("does not ask again after Cancel until the plugin is enabled again or reinstalled", async () => {
    const host = fakeHost();
    render(<PluginBackgroundEffectsPrompt />);
    host.started();
    await answer("취소");
    host.started();
    await host.settle(2);
    noCard();
    expect(host.approvePluginBackgroundEffects).not.toHaveBeenCalled();

    host.enabledChanged(true);
    await answer("취소");
    host.uninstalled();
    host.started();
    await card();
  });

  it("shows no card for an empty scope, a plugin that is not running, or a failed read", async () => {
    const host = fakeHost();
    render(<PluginBackgroundEffectsPrompt />);
    host.state.sha = null;
    host.started();
    await host.settle(1);
    host.state.sha = A;
    host.state.running = false;
    host.started();
    await host.settle(2);
    host.getPluginBackgroundEffects.mockRejectedValueOnce(new Error("closed"));
    host.state.running = true;
    host.started();
    await host.settle(3);
    noCard();
    host.started();
    await card();
  });

  it("re-reads a review that went stale before Allow and keeps a failed save open", async () => {
    const host = fakeHost();
    render(<PluginBackgroundEffectsPrompt />);
    host.started();
    await card();
    host.state.sha = B;
    host.state.domains = ["upload.example.test"];
    fireEvent.click(within(await card()).getByRole("button", { name: "허용" }));
    await waitFor(() => expect(within(screen.getByTestId("plugin-background-effects-dialog")).getByText("upload.example.test")).toBeInTheDocument());

    host.state.saveError = "background-effects-update-failed";
    fireEvent.click(within(await card()).getByRole("button", { name: "허용" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("백그라운드 작업 승인을 저장하지 못했습니다");
    host.state.saveError = null;
    await answer("허용");
    expect(host.approvePluginBackgroundEffects).toHaveBeenLastCalledWith({ pluginId: ID, reviewSha256: B });
  });

  it("opens from the Review row even after Cancel, and lists background model and helper-process use", async () => {
    const host = fakeHost();
    host.state.llm = true;
    render(<PluginBackgroundEffectsPrompt />);
    host.started();
    const dialog = await card();
    expect(within(dialog).getByText("백그라운드에서 AI 모델 사용 (사용량이 발생할 수 있음)")).toBeInTheDocument();
    expect(within(dialog).getByText("백그라운드에서 보조 프로세스 실행")).toBeInTheDocument();
    await answer("취소");

    act(() => requestPluginBackgroundEffectsReview(ID));
    await card();
  });
});

describe("the first-launch background effects card", () => {
  const UPGRADE = "plugin-background-effects-upgrade-dialog";
  const effects = { ownStorage: true, networkDestinations: ["api.example.test"], alertKinds: [], suggestionSources: [], llm: false, workers: false };
  const upgradeCard = () => screen.findByTestId(UPGRADE);
  const upgradeClosed = () => waitFor(() => expect(screen.queryByTestId(UPGRADE)).toBeNull());

  it("shows one card from mount alone for every unapproved plugin, allows each from its row and says why an unpinned one cannot be", async () => {
    const host = fakeHost({ reviews: [
      { pluginId: ID, name: "Digest Plugin", reviewSha256: A, effects },
      { pluginId: "unpinned-plugin", name: "Unpinned Plugin", reviewSha256: null, effects },
    ] });
    const answered = vi.fn();
    const stop = onPluginBackgroundEffectsAnswered(answered);
    render(<PluginBackgroundEffectsPrompt />);

    const dialog = await upgradeCard();
    noCard();
    const row = within(dialog).getByTestId(`plugin-background-effects-upgrade-row-${ID}`);
    const unpinned = within(dialog).getByTestId("plugin-background-effects-upgrade-row-unpinned-plugin");
    expect(within(row).getByText("Digest Plugin")).toBeInTheDocument();
    expect(within(row).getByText("api.example.test")).toBeInTheDocument();
    expect(within(unpinned).getByText("출처가 고정되지 않았습니다. 마켓플레이스에서 다시 설치하세요.")).toBeInTheDocument();
    expect(within(unpinned).queryByRole("button")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "허용" }));
    await waitFor(() => expect(within(row).getByText("허용됨")).toBeInTheDocument());
    expect(host.approvePluginBackgroundEffects).toHaveBeenCalledExactlyOnceWith({ pluginId: ID, reviewSha256: A });
    expect(answered).toHaveBeenCalledWith(ID);
    expect(host.finishPluginBackgroundEffectsUpgrade).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "나중에" }));
    await upgradeClosed();
    expect(host.finishPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(1);
    expect(answered).toHaveBeenCalledWith("unpinned-plugin");
    expect(host.getPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(1);
    stop();
  });

  it("holds per-plugin cards while it is open, and Later leaves each listed review to its Review row", async () => {
    const host = fakeHost({ reviews: [{ pluginId: ID, name: "Digest Plugin", reviewSha256: A, effects }] });
    render(<PluginBackgroundEffectsPrompt />);
    const dialog = await upgradeCard();
    host.started();
    await act(async () => { await Promise.resolve(); });
    noCard();
    expect(host.getPluginBackgroundEffects).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "나중에" }));
    await upgradeClosed();
    await host.settle(1);
    noCard();
    host.started();
    await host.settle(2);
    noCard();
    expect(host.approvePluginBackgroundEffects).not.toHaveBeenCalled();
    expect(host.finishPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(1);

    act(() => requestPluginBackgroundEffectsReview(ID));
    await card();
  });

  it("closes once every listed plugin is answered, and hands a review that changed to its own card", async () => {
    const host = fakeHost({ reviews: [{ pluginId: ID, name: "Digest Plugin", reviewSha256: A, effects }] });
    render(<PluginBackgroundEffectsPrompt />);
    const dialog = await upgradeCard();
    host.state.sha = B;
    fireEvent.click(within(dialog).getByRole("button", { name: "허용" }));
    await upgradeClosed();
    expect(host.finishPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(1);
    await answer("허용");
    expect(host.approvePluginBackgroundEffects.mock.calls).toEqual([[{ pluginId: ID, reviewSha256: A }], [{ pluginId: ID, reviewSha256: B }]]);
  });

  it.each([
    ["nothing is owed", { reviews: [] }, 1],
    ["the list cannot be read", "fails", 0],
  ] as const)("asks per plugin as before when %s", async (_label, upgrade, finished) => {
    const host = fakeHost(upgrade);
    render(<PluginBackgroundEffectsPrompt />);
    await waitFor(() => expect(host.getPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(host.finishPluginBackgroundEffectsUpgrade).toHaveBeenCalledTimes(finished);
    expect(screen.queryByTestId(UPGRADE)).toBeNull();
    host.started();
    await answer("허용");
    expect(host.approvePluginBackgroundEffects).toHaveBeenCalledExactlyOnceWith({ pluginId: ID, reviewSha256: A });
  });
});
