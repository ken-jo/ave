import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { PluginConfigTab } from "../tabs/PluginConfigTab.js";
import { PluginConfigSchemaForm } from "../tabs/PluginConfigSchemaForm.js";
import { takeUpdateReview } from "../tabs/git-marketplace/update-review-request.js";

const mockCards = vi.fn(async () => [
  {
    id: "meeting",
    name: "Meeting",
    description: "Meeting plugin",
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded" as const,
  },
]);
const mockGet = vi.fn(async () => ({ ok: true as const, config: { apiKey: "abc" } }));
const mockSet = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "권한이 없는 프레임입니다.",
}));
const mockUninstall = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "제거 권한이 없습니다.",
}));
/**
 * The git marketplace a Doctor repair goes through. `bind(name)` makes the
 * catalog list that plugin as installed from `ave` at 1.0.0; without it the
 * plugin has no bound source.
 */
const market = {
  listCatalog: vi.fn(),
  listSources: vi.fn(),
  planInstall: vi.fn(),
  executeInstall: vi.fn(),
};

function bind(name: string): void {
  market.listCatalog.mockResolvedValue({
    ok: true as const,
    value: {
      entries: [{
        key: { sourceId: "ave", kind: "plugin", name },
        sourceOrigin: "official",
        sourceLabel: "Ave",
        displayName: name,
        description: "",
        keywords: [],
        state: { state: "installed", version: "1.0.0" },
        required: false,
        runsCode: true,
      }],
      counts: {},
      sourceCount: 1,
      syncedAt: null,
    },
  });
}

function expectRepairPlanned(name: string): void {
  expect(market.planInstall).toHaveBeenCalledWith({ sourceId: "ave", kind: "plugin", name, version: "1.0.0" });
  expect(market.executeInstall).toHaveBeenCalledWith("plan-1");
}

function setRendererApi(value: Record<string, unknown>): void {
  Object.defineProperty(window, "aveApi", {
    value,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  market.listCatalog.mockReset();
  market.listSources.mockReset();
  market.planInstall.mockReset();
  market.executeInstall.mockReset();
  market.listCatalog.mockResolvedValue({
    ok: true as const,
    value: { entries: [], counts: {}, sourceCount: 1, syncedAt: null },
  });
  market.listSources.mockResolvedValue({ ok: true as const, value: [] });
  market.planInstall.mockResolvedValue({ ok: true as const, value: { planId: "plan-1" } });
  market.executeInstall.mockResolvedValue({
    ok: true as const,
    value: {
      key: { sourceId: "ave", kind: "plugin", name: "meeting" },
      version: "1.0.0",
      action: { action: "replace", direction: "reinstall", from: "1.0.0" },
      rungs: [],
      connectionWarning: null,
    },
  });
  setRendererApi({ gitMarketplace: market });
  Object.defineProperty(window, "ave", {
    value: {
      plugins: {
        cards: mockCards,
      },
      pluginConfig: {
        get: mockGet,
        set: mockSet,
      },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "aveHost", {
    value: {
      takePluginMarketplaceApi: () => ({
        uninstallMarketplacePlugin: mockUninstall,
      }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "ave", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "aveHost", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "aveApi", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

describe("PluginConfigTab", () => {
  it("shows uninstall failure instead of success when IPC returns ok=false", async () => {
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "제거" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/로컬 데이터/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "제거" }));

    await waitFor(() => {
      expect(mockUninstall).toHaveBeenCalledWith("meeting");
      expect(screen.getByText("제거 권한이 없습니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("Meeting 제거 완료")).toBeNull();
  });

  it("shows save failure instead of success when IPC returns ok=false", async () => {
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledOnce();
      expect(screen.getByText("권한이 없는 프레임입니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("설정이 저장되었습니다.")).toBeNull();
  });

  it("surfaces contribution trust list failures instead of rendering empty success", async () => {
    const listPluginContributionTrust = vi.fn(async () => ({
      ok: false as const,
      error: "plugin-bundle-lifecycle-unavailable",
    }));
    setRendererApi({ listPluginContributionTrust });

    render(<PluginConfigTab />);

    expect(
      await screen.findByTestId("plugin-config:contribution-trust-error:meeting"),
    ).toHaveTextContent("번들 기능 신뢰 상태를 변경하지 못했습니다");
    expect(listPluginContributionTrust).toHaveBeenCalledWith("meeting");
  });

  it("surfaces thrown contribution trust IPC failures", async () => {
    setRendererApi({
      listPluginContributionTrust: vi.fn(async () => {
        throw new Error("ipc unavailable");
      }),
    });

    render(<PluginConfigTab />);

    expect(
      await screen.findByTestId("plugin-config:contribution-trust-error:meeting"),
    ).toHaveTextContent("번들 기능 신뢰 상태를 변경하지 못했습니다");
  });

  it("surfaces a missing required contribution trust preload method", async () => {
    setRendererApi({});

    render(<PluginConfigTab />);

    expect(
      await screen.findByTestId("plugin-config:contribution-trust-error:meeting"),
    ).toHaveTextContent("번들 기능 신뢰 상태를 변경하지 못했습니다");
  });

  it("runs Doctor for a failed plugin and refreshes the plugin card", async () => {
    const broken = {
      id: "agent-hub",
      name: "Agent Hub",
      description: "Agent orchestration",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-hydra"],
      loadStatus: "failed" as const,
    };
    const repaired = {
      ...broken,
      loadStatus: "loaded" as const,
    };
    const cards = vi.fn()
      .mockResolvedValueOnce([broken])
      .mockResolvedValueOnce([repaired]);
    bind("agent-hub");
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: {
        takePluginMarketplaceApi: () => ({
          uninstallMarketplacePlugin: mockUninstall,
        }),
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:agent-hub")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("plugin-config:doctor:agent-hub"));

    await waitFor(() => {
      expectRepairPlanned("agent-hub");
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Agent Hub 복구 완료")).toBeInTheDocument();
    });
  });

  it.each(["failed", "missing"] as const)(
    "does not report repair success when the refreshed card is %s",
    async (refreshedState) => {
      const broken = {
        id: "agent-hub",
        name: "Agent Hub",
        description: "Agent orchestration",
        sampleTools: [],
        capabilities: [],
        tools: [],
        installAliases: ["ave-plugin-hydra"],
        loadStatus: "failed" as const,
      };
      const cards = vi.fn()
        .mockResolvedValueOnce([broken])
        .mockResolvedValueOnce(refreshedState === "failed" ? [broken] : []);
      bind("agent-hub");
      Object.defineProperty(window, "ave", {
        value: {
          plugins: { cards },
          pluginConfig: { get: mockGet, set: mockSet },
        },
        writable: true,
        configurable: true,
      });

      render(<PluginConfigTab />);

      await waitFor(() => {
        expect(screen.getByTestId("plugin-config:doctor-panel:agent-hub")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("plugin-config:doctor:agent-hub"));

      await waitFor(() => {
        expectRepairPlanned("agent-hub");
        expect(cards).toHaveBeenCalledTimes(2);
        expect(
          screen.getByText("Agent Hub: 진단 완료 — 익스텐션을 아직 실행할 수 없습니다."),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("Agent Hub 복구 완료")).toBeNull();
      expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-warning");
    },
  );

  it("warns without planning an install when no source binds the failed plugin", async () => {
    const broken = {
      id: "agent-hub",
      name: "Agent Hub",
      description: "Agent orchestration",
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:agent-hub")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("plugin-config:doctor:agent-hub"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Agent Hub: 이 익스텐션에 연결된 마켓플레이스 소스가 없어 재설치할 수 없습니다. 제거하거나 설정 → 마켓플레이스에서 다시 설치하세요.",
        ),
      ).toBeInTheDocument();
    });
    expect(market.listCatalog).toHaveBeenCalledWith({ kind: "plugin", installedOnly: true });
    expect(market.planInstall).not.toHaveBeenCalled();
    expect(cards).toHaveBeenCalledOnce();
    expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-warning");
  });

  it("keeps a card refresh failure instead of overwriting it with repair success", async () => {
    const broken = {
      id: "agent-hub",
      name: "Agent Hub",
      description: "Agent orchestration",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-hydra"],
      loadStatus: "failed" as const,
    };
    const cards = vi.fn()
      .mockResolvedValueOnce([broken])
      .mockRejectedValueOnce(new Error("card refresh failed"));
    bind("agent-hub");
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:agent-hub")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("plugin-config:doctor:agent-hub"));

    await waitFor(() => {
      expectRepairPlanned("agent-hub");
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getByText("card refresh failed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Agent Hub 복구 완료")).toBeNull();
    expect(
      screen.queryByText("Agent Hub: 진단 완료 — 익스텐션을 아직 실행할 수 없습니다."),
    ).toBeNull();
    expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-destructive");
  });

  it("reports a non-reinstallable diagnosis as repaired only after the refreshed runtime is loaded", async () => {
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Meeting plugin",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "incompatible-app-version" as const,
      loadStatus: "failed" as const,
    };
    const repaired = {
      ...broken,
      installFailureKind: undefined,
      loadStatus: "loaded" as const,
      runtimeLoaded: true,
    };
    const cards = vi.fn()
      .mockResolvedValueOnce([broken])
      .mockResolvedValueOnce([repaired]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));

    await waitFor(() => {
      expect(market.planInstall).not.toHaveBeenCalled();
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Meeting 복구 완료")).toBeInTheDocument();
      expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-success");
    });
    expect(
      screen.queryByText("Meeting: 진단 완료 — 익스텐션을 아직 실행할 수 없습니다."),
    ).toBeNull();
  });

  it.each([
    {
      kind: "process-entry-requires-pinned-artifact" as const,
      title: "고정되지 않은 익스텐션 설치",
      detail: /이 사본은 거부되었습니다\. 릴리스를 고정한 마켓플레이스에서 설치하세요\./,
      remedy: /설치된 이 사본은 거부되었습니다\..*익스텐션을 제거한 뒤 릴리스를 고정한 마켓플레이스에서 설치하세요\. 같은 소스에서 다시 설치해도/,
    },
    {
      kind: "process-entry-unconfined" as const,
      title: "OS 도구 샌드박스가 필요한 익스텐션",
      detail: /OS 도구 샌드박스 안에서만 실행합니다/,
      remedy: /설정 > 권한 > OS 도구 샌드박스를 켠 뒤 익스텐션을 다시 시작하세요\. 다시 설치해도/,
    },
  ])("shows a localized Doctor diagnosis for a process-entry extension refused as $kind", async ({ kind, title, detail, remedy }) => {
    const broken = {
      id: "process-kit", name: "Process Kit", description: "Process extension",
      sampleTools: [], capabilities: [], tools: [], loadStatus: "failed" as const,
      installFailureKind: kind,
      installFailureMessage: "English refusal from main.",
    };
    Object.defineProperty(window, "ave", {
      value: { plugins: { cards: vi.fn().mockResolvedValue([broken]) }, pluginConfig: { get: mockGet, set: mockSet } },
      writable: true, configurable: true,
    });
    render(<PluginConfigTab />);
    await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByText(remedy)).toBeInTheDocument();
    expect(screen.queryByText("English refusal from main.")).toBeNull();
  });

  it("shows an unresolved warning without reinstalling when the app is too old", async () => {
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Marketplace install failed: plugin requires Ave >= 999.0.0, current 0.5.0",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "incompatible-app-version" as const,
      installFailureMessage: "plugin requires Ave >= 999.0.0, current 0.5.0",
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });
    expect(screen.getByText("앱 업데이트 필요")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));

    await waitFor(() => {
      // NOT reinstall-fixable → no reinstall attempt, diagnostic only.
      expect(market.planInstall).not.toHaveBeenCalled();
      expect(cards).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText("Meeting: 진단 완료 — 익스텐션을 아직 실행할 수 없습니다."),
      ).toBeInTheDocument();
      expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-warning");
    });
  });

  it("names a host protocol mismatch, and does not reinstall for it", async () => {
    const navigate = vi.fn();
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Plugin could not be loaded.",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "incompatible-host-protocol" as const,
      installFailureMessage: "plugin 'meeting' speaks host protocol 1; this app serves 2",
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    bind("meeting");
    market.listCatalog.mockResolvedValue({ ok: true, value: {
      entries: [{
        key: { sourceId: "ave", kind: "plugin", name: "meeting" },
        sourceOrigin: "official", sourceLabel: "Ave", displayName: "Meeting", description: "", keywords: [],
        state: { state: "update", from: "1.0.0", to: "2.0.0" }, required: false, runsCode: true,
      }], counts: {}, sourceCount: 1, syncedAt: null,
    } });
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab onNavigate={navigate} />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });
    // Its own diagnosis, not "update the app": a newer app may have dropped
    // the version rather than lacking it.
    expect(screen.getByText("다른 Ave 프로토콜용 익스텐션")).toBeInTheDocument();
    expect(screen.queryByText("앱 업데이트 필요")).toBeNull();
    expect(await screen.findByText(/마켓플레이스에서 2.0.0 버전 검토/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/마켓플레이스에서 2.0.0 버전 검토/));
    expect(navigate).toHaveBeenCalledWith("marketplace");
    expect(takeUpdateReview()).toEqual({ kind: "package", key: { sourceId: "ave", kind: "plugin", name: "meeting" } });

    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));

    await waitFor(() => {
      expect(market.planInstall).not.toHaveBeenCalled();
      expect(cards).toHaveBeenCalledTimes(2);
    });
  });

  it("shows the installed source repository when no compatible catalog version exists", async () => {
    bind("meeting");
    market.listSources.mockResolvedValue({ ok: true, value: [{
      id: "ave", label: "Plugin source", transport: "git", url: "https://example.invalid/plugins/meeting", path: null,
    }] });
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards: vi.fn().mockResolvedValue([{
          id: "meeting", name: "Meeting", description: "Needs update", sampleTools: [], capabilities: [], tools: [],
          loadStatus: "failed", installFailureKind: "incompatible-host-protocol",
        }]) },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);
    expect(await screen.findByText("https://example.invalid/plugins/meeting")).toBeInTheDocument();
    expect(screen.getByText(/Plugin source에서 호환 버전 확인/)).toBeInTheDocument();
  });

  it("shows a sandbox ceiling diagnosis with update and remove actions without reinstalling", async () => {
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Plugin filesystem grant is outside approved directories.",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "sandbox-grant-outside-ceiling" as const,
      installFailureMessage: "sandbox-grant-outside-ceiling",
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });
    expect(screen.getByText("파일 접근 범위 초과")).toBeInTheDocument();
    expect(screen.getByText(/요청 범위를 줄인 새 버전으로 업데이트하거나 제거하세요/)).toBeInTheDocument();
    expect(screen.getByTestId("plugin-config:doctor-remove:meeting")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));
    await waitFor(() => {
      expect(cards).toHaveBeenCalledTimes(2);
      expect(market.planInstall).not.toHaveBeenCalled();
      expect(screen.getByTestId("plugin-config:banner")).toHaveClass("text-warning");
    });
  });

  it("auto-reinstalls when a failed load is a reinstall-fixable manifest schema error", async () => {
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Plugin manifest could not be loaded.",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "manifest-validation-error" as const,
      installFailureMessage:
        "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
      loadStatus: "failed" as const,
    };
    const repaired = { ...broken, installFailureKind: undefined, installFailureMessage: undefined, loadStatus: "loaded" as const };
    const cards = vi.fn()
      .mockResolvedValueOnce([broken])
      .mockResolvedValueOnce([repaired]);
    bind("meeting");
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });
    expect(screen.getByText("익스텐션 manifest 검증 실패")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));

    await waitFor(() => {
      // Reinstall-fixable → Doctor puts the version on disk back from its source.
      expectRepairPlanned("meeting");
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Meeting 복구 완료")).toBeInTheDocument();
    });
  });

  it("falls back to the failure detail when auto-repair reinstall fails", async () => {
    const broken = {
      id: "meeting",
      name: "Meeting",
      description: "Plugin manifest could not be loaded.",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-meeting"],
      installFailureKind: "manifest-validation-error" as const,
      installFailureMessage: "[manifest:meeting] schema validation failed",
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    bind("meeting");
    market.executeInstall.mockResolvedValue({
      ok: false as const,
      code: "NO_INSTALLABLE_ARTIFACT",
      message: "release asset missing: meeting-1.0.0.zip",
    });
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:meeting")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("plugin-config:doctor:meeting"));

    await waitFor(() => {
      expectRepairPlanned("meeting");
      // Graceful fallback: the reinstall failure is surfaced; Remove stays available.
      expect(screen.getByText("release asset missing: meeting-1.0.0.zip")).toBeInTheDocument();
    });
    expect(screen.queryByText("Meeting 복구 완료")).toBeNull();
  });

  it("shows manifest validation field details in the Doctor panel", async () => {
    const broken = {
      id: "lyra-mail",
      name: "LYRA Mail",
      description: "Marketplace install failed",
      sampleTools: [],
      capabilities: [],
      tools: [],
      installAliases: ["ave-plugin-lyra-mail"],
      installFailureKind: "manifest-validation-error" as const,
      installFailureMessage:
        "[manifest:lyra-mail] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools' — the manifest contains a field that the current SDK schema no longer allows.",
      loadStatus: "failed" as const,
    };
    const cards = vi.fn().mockResolvedValue([broken]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:lyra-mail")).toBeInTheDocument();
    });
    expect(screen.getByText("익스텐션 manifest 검증 실패")).toBeInTheDocument();
    expect(screen.getByText("상세 오류")).toBeInTheDocument();
    expect(screen.getByText(/unknown property: 'startupTools'/)).toBeInTheDocument();
  });

  it("opens uninstall from the Doctor panel even for a managed failed plugin", async () => {
    const broken = {
      id: "agent-hub",
      name: "Agent Hub",
      description: "Agent orchestration",
      sampleTools: [],
      capabilities: [],
      tools: [],
      isManaged: true,
      installPolicy: "admin" as const,
      loadStatus: "failed" as const,
    };
    const cards = vi.fn(async () => [broken]);
    mockUninstall.mockResolvedValueOnce({ ok: true as const });
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-config:doctor-panel:agent-hub")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("plugin-config:doctor-remove:agent-hub"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "제거" }));

    await waitFor(() => {
      expect(mockUninstall).toHaveBeenCalledWith("agent-hub");
      expect(screen.getByText("Agent Hub 제거 완료")).toBeInTheDocument();
    });
  });

  it("refreshes the settings plugin list when an install result event arrives", async () => {
    const meeting = {
      id: "meeting",
      name: "Meeting",
      description: "Meeting plugin",
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "loaded" as const,
    };
    const agentHub = {
      id: "agent-hub",
      name: "Agent Hub",
      description: "Agent orchestration",
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "loaded" as const,
    };
    const cards = vi.fn()
      .mockResolvedValueOnce([meeting])
      .mockResolvedValueOnce([meeting, agentHub]);
    let installResultHandler: ((payload: { slug: string; success: boolean; error?: string }) => void) | null = null;
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveApi", {
      value: {
        onPluginInstallResult: vi.fn((handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
          installResultHandler = handler;
          return () => undefined;
        }),
        onPluginUninstallResult: vi.fn(() => () => undefined),
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(cards).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText("Meeting").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Agent Hub")).toBeNull();

    await act(async () => {
      installResultHandler?.({ slug: "agent-hub", success: true });
    });

    await waitFor(() => {
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText("Agent Hub").length).toBeGreaterThan(0);
    });
  });

  it("refreshes rendered configSchema fields when an install result returns an updated plugin card", async () => {
    const meetingV1 = {
      id: "meeting",
      name: "Meeting",
      description: "Meeting plugin",
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "loaded" as const,
      version: "1.0.0",
      configSchema: {
        properties: {
          endpoint: { type: "string", title: "Endpoint" },
        },
      },
    };
    const meetingV2 = {
      ...meetingV1,
      version: "2.0.0",
      configSchema: {
        properties: {
          baseUrl: { type: "string", title: "Base URL" },
        },
      },
    };
    const cards = vi.fn()
      .mockResolvedValueOnce([meetingV1])
      .mockResolvedValueOnce([meetingV2]);
    let installResultHandler: ((payload: { slug: string; success: boolean; error?: string }) => void) | null = null;
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveApi", {
      value: {
        onPluginInstallResult: vi.fn((handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
          installResultHandler = handler;
          return () => undefined;
        }),
        onPluginUninstallResult: vi.fn(() => () => undefined),
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(cards).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Endpoint")).toBeInTheDocument();
    });
    expect(screen.queryByText("Base URL")).toBeNull();

    await act(async () => {
      installResultHandler?.({ slug: "meeting", success: true });
    });

    await waitFor(() => {
      expect(cards).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Base URL")).toBeInTheDocument();
    });
    expect(screen.queryByText("Endpoint")).toBeNull();
  });

  it("renders preparation progress details for a selected preparing plugin", async () => {
    const cards = vi.fn(async () => [
      {
        id: "agent-hub",
        name: "Agent Hub",
        description: "Agent orchestration",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "preparing" as const,
        preparationStatus: {
          phase: "installing-deps",
          message: "의존성 설치 중 (최초 1회)...",
          progressPct: 40,
          updatedAt: "2026-05-21T00:00:00.000Z",
        },
      },
    ]);
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByText("연관 라이브러리 다운로드/설치")).toBeInTheDocument();
    });
    expect(screen.getAllByText("의존성 설치 중 (최초 1회)...").length).toBeGreaterThan(0);
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("준비가 끝나면 익스텐션이 자동으로 로드됩니다.")).toBeInTheDocument();
  });

});

describe("PluginConfigTab — §9.2 Track B configSchema rendering", () => {
  it("renders the typed form when manifest declares configSchema and routes secrets through setSecret", async () => {
    // Override the cards mock with a plugin that declares a typed schema
    // including one secret key.
    const mockCardsTyped = vi.fn(async () => [
      {
        id: "with-schema",
        name: "Schema Plugin",
        description: "Has configSchema",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        configSchema: {
          properties: {
            endpoint: { type: "string", title: "Endpoint", default: "https://api" },
            apiKey: { type: "string", format: "secret", title: "API Key" },
          },
        },
      },
    ]);
    const mockGetTyped = vi.fn(async () => ({ ok: true as const, config: {} }));
    const mockSetTyped = vi.fn(async () => ({ ok: true as const, config: { endpoint: "https://api" } }));
    const mockSetSecret = vi.fn(async () => ({ ok: true as const }));

    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards: mockCardsTyped },
        pluginConfig: {
          get: mockGetTyped,
          set: mockSetTyped,
          getSchema: vi.fn(),
          setSecret: mockSetSecret,
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    // The schema-driven form renders fields with deriveLabel("Endpoint"/"API Key").
    await waitFor(() => {
      expect(screen.getByText("Endpoint")).toBeInTheDocument();
      expect(screen.getByText("API Key")).toBeInTheDocument();
    });

    // Legacy raw-KV editor must NOT render — the "+ 추가" button is the marker.
    expect(screen.queryByText("+ 추가")).toBeNull();

    // Type a secret value, click its dedicated 저장 button. setSecret MUST
    // be called (NOT pluginConfig.set with the cleartext value).
    const secretInputs = document.querySelectorAll('input[type="password"]');
    expect(secretInputs.length).toBe(1);
    fireEvent.change(secretInputs[0], { target: { value: "sk-LIVE" } });
    const saveButtons = screen.getAllByRole("button", { name: /저장/ });
    // The first 저장 button belongs to the secret row; the form-level
    // 저장 lives further down. We click the secret one explicitly via test id.
    const secretSaveBtn = document.querySelector(
      '[data-testid="pcfg:with-schema:apiKey:save"]',
    ) as HTMLButtonElement;
    expect(secretSaveBtn).not.toBeNull();
    fireEvent.click(secretSaveBtn);
    await waitFor(() => {
      expect(mockSetSecret).toHaveBeenCalledWith("with-schema", "apiKey", "sk-LIVE");
      expect(mockSetTyped).not.toHaveBeenCalledWith(
        "with-schema",
        expect.objectContaining({ apiKey: "sk-LIVE" }),
      );
    });

    // Sanity: form-level 저장 button still exists for cleartext fields.
    expect(saveButtons.length).toBeGreaterThan(0);
  });

  it("falls back to the legacy raw key/value editor when manifest has NO configSchema", async () => {
    // Use the original mock from the outer `beforeEach`. Re-install here
    // explicitly because this describe block does not share the parent's
    // hooks.
    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards: mockCards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    // Legacy `+ 추가` button proves the raw KV editor is used.
    await waitFor(() => {
      expect(screen.getByText("+ 추가")).toBeInTheDocument();
    });
  });
});

describe("PluginConfigTab — auth UI", () => {
  it("keeps auth UI available for inactive loaded plugins while hiding model tools", async () => {
    const cards = vi.fn(async () => [
      {
        id: "inactive-auth-plugin",
        name: "Inactive Auth Plugin",
        description: "Inactive but runtime-loaded",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "disabled" as const,
        active: false,
        runtimeLoaded: true,
        auth: {
          label: "Token auth",
          statusTool: "inactive_status",
          loginTool: "inactive_login",
        },
      },
    ]);
    const callPluginMethod = vi.fn(async (tool: string) =>
      tool === "inactive_status" ? { authenticated: false } : { ok: true },
    );

    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: {
          get: vi.fn(async () => ({ ok: true as const, config: {} })),
          set: vi.fn(async () => ({ ok: true as const, config: {} })),
          listSecretKeys: vi.fn(async () => ({ ok: true as const, keys: [] })),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveApi", {
      value: {
        callPluginMethod,
        onPluginEvent: vi.fn(() => () => undefined),
        onPluginEnabledChanged: vi.fn(() => () => undefined),
        setPluginEnabled: vi.fn(async () => ({ ok: true as const })),
        listPluginUiExtensions: vi.fn(async () => []),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    const loginButton = await screen.findByTestId("plugin-auth-login-inactive-auth-plugin");
    expect(loginButton).toHaveTextContent("로그인");
    expect(screen.getByTestId("plugin-config:enabled-toggle:inactive-auth-plugin")).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("plugin-config:tools-hidden-note:inactive-auth-plugin")).toBeInTheDocument();
    await waitFor(() => {
      expect(callPluginMethod).toHaveBeenCalledWith("inactive_status");
    });
  });

  it("does not render an active-state switch for failed plugins", async () => {
    const cards = vi.fn(async () => [
      {
        id: "failed-plugin",
        name: "Failed Plugin",
        description: "Failed runtime",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "failed" as const,
        active: false,
        runtimeLoaded: false,
      },
    ]);

    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: {
          get: vi.fn(async () => ({ ok: true as const, config: {} })),
          set: vi.fn(async () => ({ ok: true as const, config: {} })),
          listSecretKeys: vi.fn(async () => ({ ok: true as const, keys: [] })),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveApi", {
      value: {
        onPluginEvent: vi.fn(() => () => undefined),
        onPluginEnabledChanged: vi.fn(() => () => undefined),
        listPluginUiExtensions: vi.fn(async () => []),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    expect(await screen.findByTestId("plugin-config:detail-status:failed-plugin")).toHaveTextContent("실패");
    expect(screen.queryByTestId("plugin-config:enabled-toggle:failed-plugin")).toBeNull();
    expect(screen.getByText("실행 불가")).toBeInTheDocument();
  });

  it("uses loginTool even when a plugin also declares detached UI views", async () => {
    const cards = vi.fn(async () => [
      {
        id: "token-plugin",
        name: "Token Plugin",
        description: "Uses plugin UI auth",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        auth: {
          label: "Token auth",
          statusTool: "token_status",
          loginTool: "token_login",
          logoutTool: "token_logout",
        },
      },
    ]);
    const callPluginMethod = vi.fn(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    Object.defineProperty(window, "ave", {
      value: {
        plugins: { cards },
        pluginConfig: {
          get: vi.fn(async () => ({ ok: true as const, config: {} })),
          set: vi.fn(async () => ({ ok: true as const, config: {} })),
          listSecretKeys: vi.fn(async () => ({ ok: true as const, keys: [] })),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveApi", {
      value: {
        callPluginMethod,
        onPluginEvent: vi.fn(() => () => undefined),
        listPluginUiExtensions: vi.fn(async () => []),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "aveHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    const loginButton = await screen.findByTestId("plugin-auth-login-token-plugin");
    expect(loginButton).toHaveTextContent("로그인");
    fireEvent.click(loginButton);

    await waitFor(() => {
      expect(callPluginMethod).toHaveBeenCalledWith("token_login", undefined, {
        userAction: true,
      });
    });
  });
});

describe("PluginConfigSchemaForm — values prop sync", () => {
  it("re-syncs draft when values prop changes after mount (regression: outlook.com persistence)", async () => {
    // 회귀 가드. PluginConfigTab 의 savedConfig fetch 가 async 라
    // PluginConfigSchemaForm 은 처음에 빈 values 로 마운트된다. 이후
    // savedConfig 가 도착해 values 가 바뀌어도 useState lazy-init 이라
    // draft 가 그대로 비어 있어 사용자에게는 "저장한 값이 사라진" 것처럼
    // 보였다. useEffect([values]) 로 동기화해서 막는다.
    const schema = {
      properties: {
        meetingDetectorAllowedSenderDomains: {
          type: "array" as const,
          title: "허용 도메인",
          items: { type: "string" as const },
        },
      },
    };

    const { rerender } = render(
      <PluginConfigSchemaForm
        pluginId="vega-helper"
        schema={schema}
        values={{}}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );
    const input = document.querySelector(
      '[id="pcfg:vega-helper:meetingDetectorAllowedSenderDomains"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");

    rerender(
      <PluginConfigSchemaForm
        pluginId="vega-helper"
        schema={schema}
        values={{ meetingDetectorAllowedSenderDomains: ["outlook.com"] }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );

    await waitFor(() => {
      expect(input.value).toBe("outlook.com");
    });
  });

  it("does not preserve schema defaults as dirty values when saved values arrive asynchronously", async () => {
    const schema = {
      properties: {
        apiKeySource: {
          type: "string" as const,
          title: "STT key source",
          enum: ["host", "plugin"],
          default: "host",
        },
      },
    };

    const { rerender } = render(
      <PluginConfigSchemaForm
        pluginId="meeting"
        schema={schema}
        values={{ apiKeySource: "host" }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );
    const select = document.querySelector(
      '[id="pcfg:meeting:apiKeySource"]',
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("host");

    rerender(
      <PluginConfigSchemaForm
        pluginId="meeting"
        schema={schema}
        values={{ apiKeySource: "plugin" }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );

    await waitFor(() => {
      expect(select.value).toBe("plugin");
    });
  });

  it("still preserves explicit unsaved edits while applying saved updates to untouched fields", async () => {
    const schema = {
      properties: {
        endpoint: {
          type: "string" as const,
          title: "Endpoint",
        },
        region: {
          type: "string" as const,
          title: "Region",
        },
      },
    };

    const { rerender } = render(
      <PluginConfigSchemaForm
        pluginId="sync-plugin"
        schema={schema}
        values={{ endpoint: "https://old.example", region: "eastus" }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );
    const endpoint = document.querySelector(
      '[id="pcfg:sync-plugin:endpoint"]',
    ) as HTMLInputElement;
    const region = document.querySelector(
      '[id="pcfg:sync-plugin:region"]',
    ) as HTMLInputElement;
    expect(endpoint).not.toBeNull();
    expect(region).not.toBeNull();

    fireEvent.change(endpoint, { target: { value: "https://draft.example" } });

    rerender(
      <PluginConfigSchemaForm
        pluginId="sync-plugin"
        schema={schema}
        values={{ endpoint: "https://old.example", region: "westus" }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );

    await waitFor(() => {
      expect(endpoint.value).toBe("https://draft.example");
      expect(region.value).toBe("westus");
    });
  });
});

it("opens a requested plugin under the existing anchor and updates its unseen badge", async () => {
  const cards = [
    { id: "other", name: "Other", description: "Other plugin", sampleTools: [], capabilities: [], tools: [], loadStatus: "loaded" as const },
    { id: "meeting", name: "Meeting", description: "Meeting plugin", sampleTools: [], capabilities: [], tools: [], loadStatus: "loaded" as const },
  ];
  mockCards.mockResolvedValueOnce(cards);
  const row: import("../../../shared/alerts-types.js").AlertKindRow = {
    kindKey: "meeting:summary", pluginId: "meeting", pluginLabel: "Meeting", reasoning: "Review completed meetings.",
    declaration: { id: "summary", label: { en: "Meeting summary" }, defaultEnabled: false, visibility: "user-visible", summary: { en: "Review meeting" }, prompt: { en: "Review meeting" } },
    choice: { enabled: false, osNotification: false, visibility: "user-visible", seenByUser: false }, blockedByPredecessor: null, predecessor: null,
  };
  let changed = () => {};
  setRendererApi({
    gitMarketplace: market,
    getSettings: async () => ({ alerts: { osNotificationsEnabled: false } }),
    alerts: { listKinds: async () => [{ ...row, choice: { ...row.choice } }], onKindsChanged: (callback: () => void) => { changed = callback; return () => {}; } },
  });
  render(<PluginConfigTab initialPluginId="meeting" />);
  const section = await screen.findByTestId("plugin-alerts:meeting");
  expect(section.closest("[data-settings-section]")).toHaveAttribute("data-settings-section", "plugin-config-installed");
  expect(screen.getByTestId("alert-unseen:meeting")).toHaveTextContent("1");
  expect(screen.queryByTestId("alert-unseen:other")).toBeNull();
  row.choice.seenByUser = true;
  act(changed);
  await waitFor(() => expect(screen.queryByTestId("alert-unseen:meeting")).toBeNull());
});
