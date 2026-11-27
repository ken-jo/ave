import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  untrustedEvent,
  hostFrameEvent,
  invokeRegisteredHandlerWithEvent,
  isolatedAppFrameEvent,
} from "../../__tests__/test-helpers.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BaseWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
}));

vi.mock("../../engine/usage-stats.js", () => ({
  getUsageSummary: vi.fn(async (days: number) => ({ days, total: 0 })),
  getUsageRange: vi.fn(async (opts: unknown) => ({ range: opts, rows: [] })),
}));

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  return invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
}

const mockAuditLogger = { log: vi.fn(), search: vi.fn(), getStats: vi.fn(), flush: vi.fn(async (): Promise<void> => {}) };
const mockGenerateText = vi.fn(async () => "AI daily summary");
const noCorrections = (key: string) => (key === "llm" ? {} : undefined);
const mockSettingsGet = vi.fn(noCorrections);

function makeMinimalDeps() {
  return {
    auditLogger: mockAuditLogger,
    conversationLoop: { generateText: mockGenerateText },
    getMainWindow: () => null,
    settingsService: { get: mockSettingsGet },
  } as unknown as import("../types.js").IpcDeps;
}

beforeEach(async () => {
  handlers.clear();
  vi.clearAllMocks();
  // clearAllMocks retains implementations; restore pricing defaults between tests.
  mockSettingsGet.mockImplementation(noCorrections);
  const { registerUsageHandlers } = await import("../domains/usage.js");
  registerUsageHandlers(makeMinimalDeps());
});

describe("ave:usage:summary", () => {
  it("is registered", () => {
    expect(handlers.has("ave:usage:summary")).toBe(true);
  });

  it("calls getUsageSummary with provided days", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    const result = await invoke("ave:usage:summary", hostFrameEvent(), 30) as { days: number };
    expect(getUsageSummary).toHaveBeenCalledWith(30);
    expect(result.days).toBe(30);
  });

  it("waits for pending audit writes before reading usage", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    let releaseFlush: (() => void) | undefined;
    mockAuditLogger.flush.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFlush = resolve;
    }));

    const pending = invoke("ave:usage:summary", hostFrameEvent(), 30) as Promise<unknown>;
    await Promise.resolve();
    expect(getUsageSummary).not.toHaveBeenCalled();
    releaseFlush?.();
    await pending;

    expect(mockAuditLogger.flush).toHaveBeenCalledTimes(1);
    expect(getUsageSummary).toHaveBeenCalledWith(30);
  });

  it("defaults to 60 days when no argument", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    await invoke("ave:usage:summary", hostFrameEvent());
    expect(getUsageSummary).toHaveBeenCalledWith(60);
  });

});

describe("ave:usage:range", () => {
  it("is registered", () => {
    expect(handlers.has("ave:usage:range")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("ave:usage:range", untrustedEvent(), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("calls getUsageRange with opts on authorized sender", async () => {
    const { getUsageRange } = await import("../../engine/usage-stats.js");
    const opts = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
    await invoke("ave:usage:range", hostFrameEvent(), opts);
    expect(mockAuditLogger.flush).toHaveBeenCalledTimes(1);
    expect(getUsageRange).toHaveBeenCalledWith(opts);
  });
});

describe("ave:usage:daily-summary", () => {
  it("is registered", () => {
    expect(handlers.has("ave:usage:daily-summary")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("ave:usage:daily-summary", untrustedEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("rejects plugin shell frames even though they are local file URLs", async () => {
    const result = await invoke("ave:usage:daily-summary", isolatedAppFrameEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("generates a constrained LLM daily summary from insight payload", async () => {
    const result = await invoke("ave:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      locale: "ko-KR",
      sessions: [{ title: "프로젝트 작업" }],
      starred: [{ role: "assistant", text: "중요한 결정" }],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.001 },
    }) as { ok: boolean; summary?: string };

    expect(result).toMatchObject({ ok: true, summary: "AI daily summary" });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"date\":\"2026-07-04\""),
      expect.stringContaining("Ave Insights"),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"totalTokens\":120"),
      expect.any(String),
    );
  });

  it("sends both unknown-price reasons to the daily summary", async () => {
    await invoke("ave:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      usage: { cost: 0.01, unknownCostTurns: 2, endpointPriceUnavailableTurns: 1, legacyRouteUnrecordedTurns: 1 },
    });
    const [prompt] = (mockGenerateText.mock.lastCall ?? []) as readonly unknown[];
    expect(JSON.parse(String(prompt).split("\n").at(-1) ?? "")).toMatchObject({
      usage: {
        cost: null,
        unknownCostTurns: 2,
        pricingUnavailableReasons: ["endpoint-price-unavailable", "legacy-route-unrecorded"],
      },
    });
  });

  it("serializes unavailable daily cost as null", async () => {
    await invoke("ave:usage:daily-summary", hostFrameEvent(), { date: "2026-07-04", usage: null });
    const [prompt] = (mockGenerateText.mock.lastCall ?? []) as readonly unknown[];
    expect(JSON.parse(String(prompt).split("\n").at(-1) ?? "")).toMatchObject({ usage: { cost: null } });
  });

  it("serializes incomplete audit cost as null while retaining readable tokens", async () => {
    await invoke("ave:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      usage: { auditIncomplete: true, inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.001 },
    });
    const [prompt] = (mockGenerateText.mock.lastCall ?? []) as readonly unknown[];
    expect(JSON.parse(String(prompt).split("\n").at(-1) ?? "")).toMatchObject({
      usage: { auditIncomplete: true, inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: null },
    });
  });

  it("redacts sensitive renderer text before sending the daily summary prompt to the LLM", async () => {
    const result = await invoke("ave:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      locale: "ko-KR",
      sessions: [{ title: "Call foo.bar@example.com", projectName: "010-1234-5678 launch" }],
      starred: [{ role: "assistant", text: "Card 4111 1111 1111 1111 was pasted" }],
      usage: { totalTokens: 120 },
    }) as { ok: boolean };

    expect(result.ok).toBe(true);
    const prompt = mockGenerateText.mock.calls.at(-1)?.[0] as string;
    expect(prompt).not.toContain("foo.bar@example.com");
    expect(prompt).not.toContain("010-1234-5678");
    expect(prompt).not.toContain("4111 1111 1111 1111");
    expect(prompt).toContain("[REDACTED:EMAIL]");
    expect(prompt).toContain("[REDACTED:PHONE]");
    expect(prompt).toContain("[REDACTED:CC]");
  });

  it("returns a fail-closed result when the LLM summary call fails", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("LLM provider not configured"));
    const result = await invoke("ave:usage:daily-summary", hostFrameEvent(), { date: "2026-07-04" });

    expect(result).toEqual({ ok: false, error: "LLM provider not configured" });
  });

  it("normalizes malformed payloads instead of rejecting the IPC handler", async () => {
    const result = await invoke("ave:usage:daily-summary", hostFrameEvent(), undefined) as { ok: boolean; summary?: string };

    expect(result).toMatchObject({ ok: true, summary: "AI daily summary" });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"date\":\"unknown\""),
      expect.any(String),
    );
  });
});

describe("ave:usage:export-csv", () => {
  it("is registered", () => {
    expect(handlers.has("ave:usage:export-csv")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("ave:usage:export-csv", untrustedEvent(), []);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("returns { ok: false, canceled: true } when dialog is canceled", async () => {
    const result = await invoke("ave:usage:export-csv", hostFrameEvent(), []) as { ok: boolean; canceled?: boolean };
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
  });

  it("saves blank incomplete cost and the endpoint reason count in the CSV file", async () => {
    const { dialog } = await import("electron");
    const root = mkdtempSync(join(tmpdir(), "ave-usage-csv-"));
    try {
      const filePath = join(root, "usage.csv");
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });

      const result = await invoke("ave:usage:export-csv", hostFrameEvent(), [
        {
          date: "2026-05-22",
          vendor: "openai",
          model: "gpt-4o",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 110,
          cost: "",
          unknownCostTurns: 1,
          endpointPriceUnavailableTurns: 1,
          legacyRouteUnrecordedTurns: 0,
        },
        { date: "range-total", vendor: "openai", model: "gpt-4o", cost: 0.25, unknownCostTurns: 1, endpointPriceUnavailableTurns: 0, legacyRouteUnrecordedTurns: 1, auditIncomplete: 1 },
      ]) as { ok: boolean; filePath?: string };

      expect(result).toEqual({ ok: true, filePath });
      const csv = readFileSync(filePath, "utf-8");
      expect(csv.split("\r\n")).toEqual([
        "date,vendor,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,cost,unknownCostTurns,endpointPriceUnavailableTurns,legacyRouteUnrecordedTurns,auditIncomplete",
        '"2026-05-22","openai","gpt-4o",100,10,20,5,110,"",1,1,0,""',
        '"range-total","openai","gpt-4o","","","","","","",1,0,1,1',
      ]);
    } finally {
      await cleanupTmpDir(root);
    }
  });
  it("escapes quotes, commas and line breaks as CSV fields", async () => {
    const { dialog } = await import("electron");
    const root = mkdtempSync(join(tmpdir(), "ave-usage-csv-"));
    try {
      const filePath = join(root, "usage.csv");
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });
      await invoke("ave:usage:export-csv", hostFrameEvent(), [{ model: 'a,"quoted"\nmodel' }]);
      const csv = readFileSync(filePath, "utf-8");
      expect(csv).toContain('"a,""quoted""\nmodel"');
      expect(csv).not.toContain('\\"quoted');
    } finally {
      await cleanupTmpDir(root);
    }
  });

});
