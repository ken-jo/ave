import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeMockAveApi } from "./mock-ave-api.js";
import { t } from "../../src/i18n/runtime.js";
import type { UsageSummaryShape } from "../../src/ui/renderer/types.js";
import { computeUsageSummary } from "../../src/engine/usage-stats.js";
import { shortSessionId } from "../../src/shared/session-lookup.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const MOCK_SUMMARY = {
  today: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 20, totalTokens: 1620, cost: 0.01 },
  thisWeek: { inputTokens: 7000, outputTokens: 3500, cacheReadTokens: 700, cacheWriteTokens: 140, totalTokens: 11340, cost: 0.07 },
  thisMonth: { inputTokens: 30000, outputTokens: 15000, cacheReadTokens: 3000, cacheWriteTokens: 600, totalTokens: 48600, cost: 0.30 },
  perVendor: [
    { vendor: "claude", model: "*", inputTokens: 30000, outputTokens: 15000, cacheReadTokens: 3000, cacheWriteTokens: 600, totalTokens: 48600, cost: 0.30, unknownCostTurns: 0 },
  ],
  perModel: [
    { vendor: "claude", model: "claude-sonnet-4-6", inputTokens: 30000, outputTokens: 15000, cacheReadTokens: 3000, cacheWriteTokens: 600, totalTokens: 48600, cost: 0.30, unknownCostTurns: 0 },
  ],
  trend: [
    { date: "2026-04-17", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 20, totalTokens: 1620, cost: 0.01, unknownCostTurns: 0 },
    { date: "2026-04-18", inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 40, totalTokens: 3240, cost: 0.02, unknownCostTurns: 0 },
  ],
  topConversations: [
    { sessionId: "sess-abc123", turns: 5, firstInput: "안녕", inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 1000, cacheWriteTokens: 200, totalTokens: 16200, cost: 0.10 },
    { sessionId: "sess-def456", turns: 2, firstInput: "질문", inputTokens: 5000, outputTokens: 2500, cacheReadTokens: 500, cacheWriteTokens: 100, totalTokens: 8100, cost: 0.05 },
  ],
  topConversationsByTokens: [],
  generatedAt: new Date().toISOString(),
};

const MOCK_SUBSCRIPTION: NonNullable<UsageSummaryShape["subscription"]> = {
  today: { inputTokens: 140, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 209, segments: 2 },
  thisWeek: { inputTokens: 140, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 209, segments: 2 },
  thisMonth: { inputTokens: 140, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 209, segments: 2 },
  perRuntime: [
    { provider: "codex", model: "*", inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 164, segments: 1 },
    { provider: "kimi-code", model: "*", inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, totalTokens: 45, segments: 1 },
  ],
  perModel: [
    { provider: "codex", model: "gpt-5.4", inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 164, segments: 1 },
    { provider: "kimi-code", model: "default", inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, totalTokens: 45, segments: 1 },
  ],
  trend: [
    { date: "2026-04-18", inputTokens: 140, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 209, segments: 2 },
  ],
  sources: {
    "provider-reported": { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningOutputTokens: 10, totalTokens: 164, segments: 1 },
    "local-estimate": { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, totalTokens: 45, segments: 1 },
  },
};

type DashboardSummary = UsageSummaryShape;

function usageDashboardApi(overrides: Partial<DashboardSummary> = {}) {
  const summary: DashboardSummary = { ...MOCK_SUMMARY, ...overrides };
  const { api } = makeMockAveApi();
  api.getUsageRange = vi.fn(async () => summary);
  api.exportUsageCsv = vi.fn(async () => ({ ok: true, filePath: "/tmp/ave-usage.csv" }));
  return api;
}

async function renderDashboard(api = usageDashboardApi(), onNavigate: (tab: any) => void = () => {}) {
  const { UsageDashboard } = await import("../../src/ui/renderer/components/UsageDashboard.js");
  const result = render(<UsageDashboard api={api as any} onNavigate={onNavigate} />);
  return { ...result, api };
}

// Usage owns workspace statistics and marketplace status through the shared stats hook.
function workspaceStatsApi(overrides: Record<string, unknown> = {}) {
  const { api } = makeMockAveApi({
    pluginUiExtensions: [{ pluginId: "a" }, { pluginId: "b" }],
    pluginCards: [
      { id: "a", name: "A", description: "", sampleTools: [], capabilities: [], tools: ["t1", "t2"] },
      { id: "b", name: "B", description: "", sampleTools: [], capabilities: [], tools: ["t3"] },
    ],
    agentProfiles: { agents: [{ name: "agent1" }, { name: "agent2" }] },
    skills: { skills: [{ name: "skill1" }] },
    personaPrompts: [{ id: "persona1", name: "Persona", systemPromptAdd: "Act as persona." }],
    ...(overrides as Record<string, unknown>),
  });
  api.getUsageRange = vi.fn(async () => MOCK_SUMMARY);
  api.exportUsageCsv = vi.fn(async () => ({ ok: true, filePath: "/tmp/ave-usage.csv" }));
  return api;
}

describe("UsageDashboard — workspace stats section", () => {
  it("renders all 5 workspace stat cards with their counts", async () => {
    const { findByTestId } = await renderDashboard(workspaceStatsApi() as any);
    const plugin = await findByTestId("general-tab-card-plugin");
    const tool = await findByTestId("general-tab-card-tool");
    const agent = await findByTestId("general-tab-card-agent");
    const skill = await findByTestId("general-tab-card-skill");
    const role = await findByTestId("general-tab-card-role");
    await waitFor(() => {
      expect(plugin.textContent).toContain("2");
      expect(tool.textContent).toContain("3");
      expect(agent.textContent).toContain("2");
      expect(skill.textContent).toContain("1");
      expect(role.textContent).toContain("1");
    });
  });

  it("reads the marketplace as synced when an enabled source is up to date", async () => {
    const api = workspaceStatsApi({
      marketplaceSources: [
        { id: "ave", enabled: true, status: { state: "up-to-date" } },
        { id: "acme", enabled: false, status: { state: "never-synced" } },
      ],
    });
    const { findByTestId } = await renderDashboard(api as any);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("동기화됨"));
  });

  it("reads the marketplace as not synced when no enabled source is up to date", async () => {
    const api = workspaceStatsApi({
      marketplaceSources: [{ id: "ave", enabled: true, status: { state: "unreachable", code: "SOURCE_UNREACHABLE", cached: true } }],
    });
    const { findByTestId } = await renderDashboard(api as any);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("동기화 안 됨"));
  });

  it("renders 미연결 when no marketplace source is enabled", async () => {
    const api = workspaceStatsApi({ marketplaceSources: [{ id: "acme", enabled: false, status: { state: "up-to-date" } }] });
    const { findByTestId } = await renderDashboard(api as any);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("미연결"));
  });

  it("calls onNavigate(plugin-config) when the 플러그인 card is clicked", async () => {
    const onNavigate = vi.fn();
    const { findByTestId } = await renderDashboard(workspaceStatsApi() as any, onNavigate);
    const plugin = await findByTestId("general-tab-card-plugin");
    fireEvent.click(plugin);
    expect(onNavigate).toHaveBeenCalledWith("plugin-config");
  });
});

describe("UsageDashboard", () => {
  it("ranks sessions by priced spend and counts unpriced requests outside the top five", async () => {
    const timestamp = new Date().toISOString();
    const summary = computeUsageSummary([
      ...Array.from({ length: 5 }, (_, index) => ({
        timestamp, sessionId: `priced-${index}`, type: "turn", route: "openai/gpt-5.4",
        tokenUsage: { inputTokens: 1_000, outputTokens: 0 },
        modelSettings: { pricing: { source: "user" as const, rates: { inputPer1M: index + 1, outputPer1M: 0 } } },
      })),
      {
        timestamp, sessionId: "unpriced-outside-list", type: "turn", route: "openai/gpt-5.4",
        tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 },
        modelSettings: { pricing: { source: "unknown" as const, reason: "endpoint-price-unavailable" as const } },
      },
    ], new Date());
    expect(summary.topConversations.map((row) => row.sessionId))
      .toEqual(["priced-4", "priced-3", "priced-2", "priced-1", "priced-0"]);
    await renderDashboard(usageDashboardApi(summary));
    expect(await screen.findByText("가격이 확인된 지출 기준 상위 세션 5개")).toBeVisible();
    expect(await screen.findByText("이 순위에서 가격 미정 요청 1건이 제외되었습니다.")).toBeVisible();
  });

  it("uses only priced activity to qualify and break ties for zero-spend sessions", () => {
    const now = new Date();
    const request = (sessionId: string, inputTokens: number, priced: boolean) => ({
      timestamp: now.toISOString(), sessionId, type: "turn" as const, route: "openai/gpt-5.4",
      tokenUsage: { inputTokens, outputTokens: 0 },
      ...(priced ? { modelSettings: { pricing: { source: "user" as const, rates: { inputPer1M: 0, outputPer1M: 0 } } } } : {}),
    });
    const summary = computeUsageSummary([
      request("mixed", 10, true),
      request("mixed", 1_000_000, false),
      ...Array.from({ length: 5 }, (_, index) => request(`unpriced-${index}`, 100_000, false)),
      request("priced", 20, true),
    ], now);
    expect(summary.topConversations.map((row) => row.sessionId)).toEqual(["priced", "mixed"]);
    expect(summary.topConversations[1]).toMatchObject({ totalTokens: 10, turns: 1, cost: 0 });
    expect(summary.topConversationsByTokens[0]).toMatchObject({ sessionId: "mixed", totalTokens: 1_000_010, turns: 2 });
    expect(summary.today.unknownCostTurns).toBe(6);
  });

  it.each([false, true])("shows unknown costs for an incomplete audit with readable pricing %s", async (readable) => {
    const now = new Date();
    const summary = computeUsageSummary(readable ? [{
      timestamp: now.toISOString(), sessionId: "readable", type: "turn", route: "openai/gpt-5.4",
      tokenUsage: { inputTokens: 1_000, outputTokens: 0 },
      modelSettings: { pricing: { source: "user", rates: { inputPer1M: 3, outputPer1M: 0 } } },
    }] : [], now);
    const api = usageDashboardApi({ ...summary, auditIncomplete: true });
    await renderDashboard(api);
    for (const title of [t("usageDashboard.today"), t("usageDashboard.monthlyProjection")]) {
      const heading = await screen.findByText(title);
      const card = heading.parentElement?.parentElement;
      expect(card).toHaveTextContent(t("be_costEstimator.costUnknown"));
      expect(card).not.toHaveTextContent("$");
    }
    if (readable) {
      fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.exportCsv") }));
      await waitFor(() => expect(api.exportUsageCsv).toHaveBeenCalledWith([
        expect.objectContaining({ cost: "", totalTokens: 1_000, auditIncomplete: 1 }),
        expect.objectContaining({ date: "range-total", cost: "", totalTokens: 1_000, auditIncomplete: 1 }),
      ]));
    }
  });

  it("shows an unknown spending projection when a serving route has no endpoint price", async () => {
    const [firstDay, secondDay] = MOCK_SUMMARY.trend;
    if (!firstDay || !secondDay) throw new Error("Expected a two-day usage fixture");
    const point = { ...firstDay, cost: 0, unknownCostTurns: 1, endpointPriceUnavailableTurns: 1 };
    const api = usageDashboardApi({ today: point, trend: [point, secondDay] });
    await renderDashboard(api);
    const heading = await screen.findByText(t("usageDashboard.monthlyProjection"));
    const card = heading.parentElement?.parentElement;
    expect(card).toHaveTextContent("이 경로의 엔드포인트가 사용 가능한 가격을 제공하지 않았습니다.");
    expect(card).not.toHaveTextContent("$");
    fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.exportCsv") }));
    await waitFor(() => expect(api.exportUsageCsv).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ cost: "", unknownCostTurns: 1, endpointPriceUnavailableTurns: 1 }),
    ])));
  });

  it("builds preset ranges from the host's calendar day, not a fixed zone's", async () => {
    const { presetToDates } = await import("../../src/ui/renderer/components/UsageDashboard.js");
    // Derive date expectations from the host calendar; runtime timezone reassignment does not affect this environment.
    const instant = new Date("2026-07-03T16:00:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const hostToday =
      `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
    const sevenDaysEarlier = new Date(
      instant.getFullYear(), instant.getMonth(), instant.getDate() - 6,
    );
    const hostFrom =
      `${sevenDaysEarlier.getFullYear()}-${pad(sevenDaysEarlier.getMonth() + 1)}`
      + `-${pad(sevenDaysEarlier.getDate())}`;

    expect(presetToDates("7d", instant)).toEqual({
      dateFrom: hostFrom,
      dateTo: hostToday,
    });
  });

  it("renders without crashing", async () => {
    const { container } = await renderDashboard();
    await waitFor(() => expect(container).toBeTruthy());
  });

  it("calls getUsageRange on mount", async () => {
    const api = usageDashboardApi();
    await renderDashboard(api);
    await waitFor(() => expect(api.getUsageRange).toHaveBeenCalledTimes(1));
  });

  it("renders today/week/month cards", async () => {
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("오늘")).toBeTruthy();
      expect(screen.getByText("이번 주")).toBeTruthy();
      expect(screen.getByText("이번 달")).toBeTruthy();
    });
  });

  it("renders vendor breakdown with claude row", async () => {
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("claude")).toBeTruthy();
      expect(screen.getAllByText(new RegExp(t("usageDashboard.colCache"))).length).toBeGreaterThan(0);
    });
  });

  it("renders model breakdown with concrete model rows", async () => {
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("모델별 사용량")).toBeTruthy();
      expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    });
  });

  it("renders session Top 5 table", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByText(shortSessionId("sess-abc123"))).toBeTruthy());
  });

  it("renders monthly projection line", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByText(/이 속도로면 월 약/)).toBeTruthy());
  });

  it("renders subscription telemetry in a separate token-only section", async () => {
    const api = usageDashboardApi({ subscription: MOCK_SUBSCRIPTION });
    await renderDashboard(api);

    const section = await screen.findByTestId("subscription-usage-dashboard");
    expect(section.textContent).toContain("구독 토큰 사용량");
    expect(section.textContent).toContain("구독 사용량은 토큰만 표시하며 호출별 가격은 산정하지 않습니다.");
    expect(section.textContent).toContain("공급자 보고");
    expect(section.textContent).toContain("로컬 추정");
    expect(section.textContent).toContain("codex");
    expect(section.textContent).toContain("gpt-5.4");
    expect(section.textContent).not.toContain("$");
  });

  it("marks monthly projection as unknown when trend contains unknown-cost turns", async () => {
    const api = usageDashboardApi({
      trend: [
        { date: "2026-04-17", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, cost: 0, unknownCostTurns: 1 },
        { date: "2026-04-18", inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3000, cost: 0, unknownCostTurns: 2 },
      ],
    });
    const { container } = await renderDashboard(api);
    await waitFor(() => {
      expect(container.textContent).toContain("월 약 비용 미정");
      expect(container.textContent).toContain("일평균 비용 미정 × 30일");
    });
  });

  it("renders preset buttons", async () => {
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 7 }) })).toBeTruthy();
      expect(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 30 }) })).toBeTruthy();
      expect(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 90 }) })).toBeTruthy();
      expect(screen.getByRole("button", { name: "전체" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "직접" })).toBeTruthy();
    });
  });

  it("calls getUsageRange again when preset changes", async () => {
    const api = usageDashboardApi();
    await renderDashboard(api);
    await waitFor(() => expect(api.getUsageRange).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 7 }) }));
    await waitFor(() => expect(api.getUsageRange).toHaveBeenCalledTimes(2));
  });

  it("shows custom date inputs when 직접 selected", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByRole("button", { name: "직접" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "직접" }));
    await waitFor(() => {
      expect(screen.getByLabelText("시작일")).toBeTruthy();
      expect(screen.getByLabelText("종료일")).toBeTruthy();
    });
  });

  it("renders CSV export button", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByRole("button", { name: /CSV 내보내기/ })).toBeTruthy());
  });

  it("calls exportUsageCsv when CSV button clicked", async () => {
    const api = usageDashboardApi();
    await renderDashboard(api);
    await waitFor(() => expect(screen.getByRole("button", { name: /CSV 내보내기/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /CSV 내보내기/ }));
    await waitFor(() => {
      expect(api.exportUsageCsv).toHaveBeenCalledTimes(1);
      const rows = api.exportUsageCsv.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty("date");
      expect(rows[0]).toHaveProperty("cost");
      expect(rows[0]).toHaveProperty("cacheReadTokens", 100);
      expect(rows[0]).toHaveProperty("cacheWriteTokens", 20);
      expect(rows[0]).toHaveProperty("unknownCostTurns", 0);
    });
  });

  it("exports unknown-cost turn counts in CSV rows", async () => {
    const api = usageDashboardApi({
      trend: [
        { date: "2026-04-17", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 10, totalTokens: 1610, cost: 0, unknownCostTurns: 2 },
      ],
      perModel: [
        { vendor: "openai", model: "gpt-4o", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 1500, cost: 0, unknownCostTurns: 3 },
      ],
    });
    await renderDashboard(api);
    await waitFor(() => expect(screen.getByRole("button", { name: /CSV 내보내기/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /CSV 내보내기/ }));
    await waitFor(() => {
      expect(api.exportUsageCsv).toHaveBeenCalledTimes(1);
      const rows = api.exportUsageCsv.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows[0]).toHaveProperty("unknownCostTurns", 2);
      expect(rows[0]).toHaveProperty("cacheReadTokens", 100);
      expect(rows[0]).toHaveProperty("cacheWriteTokens", 10);
      expect(rows.find((row) => row.date === "range-total")).toHaveProperty("unknownCostTurns", 3);
    });
  });

  it("disables CSV button when no trend data", async () => {
    const api = usageDashboardApi({ trend: [], topConversations: [] });
    await renderDashboard(api);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /CSV 내보내기/ })).toBeDisabled();
    });
  });

  it("shows 데이터 없음 for empty vendor table", async () => {
    const api = usageDashboardApi({ perVendor: [] });
    await renderDashboard(api);
    await waitFor(() => {
      expect(screen.getAllByText("데이터 없음").length).toBeGreaterThan(0);
    });
  });
});

describe("UsageDashboard request state", () => {
  it("keeps the period picker after a failed reload, clears old data and can retry", async () => {
    const api = usageDashboardApi();
    await renderDashboard(api);
    await screen.findByText("claude-sonnet-4-6");
    api.getUsageRange.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 7 }) }));
    await screen.findByRole("alert");
    expect(screen.queryByText("claude-sonnet-4-6")).toBeNull();
    expect(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 30 }) })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.retry") }));
    await screen.findByText("claude-sonnet-4-6");
    expect(api.getUsageRange).toHaveBeenCalledTimes(3);
  });

  it("displays only the newest period when requests finish out of order", async () => {
    let finishOld: (summary: DashboardSummary) => void = () => { throw new Error("not requested"); };
    const api = usageDashboardApi();
    api.getUsageRange.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await renderDashboard(api);
    expect(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 7 }) })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: t("usageDashboard.presetDays", { count: 7 }) }));
    await screen.findByText("claude-sonnet-4-6");
    const { act } = await import("@testing-library/react");
    await act(async () => finishOld({ ...MOCK_SUMMARY, perModel: [{ ...MOCK_SUMMARY.perModel[0], model: "older-period" }] }));
    expect(screen.queryByText("older-period")).toBeNull();
    expect(screen.getByText("claude-sonnet-4-6")).toBeVisible();
  });

  it("shows an export error for both rejected and unsuccessful exports", async () => {
    const api = usageDashboardApi();
    api.exportUsageCsv.mockRejectedValueOnce(new Error("disk full"));
    await renderDashboard(api);
    fireEvent.click(await screen.findByRole("button", { name: /CSV 내보내기/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("사용량을 내보내지 못했습니다. 다시 시도하세요.");
    api.exportUsageCsv.mockResolvedValueOnce({ ok: false, filePath: "" });
    fireEvent.click(screen.getByRole("button", { name: /CSV 내보내기/ }));
    await waitFor(() => expect(api.exportUsageCsv).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent(t("usageDashboard.exportError"));
  });
});
