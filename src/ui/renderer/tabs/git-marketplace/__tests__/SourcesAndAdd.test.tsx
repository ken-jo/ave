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
import type { GitRuntimeStatus } from "../../../../../shared/git-runtime.js";
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

  it("says why a background sync failed, in the row, from the detail the status carries", () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [
      source({ id: "team", status: { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "nowhere.invalid" }, cached: true } }),
      source({ id: "corp", status: { state: "auth-required", detail: { reason: "ssh", host: "git.example.com" }, cached: false } }),
      source({ id: "old", status: { state: "unreachable", code: "SOURCE_UNREACHABLE", cached: false } }),
    ]);

    expect(screen.getByTestId("git-marketplace:source:team:status-detail")).toHaveTextContent("nowhere.invalid을(를) 찾을 수 없습니다. 주소나 VPN을 확인하세요.");
    expect(screen.getByTestId("git-marketplace:source:corp:status-detail")).toHaveTextContent("git.example.com이(가) SSH 키를 거부했습니다.");
    // A state written before details existed reads as its code's sentence.
    expect(screen.getByTestId("git-marketplace:source:old:status-detail")).toHaveTextContent("이 소스에 연결하지 못했습니다. 주소와 네트워크를 확인한 뒤 다시 시도하세요.");
  });

  it("points an official source whose host reports no repository at the row's Set token…, never at fields it cannot edit", () => {
    const notFound = { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "not-found", host: "github.com" }, cached: false } as const;
    const official = { origin: "official", auth: "token", tokenHost: "github.com", canRemove: false, canDisable: false, status: notFound } as const;
    sourcesView(fakeMarketplace(), [
      source({ id: "ave", ...official }),
      source({ id: "ave-stored", ...official, tokenStored: true }),
      source({ id: "corp", origin: "managed", canRemove: false, canDisable: false, status: notFound }),
    ]);

    const row = within(screen.getByTestId("git-marketplace:source:ave"));
    const detail = screen.getByTestId("git-marketplace:source:ave:status-detail");
    expect(detail).toHaveTextContent(
      "github.com이(가) 이 소스 주소에 저장소가 없다고 답했습니다. 호스트는 로그인 없이 비공개 저장소를 요청할 때도 같은 답을 합니다. 이 저장소에 권한이 있다면 소스에서 이 소스의 토큰 설정…을 눌러 저장소를 읽을 수 있는 github.com 토큰을 추가하세요.",
    );
    // The action the sentence names is on the row.
    expect(row.getByRole("button", { name: "토큰 설정…" })).toBeInTheDocument();
    expect(screen.getByTestId("git-marketplace:source:ave-stored:status-detail")).toHaveTextContent("토큰에 이 저장소 권한이 없을 수 있습니다.");
    // An organization source without a token: no Set token…, no Remove, so the administrator.
    const corp = screen.getByTestId("git-marketplace:source:corp:status-detail");
    expect(corp).toHaveTextContent("관리자에게 알리세요.");
    for (const text of [detail.textContent!, corp.textContent!]) {
      expect(text).not.toMatch(/폴더 칸|주소와 브랜치|칸을 비워|소스 제거/u);
    }
    expect(corp.textContent).not.toContain("토큰 설정…");
  });

  it("labels a source whose host answered by what failed, not Unreachable", () => {
    sourcesView(fakeMarketplace(), [
      source({ id: "ave", origin: "official", auth: "token", tokenHost: "github.com", canRemove: false, canDisable: false, status: { state: "unreachable", code: "SOURCE_NOT_A_MARKETPLACE", cached: true } }),
      source({ id: "team", status: { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "nowhere.invalid" }, cached: false } }),
    ]);

    const official = screen.getByTestId("git-marketplace:source:ave");
    expect(official).toHaveTextContent("마켓플레이스를 찾을 수 없음 — 캐시 표시 중");
    expect(official).not.toHaveTextContent("연결할 수 없음");
    expect(screen.getByTestId("git-marketplace:source:team")).toHaveTextContent("연결할 수 없음");
  });

  it("keeps why a source cannot be read behind a scrubbed Copy details, not in a tooltip", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    sourcesView(fakeMarketplace(), [
      source({
        id: "team",
        status: { state: "broken", message: "state.json: unexpected token near https://alice:verifier-secret@example.com/x", detail: { reason: "state-invalid", sourceId: "team" } },
      }),
    ]);

    const row = screen.getByTestId("git-marketplace:source:team:copy-details").closest("td")!;
    expect(row).toHaveTextContent("다운로드한 사본 손상됨");
    expect(row.innerHTML).not.toContain("state.json");
    fireEvent.click(screen.getByTestId("git-marketplace:source:team:copy-details"));
    expect(writeText).toHaveBeenCalledWith("state.json: unexpected token near https://[REDACTED:CREDENTIALS]@example.com/x");
  });

  it("offers Repair on a damaged official source, and the sentence names that action", async () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [
      source({
        id: "ave",
        origin: "official",
        canRemove: false,
        canDisable: false,
        status: { state: "broken", message: "state.json of source ave is missing while its synced data remains", detail: { reason: "state-missing", sourceId: "ave" } },
      }),
    ]);

    const row = within(screen.getByTestId("git-marketplace:source:ave"));
    expect(screen.getByTestId("git-marketplace:source:ave:status-detail")).toHaveTextContent(
      "Ave 공식 소스의 다운로드한 사본이 손상되었습니다. Ave가 신뢰하는 버전의 기록이 없습니다. 복구하면 소스를 다시 다운로드하고, 이전 버전과 대조하지 않은 채 지금 제공되는 버전을 신뢰합니다. 소스에서 복구를 누르세요.",
    );
    // Only actions the row can perform: no Refresh (it would fail again), no Remove, and the switch waits for the repair.
    expect(row.queryByRole("button", { name: "새로 고침" })).toBeNull();
    expect(row.queryByTestId("git-marketplace:source:ave:remove")).toBeNull();
    expect(row.getByRole("switch")).toBeDisabled();
    const repair = row.getByTestId("git-marketplace:source:ave:repair");
    expect(repair).toHaveTextContent("복구");
    expect(repair).toBeEnabled();
    fireEvent.click(repair);
    await waitFor(() => expect(fake.market.repairSource).toHaveBeenCalledWith("ave"));
    expect(fake.market.refreshSources).not.toHaveBeenCalled();
  });

  it("shows a failed repair's own sentence with Copy details", async () => {
    const fake = fakeMarketplace();
    fake.market.repairSource.mockResolvedValueOnce({
      ok: false,
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "could not move the downloaded copy of source team aside (EBUSY)",
      detail: { reason: "repair-failed", sourceId: "team" },
    } as never);
    sourcesView(fake, [source({ id: "team", status: { state: "broken", message: "snapshot is invalid", detail: { reason: "snapshot-invalid", sourceId: "team" } } })]);

    fireEvent.click(screen.getByTestId("git-marketplace:source:team:repair"));
    const problem = await screen.findByRole("alert");
    expect(problem).toHaveTextContent("Ave가 team 소스의 손상된 사본을 옮기지 못해 다시 다운로드하지 않았습니다");
    expect(within(problem).getByRole("button", { name: "세부 정보 복사" })).toBeEnabled();
    expect(screen.getByTestId("git-marketplace:source:team:repair")).toBeEnabled();
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
  render(<AddSourceDialog api={api as unknown as Pick<AveApi, "gitMarketplace" | "gitRuntime" | "updateSettings">} open direct={direct} onClose={vi.fn()} onCommitted={vi.fn()} onAdded={onAdded} />);
  return { onAdded };
}

const marketplacePreview: MarketplacePreviewView = {
  type: "marketplace",
  previewId: "preview-1",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  transport: "git",
  url: "https://github.com/example/team.git",
  path: null,
  resolvedFrom: null,
  badges: [],
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
    const problem = await screen.findByTestId("git-marketplace:add:error");
    expect(problem).toHaveTextContent("이 주소에서 마켓플레이스나 패키지를 찾지 못했습니다. 주소와 브랜치, 저장소 안의 패키지라면 폴더 칸을 확인하세요.");
    // Main's English message is behind Copy details, not in the sentence.
    expect(problem).not.toHaveTextContent("no package at skills/x");
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

  it("says a mode it could not save in its own words, with main's text only behind a scrubbed Copy details", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const fake = fakeMarketplace();
    const updateSettings = vi.fn(async () => ({ ok: false, error: "settings-write-failed", message: "EACCES: settings.json (token=s3cret)" }));
    render(<GitRuntimeCard api={{ gitRuntime: fake.gitRuntime, updateSettings } as unknown as Pick<AveApi, "gitRuntime" | "updateSettings">} />);
    await screen.findByTestId("git-runtime:ready");

    fireEvent.click(screen.getByTestId("git-runtime:mode:managed"));
    const problem = await screen.findByTestId("git-runtime:mode-error");
    expect(problem).toHaveTextContent("git 선택을 저장하지 못해 이전 선택이 그대로 적용됩니다.");
    expect(problem).not.toHaveTextContent("EACCES");
    expect(problem).not.toHaveTextContent("settings-write-failed");
    fireEvent.click(within(problem).getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith("settings-write-failed\nEACCES: settings.json (token=[REDACTED:TOKEN]");
  });

  it("names the phase a managed install failed in", async () => {
    const fake = fakeMarketplace({ git: "missing" });
    const status: GitRuntimeStatus = {
      mode: "auto",
      state: "missing",
      active: null,
      systemTooOld: null,
      managed: { version: "2.51.0", installed: false, available: true, size: 62_348_987 },
      lastInstallError: { code: "GIT_RUNTIME_INSTALL_FAILED", message: `sha256 ${"1".repeat(64)} does not match the pinned ${"0".repeat(64)}`, detail: { reason: "verifying" } },
    };
    fake.gitRuntime.status.mockResolvedValue({ ok: true, status });
    render(<GitRuntimeCard api={{ gitRuntime: fake.gitRuntime, updateSettings: vi.fn() } as unknown as Pick<AveApi, "gitRuntime" | "updateSettings">} />);

    const failed = await screen.findByTestId("git-runtime:failed");
    expect(failed).toHaveTextContent("git 설치가 검증 단계에서 실패했습니다. 내려받은 파일이 이 Ave 릴리스에 고정된 파일과 달라 버렸습니다.");
    expect(failed).not.toHaveTextContent("sha256");
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
  return { onInstalled, api };
}

const PASTED = '{"mcpServers":{"notes":{"command":"npx","args":["notes-mcp"]},"files":{"command":"npx"}}}';
const PASTED_PREVIEW = {
  entries: [
    { id: "notes", config: { id: "notes", transport: "stdio", command: "npx", args: ["notes-mcp"] }, suspectedSecretEnvKeys: [] },
    { id: "files", config: { id: "files", transport: "stdio", command: "npx" }, suspectedSecretEnvKeys: [] },
  ],
  errors: [],
};

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

  it("says what became of each pasted server in words with a next action, with main's reason only behind a scrubbed Copy details", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { api } = directView(fakeMarketplace());
    api.previewClaudeDesktopMcpImport.mockResolvedValue(PASTED_PREVIEW);
    api.applyClaudeDesktopMcpImport.mockResolvedValue({
      ok: true,
      results: [
        { id: "notes", action: "skipped-conflict" },
        { id: "files", action: "failed", failure: "permission-denied", reason: "EACCES: permission denied, open settings.json (token=verifier-secret)" },
        { id: "web", action: "failed", failure: "not-found", reason: "ENOENT: no such file or directory, open settings.json" },
        { id: "logs", action: "failed", failure: "unreadable", reason: "EISDIR: illegal operation on a directory, read" },
        { id: "misc", action: "failed", failure: "other", reason: "spawn failed for https://alice:verifier-secret@example.com/mcp" },
        { id: "maps", action: "added", reason: "connect ECONNREFUSED https://alice:verifier-secret@example.com/mcp" },
      ],
      parseErrors: [],
    });
    fireEvent.click(screen.getByTestId("git-marketplace:direct:tab:import"));
    fireEvent.change(screen.getByRole("textbox", { name: "설정 가져오기" }), { target: { value: PASTED } });
    fireEvent.click(screen.getByRole("button", { name: "가져오기 미리 보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "서버 2개 추가" }));

    expect(await screen.findByTestId("git-marketplace:direct:import:notes")).toHaveTextContent("notes: 건너뜀: 같은 ID의 서버가 이미 있습니다");
    const sentences = {
      files: "files을(를) 추가하지 못했습니다. Ave가 MCP 설정 파일에 쓸 권한이 없습니다. Ave 데이터 폴더에 쓸 수 있는지 확인한 뒤 다시 추가하세요.",
      web: "web을(를) 추가하지 못했습니다. MCP 설정 파일이나 그 폴더가 없습니다. Ave를 다시 시작한 뒤 다시 추가하고, 계속되면 세부 정보를 복사해 알려 주세요.",
      logs: "logs을(를) 추가하지 못했습니다. MCP 설정 파일을 읽을 수 없거나 형식이 올바르지 않습니다. MCP 설정에서 확인한 뒤 다시 추가하세요.",
      misc: "misc을(를) 추가하지 못했습니다. 세부 정보를 복사해 원인을 확인한 뒤 다시 시도하고, 계속되면 그 내용과 함께 알려 주세요.",
    };
    for (const [id, sentence] of Object.entries(sentences)) {
      const row = screen.getByTestId(`git-marketplace:direct:import:${id}`);
      expect(row).toHaveTextContent(sentence);
      expect(row).not.toHaveTextContent(/EACCES|ENOENT|EISDIR|spawn failed|verifier-secret/u);
    }
    const added = screen.getByTestId("git-marketplace:direct:import:maps");
    expect(added).toHaveTextContent("maps: 추가됨 — 설정은 추가됐지만 아직 연결되지 않았습니다: connect ECONNREFUSED https://[REDACTED:CREDENTIALS]@example.com/mcp. MCP 설정에서 상태를 확인하고 다시 연결할 수 있습니다.");

    fireEvent.click(within(screen.getByTestId("git-marketplace:direct:import:files")).getByRole("button", { name: "세부 정보 복사" }));
    fireEvent.click(within(screen.getByTestId("git-marketplace:direct:import:misc")).getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText.mock.calls).toEqual([
      ["EACCES: permission denied, open settings.json (token=[REDACTED:TOKEN]"],
      ["spawn failed for https://[REDACTED:CREDENTIALS]@example.com/mcp"],
    ]);
  });

  it("says an import main refused in its own words, with main's answer only behind Copy details", async () => {
    const { api } = directView(fakeMarketplace());
    api.previewClaudeDesktopMcpImport.mockResolvedValue(PASTED_PREVIEW);
    api.applyClaudeDesktopMcpImport.mockResolvedValue({ ok: false, error: "unauthorized-frame" });
    fireEvent.click(screen.getByTestId("git-marketplace:direct:tab:import"));
    fireEvent.change(screen.getByRole("textbox", { name: "설정 가져오기" }), { target: { value: PASTED } });
    fireEvent.click(screen.getByRole("button", { name: "가져오기 미리 보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "서버 2개 추가" }));

    const problem = await screen.findByTestId("git-marketplace:direct:import-error");
    expect(problem).toHaveTextContent("서버를 추가하지 못했습니다.");
    expect(problem).not.toHaveTextContent("unauthorized-frame");
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

describe("confirmations, badges and Allow… (§18.5)", () => {
  it("asks before contacting an http address, then checks again carrying the confirmation", async () => {
    const fake = fakeMarketplace();
    fake.market.previewSource
      .mockResolvedValueOnce({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "git.corp.example", address: null }, { warning: "internal-network", host: "git.corp.example", address: "10.0.0.5" }] } })
      .mockResolvedValueOnce({ ok: true, value: { ...marketplacePreview, url: "http://git.corp.example/team", badges: ["unencrypted", "internal-network"] } });
    addDialog(fake);

    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://git.corp.example/team" } });
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));

    const warnings = await screen.findByTestId("git-marketplace:add:warnings");
    expect(warnings).toHaveAttribute("data-tone", "warning");
    expect(screen.getByTestId("git-marketplace:add:warnings:title")).toHaveTextContent("Ave가 연결하기 전에");
    expect(warnings).toHaveTextContent("git.corp.example은(는) http를 씁니다.");
    expect(warnings).toHaveTextContent("git.corp.example은(는) 사내망 주소(10.0.0.5)입니다.");
    // No preview before the answer.
    expect(screen.queryByTestId("git-marketplace:add:preview")).toBeNull();

    fireEvent.click(screen.getByTestId("git-marketplace:add:warnings:continue"));
    await waitFor(() => expect(fake.market.previewSource).toHaveBeenLastCalledWith({ input: "http://git.corp.example/team", auth: "none", acknowledge: ["unencrypted", "internal-network"] }));
    await screen.findByTestId("git-marketplace:add:preview");
    expect(screen.getByTestId("git-marketplace:add:badge:unencrypted")).toHaveTextContent("암호화 안 됨(http)");
    expect(screen.getByTestId("git-marketplace:add:badge:internal-network")).toHaveTextContent("사내망");
  });

  it("drops the confirmations when the address changes, and on Cancel", async () => {
    const fake = fakeMarketplace();
    fake.market.previewSource.mockResolvedValue({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "a.example", address: null }] } });
    addDialog(fake);

    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://a.example/m" } });
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    await screen.findByTestId("git-marketplace:add:warnings");
    fireEvent.click(screen.getByTestId("git-marketplace:add:warnings:continue"));
    await waitFor(() => expect(fake.market.previewSource).toHaveBeenCalledTimes(2));
    await screen.findByTestId("git-marketplace:add:warnings");
    fireEvent.click(screen.getByTestId("git-marketplace:add:warnings:cancel"));
    expect(screen.queryByTestId("git-marketplace:add:warnings")).toBeNull();

    // Another address starts with no confirmation carried over.
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://b.example/m" } });
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    await waitFor(() => expect(fake.market.previewSource).toHaveBeenLastCalledWith({ input: "http://b.example/m", auth: "none" }));
  });

  it("shows a source's badges as text with a tooltip", () => {
    const fake = fakeMarketplace();
    sourcesView(fake, [source({ id: "corp", url: "http://git.corp.example/m", acknowledged: ["unencrypted", "internal-network"], badges: ["unencrypted", "internal-network"] })]);
    const badge = screen.getByTestId("git-marketplace:source:corp:badge:unencrypted");
    expect(badge).toHaveTextContent("암호화 안 됨(http)");
    expect(badge).toHaveAttribute("title", "네트워크 경로에 있는 누구나 이 소스가 보내는 내용을 읽고 제공하는 내용을 바꿀 수 있습니다. 이 소스의 업데이트는 자동으로 설치되지 않습니다.");
    expect(screen.getByTestId("git-marketplace:source:corp:badge:internal-network")).toHaveTextContent("사내망");
  });

  it("offers Allow… when a sync needs a confirmation, states the risk, then allows it", async () => {
    const fake = fakeMarketplace();
    fake.market.acknowledgeSource.mockResolvedValue({ ok: true, value: source({ id: "corp", acknowledged: ["internal-network"], badges: ["internal-network"] }) });
    const { onChanged } = sourcesView(fake, [
      source({ id: "corp", status: { state: "unreachable", code: "SOURCE_CONFIRMATION_REQUIRED", detail: { reason: "internal-network", host: "git.corp.example", address: "10.0.0.5" }, cached: true } }),
      source({ id: "team", status: { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "x.example" }, cached: false } }),
    ]);
    expect(screen.getByText("확인 필요 — 캐시 표시 중")).toBeInTheDocument();
    expect(screen.queryByTestId("git-marketplace:source:team:allow")).toBeNull();

    fireEvent.click(screen.getByTestId("git-marketplace:source:corp:allow"));
    expect(await screen.findByText("corp에 허용할까요?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("git-marketplace:sources:confirm"));
    await waitFor(() => expect(fake.market.acknowledgeSource).toHaveBeenCalledWith("corp", ["internal-network"]));
    expect(onChanged).toHaveBeenCalled();
  });

  it("asks the full credential warning before Allow… lets a stored token travel over http", async () => {
    const fake = fakeMarketplace();
    const held = source({
      id: "corp",
      url: "http://git.corp.example/m",
      auth: "token",
      tokenHost: "git.corp.example",
      acknowledged: ["unencrypted"],
      status: { state: "auth-required", detail: { reason: "token-unencrypted", host: "git.corp.example" }, cached: true },
    });
    fake.market.acknowledgeSource.mockResolvedValue({ ok: true, value: { ...held, acknowledged: ["unencrypted", "token-unencrypted"], status: { state: "up-to-date" } } });
    sourcesView(fake, [held]);

    fireEvent.click(screen.getByTestId("git-marketplace:source:corp:allow"));
    expect(await screen.findByText("git.corp.example 로그인 정보가 암호화되지 않은 채 전송되어 네트워크 경로에 있는 누구나 복사할 수 있습니다. 계속할까요?")).toBeInTheDocument();
    expect(fake.market.acknowledgeSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("git-marketplace:sources:confirm"));
    await waitFor(() => expect(fake.market.acknowledgeSource).toHaveBeenCalledWith("corp", ["token-unencrypted"]));
  });

  it("drops a check's answer that arrives after the address changed, so no warning or confirmation moves to the new address", async () => {
    const fake = fakeMarketplace();
    let answerFirst: (value: unknown) => void = () => {};
    fake.market.previewSource
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "second.example", address: null }] } })
      .mockResolvedValue({ ok: true, value: { ...marketplacePreview, url: "http://second.example/m", badges: ["unencrypted"] } });
    addDialog(fake);

    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://first.example/m" } });
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    await waitFor(() => expect(fake.market.previewSource).toHaveBeenCalledTimes(1));

    // Edited while the first check is still on its way, then the first answer arrives.
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://second.example/m" } });
    answerFirst({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "first.example", address: null }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("git-marketplace:add:warnings")).toBeNull();

    // The second address is asked about on its own, and Continue carries only its answer.
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    expect(await screen.findByTestId("git-marketplace:add:warnings")).toHaveTextContent("second.example");
    expect(fake.market.previewSource).toHaveBeenNthCalledWith(2, { input: "http://second.example/m", auth: "none" });
    fireEvent.click(screen.getByTestId("git-marketplace:add:warnings:continue"));
    await waitFor(() => expect(fake.market.previewSource).toHaveBeenNthCalledWith(3, { input: "http://second.example/m", auth: "none", acknowledge: ["unencrypted"] }));
  });

  it("starts a reopened dialog ready to check, though a check from before it closed is still on its way", async () => {
    const fake = fakeMarketplace();
    let answerFirst: (value: unknown) => void = () => {};
    fake.market.previewSource
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "deep.example", address: null }] } });
    const api = { gitMarketplace: fake.market, gitRuntime: fake.gitRuntime, updateSettings: vi.fn(async () => ({ ok: true })) } as unknown as Pick<AveApi, "gitMarketplace" | "gitRuntime" | "updateSettings">;
    const dialog = (open: boolean, initialInput = "") => <AddSourceDialog api={api} open={open} initialInput={initialInput} onClose={vi.fn()} onCommitted={vi.fn()} onAdded={vi.fn()} />;
    const { rerender } = render(dialog(true));

    await waitFor(() => expect(fake.gitRuntime.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("git-marketplace:add:url"), { target: { value: "http://first.example/m" } });
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());
    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeDisabled());

    // Closed while checking, then reopened from a link with another address.
    rerender(dialog(false));
    rerender(dialog(true, "http://deep.example/m"));
    expect(await screen.findByTestId("git-marketplace:add:url")).toHaveValue("http://deep.example/m");
    await waitFor(() => expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled());

    // The old answer arrives: it belongs to the closed dialog, so it shows nothing and changes nothing.
    answerFirst({ ok: true, value: { type: "confirm", warnings: [{ warning: "unencrypted", host: "first.example", address: null }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("git-marketplace:add:warnings")).toBeNull();
    expect(screen.getByTestId("git-marketplace:add:check")).toBeEnabled();

    fireEvent.click(screen.getByTestId("git-marketplace:add:check"));
    expect(await screen.findByTestId("git-marketplace:add:warnings")).toHaveTextContent("deep.example");
    expect(fake.market.previewSource).toHaveBeenNthCalledWith(2, { input: "http://deep.example/m", auth: "none" });
  });

  it("asks before Set token… on an http source sends sign-in unencrypted, then opens Set token…", async () => {
    const fake = fakeMarketplace();
    const http = source({ id: "corp", url: "http://git.corp.example/m", auth: "token", tokenHost: "git.corp.example", acknowledged: ["unencrypted"], badges: ["unencrypted"] });
    fake.market.acknowledgeSource.mockResolvedValue({ ok: true, value: { ...http, acknowledged: ["unencrypted", "token-unencrypted"] } });
    sourcesView(fake, [http]);

    fireEvent.click(screen.getByTestId("git-marketplace:source:corp:set-token"));
    expect(await screen.findByText(/git\.corp\.example 로그인 정보가 암호화되지 않은 채 전송되어/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("git-marketplace:sources:confirm"));
    await waitFor(() => expect(fake.market.acknowledgeSource).toHaveBeenCalledWith("corp", ["token-unencrypted"]));
    // Then the token dialog itself.
    expect(await screen.findByPlaceholderText("액세스 토큰 붙여넣기")).toBeInTheDocument();
  });
});
