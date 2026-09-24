/**
 * Sources, Add and the installs without a marketplace (design §15.4, §15.5,
 * §15.7, §8.1): what each origin may do, the add flow with git as its
 * blocking first step, and the pasted server.json that connects unbound.
 */
// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GitMarketplaceApi, MarketplacePreviewView, SourceView } from "../../../../../shared/git-marketplace.js";
import type { AveApi } from "../../../types.js";
import { AddSourceDialog } from "../AddSourceDialog.js";
import { DirectInstallView } from "../DirectInstallView.js";
import { GitRuntimeCard } from "../GitRuntimeCard.js";
import { SourcesView } from "../SourcesView.js";
import { COMMIT_A, COMMIT_B, fakeMarketplace, source } from "./fixtures.js";

function sourcesView(fake: ReturnType<typeof fakeMarketplace>, sources: SourceView[]) {
  const onChanged = vi.fn();
  render(<SourcesView api={fake.market as unknown as GitMarketplaceApi} sources={sources} onChanged={onChanged} onAdd={vi.fn()} />);
  return { onChanged };
}

describe("SourcesView", () => {
  it("offers no Remove and no switch for the official source", () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "ave-official", origin: "official", label: "Ave Official", canRemove: false, canDisable: false })]);

    const row = screen.getByTestId("git-marketplace:source:ave-official");
    expect(within(row).queryByTestId("git-marketplace:source:ave-official:remove")).toBeNull();
    expect(within(row).getByRole("switch")).toBeDisabled();
    // Named once, as everywhere in the tab, not by its label plus an identical badge.
    expect(within(row).getAllByText("Ave 공식")).toHaveLength(1);
    expect(within(row).queryByText("Ave Official")).toBeNull();
  });

  it("removes a custom source and names the packages it leaves installed", async () => {
    const fake = fakeMarketplace();
    fake.market.removeSource.mockResolvedValue({ ok: true, value: { orphanedPackages: [{ sourceId: "team", kind: "skill", name: "proofread" }] } });
    const { onChanged } = sourcesView(fake, [source({ id: "team", label: "Team tools" })]);

    fireEvent.click(screen.getByTestId("git-marketplace:source:team:remove"));
    expect(await screen.findByText("Team tools을(를) 제거할까요?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("git-marketplace:sources:confirm"));

    await waitFor(() => expect(fake.market.removeSource).toHaveBeenCalledWith("team"));
    expect(await screen.findByTestId("git-marketplace:sources:orphaned")).toHaveTextContent("스킬 proofread");
    expect(onChanged).toHaveBeenCalled();
  });

  it("accepts a rewritten history only for the commit it showed", async () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "team", status: { state: "history-rewritten", candidate: COMMIT_B, reviewable: true } })]);

    fireEvent.click(screen.getByRole("button", { name: "검토" }));
    expect(await screen.findByText(/새 커밋 bbbbbbb은\(는\) 고정된 aaaaaaa에서 이어지지 않습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("git-marketplace:sources:confirm"));
    await waitFor(() => expect(fake.market.acceptRewrite).toHaveBeenCalledWith("team", COMMIT_B));
  });

  it("keeps the pin of a rewritten managed source without a Review", () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "corp", origin: "managed", canRemove: false, status: { state: "history-rewritten", candidate: COMMIT_B, reviewable: false } })]);

    expect(screen.getByText("히스토리 재작성됨 — 고정 유지")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "검토" })).toBeNull();
  });

  it("stores a token under the source's host", async () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "team", auth: "token", tokenHost: "github.com" })]);

    fireEvent.click(screen.getByRole("button", { name: "토큰 설정…" }));
    const confirm = await screen.findByTestId("git-marketplace:sources:confirm");
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("액세스 토큰 붙여넣기"), { target: { value: "ghp_example" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(fake.market.setToken).toHaveBeenCalledWith("github.com", "ghp_example"));
  });

  it("drops a token typed for one host when its dialog is cancelled, so the next host's dialog starts empty", async () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "team", auth: "token", tokenHost: "github.com" }), source({ id: "corp", auth: "token", tokenHost: "git.corp.example" })]);

    fireEvent.click(within(screen.getByTestId("git-marketplace:source:team")).getByRole("button", { name: "토큰 설정…" }));
    fireEvent.change(await screen.findByPlaceholderText("액세스 토큰 붙여넣기"), { target: { value: "ghp_for_github" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:sources:confirm")).toBeNull());

    fireEvent.click(within(screen.getByTestId("git-marketplace:source:corp")).getByRole("button", { name: "토큰 설정…" }));
    expect(await screen.findByPlaceholderText<HTMLInputElement>("액세스 토큰 붙여넣기")).toHaveValue("");
    expect(screen.getByTestId("git-marketplace:sources:confirm")).toBeDisabled();
    expect(fake.market.setToken).not.toHaveBeenCalled();
  });
});

function addDialog(fake: ReturnType<typeof fakeMarketplace>, direct = false) {
  const onAdded = vi.fn();
  const api = { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime, updateSettings: vi.fn(async () => ({ ok: true })) };
  render(<AddSourceDialog api={api as unknown as Pick<AveApi, "gitMarketplace" | "gitRuntime" | "updateSettings">} open direct={direct} onClose={vi.fn()} onAdded={onAdded} />);
  return { onAdded };
}

const marketplacePreview: MarketplacePreviewView = {
  type: "marketplace",
  previewId: "preview-1",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  url: "https://github.com/example/team.git",
  ref: null,
  commit: COMMIT_A,
  marketplace: { name: "team", displayName: "Team tools", description: null, owner: "example" },
  counts: { plugin: 2, skill: 3 },
  codeRunning: 2,
  diagnostics: ["plugins/broken: missing plugin.json"],
  credentialHelper: false,
  suggestedId: "team",
};

describe("AddSourceDialog", () => {
  it("previews what the repository holds before adding it under the chosen name", async () => {
    const fake = fakeMarketplace();
    fake.market.previewSource.mockResolvedValue({ ok: true, value: marketplacePreview });
    fake.market.addSource.mockResolvedValue({ ok: true, value: source({ id: "team-tools" }) });
    const { onAdded } = addDialog(fake);

    const check = await screen.findByTestId("git-marketplace:add:check");
    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "example/team" } });
    fireEvent.click(screen.getByTestId("git-marketplace:add:auth:token"));
    fireEvent.change(screen.getByTestId("git-marketplace:add:token"), { target: { value: "ghp_example" } });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);

    const preview = await screen.findByTestId("git-marketplace:add:preview");
    expect(fake.market.previewSource).toHaveBeenCalledWith({ input: "example/team", auth: "token", token: "ghp_example" });
    expect(preview).toHaveTextContent("패키지 2개가 이 컴퓨터에서 코드를 실행할 수 있습니다.");
    expect(preview).toHaveTextContent("건너뜀: plugins/broken: missing plugin.json");
    expect(screen.getByTestId("git-marketplace:add:id")).toHaveValue("team");

    fireEvent.change(screen.getByTestId("git-marketplace:add:id"), { target: { value: "team-tools" } });
    fireEvent.click(screen.getByTestId("git-marketplace:add:confirm"));
    await waitFor(() => expect(fake.market.addSource).toHaveBeenCalledWith({ previewId: "preview-1", id: "team-tools" }));
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "team-tools" }), marketplacePreview);
  });

  it("asks for the package folder when installing from a git address", async () => {
    const fake = fakeMarketplace();
    fake.market.previewSource.mockResolvedValue({ ok: false, code: "SOURCE_NOT_A_MARKETPLACE", message: "no package at skills/x" });
    addDialog(fake, true);

    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeDisabled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "example/skills" } });
    fireEvent.change(screen.getByLabelText("폴더(선택)"), { target: { value: "skills/x" } });
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));

    await waitFor(() => expect(fake.market.previewSource).toHaveBeenCalledWith({ input: "example/skills", auth: "none", subdir: "skills/x" }));
    expect(await screen.findByTestId("git-marketplace:add:error")).toHaveTextContent("그곳에서 마켓플레이스나 패키지를 찾지 못했습니다. no package at skills/x");
  });

  it("makes installing git the first step when git is missing", async () => {
    const fake = fakeMarketplace({ git: "missing" });
    addDialog(fake);

    expect(await screen.findByTestId("git-runtime:missing")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:add:url")).toBeNull();
    fireEvent.click(screen.getByTestId("git-runtime:install"));
    expect(await screen.findByTestId("git-marketplace:add:url")).toBeInTheDocument();
    expect(fake.gitRuntime.install).toHaveBeenCalledTimes(1);
  });
});

describe("GitRuntimeCard", () => {
  it("reads the status once however often its caller renders", async () => {
    const fake = fakeMarketplace({ git: "missing" });
    const api = { gitRuntime: fake.gitRuntime, updateSettings: vi.fn() } as unknown as Pick<AveApi, "gitRuntime" | "updateSettings">;
    const { rerender } = render(<GitRuntimeCard api={api} onReady={() => undefined} />);
    await screen.findByTestId("git-runtime:missing");
    rerender(<GitRuntimeCard api={api} onReady={() => undefined} />);
    rerender(<GitRuntimeCard api={api} onReady={() => undefined} />);
    expect(fake.gitRuntime.status).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("git-runtime:install")).toHaveTextContent("Git 설치(약 59 MB)");
  });

  it("saves the mode and reads the status again", async () => {
    const fake = fakeMarketplace();
    const updateSettings = vi.fn(async () => ({ ok: true }));
    render(<GitRuntimeCard api={{ gitRuntime: fake.gitRuntime, updateSettings } as unknown as Pick<AveApi, "gitRuntime" | "updateSettings">} />);
    expect(await screen.findByTestId("git-runtime:ready")).toHaveTextContent("시스템 git 2.47.0을(를) 사용 중입니다.");

    fireEvent.click(screen.getByTestId("git-runtime:mode:managed"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ marketplace: { git: { mode: "managed" } } }));
    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalledTimes(2));
  });

  it("says the status is unavailable when main cannot answer", async () => {
    const fake = fakeMarketplace();
    fake.gitRuntime.status.mockResolvedValue({ ok: false, error: "git-runtime-unavailable" });
    render(<GitRuntimeCard api={{ gitRuntime: fake.gitRuntime, updateSettings: vi.fn() } as unknown as Pick<AveApi, "gitRuntime" | "updateSettings">} />);
    expect(await screen.findByTestId("git-runtime:unavailable")).toBeInTheDocument();
  });
});

function serverJsonPreview(select: { package?: number } | undefined) {
  return {
      ok: true,
      value: {
        planId: select?.package === 1 ? "plan-docker" : "plan-npm",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        name: "weather",
        version: "0.5.0",
        runtime: {
          transport: "stdio",
          command: select?.package === 1 ? "docker" : "npx",
          args: ["weather-mcp"],
          url: null,
          env: [{ name: "WEATHER_KEY", secret: true, required: true }],
          usesDataDir: true,
        },
        options: { packages: 2, remotes: 0 },
      },
    };
}

function directView(fake: ReturnType<typeof fakeMarketplace>) {
  fake.market.previewDirectMcp.mockImplementation(async (request: { select?: { package?: number } }) => serverJsonPreview(request.select));
  const onInstalled = vi.fn();
  const api = { gitMarketplace: fake.market, previewClaudeDesktopMcpImport: vi.fn(), applyClaudeDesktopMcpImport: vi.fn() };
  render(<DirectInstallView api={api as unknown as Pick<AveApi, "gitMarketplace" | "previewClaudeDesktopMcpImport" | "applyClaudeDesktopMcpImport">} onGitAddress={vi.fn()} onOpenMcpSettings={vi.fn()} onInstalled={onInstalled} />);
  return { onInstalled };
}

describe("DirectInstallView", () => {
  it("connects a pasted server.json bound to no source after its review", async () => {
    const fake = fakeMarketplace();
    fake.market.executeInstall.mockResolvedValue({ ok: true, value: { key: { sourceId: null, kind: "mcp", name: "weather" }, version: null, action: { action: "install" }, rungs: [], connectionWarning: null } });
    const { onInstalled } = directView(fake);

    fireEvent.click(screen.getByTestId("git-marketplace:direct:tab:server-json"));
    fireEvent.change(screen.getByTestId("git-marketplace:direct:server-json"), { target: { value: '{"name":"weather"}' } });
    fireEvent.click(screen.getByRole("button", { name: "검토" }));
    const shown = await screen.findByTestId("git-marketplace:direct:server-json:preview");
    expect(fake.market.previewDirectMcp).toHaveBeenCalledWith({ serverJson: '{"name":"weather"}' });
    expect(shown).toHaveTextContent("npx weather-mcp");
    expect(shown).toHaveTextContent("WEATHER_KEY (비밀) (필수)");

    fireEvent.click(within(shown).getByRole("button", { name: "패키지 2" }));
    await waitFor(() => expect(screen.getByTestId("git-marketplace:direct:server-json:preview")).toHaveTextContent("docker weather-mcp"));
    expect(fake.market.previewDirectMcp).toHaveBeenLastCalledWith({ serverJson: '{"name":"weather"}', select: { package: 1 } });

    fireEvent.click(screen.getByTestId("git-marketplace:direct:connect"));
    await waitFor(() => expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-docker"));
    expect(await screen.findByTestId("git-marketplace:direct:done")).toHaveTextContent("weather을(를) 연결했습니다.");
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("asks for a fresh review after a failed connect, and forgets the picked package when the document changes", async () => {
    const fake = fakeMarketplace();
    fake.market.executeInstall.mockResolvedValue({ ok: false, code: "unavailable", message: "the server did not start" });
    const { onInstalled } = directView(fake);

    fireEvent.click(screen.getByTestId("git-marketplace:direct:tab:server-json"));
    fireEvent.change(screen.getByTestId("git-marketplace:direct:server-json"), { target: { value: '{"name":"weather"}' } });
    fireEvent.click(screen.getByRole("button", { name: "검토" }));
    fireEvent.click(within(await screen.findByTestId("git-marketplace:direct:server-json:preview")).getByRole("button", { name: "패키지 2" }));
    await waitFor(() => expect(screen.getByTestId("git-marketplace:direct:server-json:preview")).toHaveTextContent("docker weather-mcp"));

    fireEvent.click(screen.getByTestId("git-marketplace:direct:connect"));
    await waitFor(() => expect(fake.market.executeInstall).toHaveBeenCalledWith("plan-docker"));
    // The failed install consumed plan-docker, so Connect is not offered on it again.
    await waitFor(() => expect(screen.queryByTestId("git-marketplace:direct:connect")).toBeNull());
    expect(screen.getByRole("button", { name: "검토" })).toBeEnabled();
    expect(onInstalled).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("git-marketplace:direct:server-json"), { target: { value: '{"name":"forecast"}' } });
    fireEvent.click(screen.getByRole("button", { name: "검토" }));
    await waitFor(() => expect(fake.market.previewDirectMcp).toHaveBeenLastCalledWith({ serverJson: '{"name":"forecast"}' }));
  });
});
