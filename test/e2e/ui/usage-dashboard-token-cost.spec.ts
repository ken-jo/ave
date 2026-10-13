import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron,
} from "./seeded-electron.js";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";
import { makeTestT } from "./i18n.js";
import { utcDateKey as todayKey } from "../../../src/shared/local-date.js";

// This spec launches its own Electron via launchSeededElectron (default ko
// settings), independent of the fixture's seedLocale, so bind `t` to that locale.
const t = makeTestT("ko");

function writeUsageAudit(aveHome: string): void {
  const day = todayKey();
  const auditDir = path.join(aveHome, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const rows = [
    {
      timestamp: `${day}T12:00:00.000Z`,
      sessionId: "mixed-provider-session",
      type: "turn",
      route: "openai/gpt-5.4-mini",
      input: "mixed provider historical turn",
      tokenUsage: {
        inputTokens: 53_000,
        outputTokens: 6300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 1000,
      },
      usageByModel: [
        {
          vendorProvider: "claude",
          vendorModel: "claude-sonnet-4-6",
          tokenUsage: {
            inputTokens: 30_000,
            outputTokens: 5000,
            cacheReadTokens: 4000,
            cacheWriteTokens: 1000,
          },
        },
        {
          vendorProvider: "openai",
          vendorModel: "gpt-5.4-mini",
          tokenUsage: {
            inputTokens: 23_000,
            outputTokens: 1300,
            cacheReadTokens: 1000,
          },
        },
      ],
    },
    {
      timestamp: `${day}T12:05:00.000Z`,
      sessionId: "unknown-cost-session",
      type: "turn",
      route: "legacy",
      input: "unknown cost historical turn",
      tokenUsage: {
        inputTokens: 10_000,
        outputTokens: 1000,
        cacheReadTokens: 500,
      },
    },
  ];
  fs.writeFileSync(
    path.join(auditDir, `${day}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
}

test.describe("usage dashboard token cost e2e", () => {
  test.skip(
    !builtMainExists(),
    "dist/src/main/main.js not built; run bun run build first",
  );

  test("recorded request prices survive a correction change in display and CSV", async () => {
    const pricing = { source: "user", rates: { inputPer1M: 1, outputPer1M: 0 } };
    const usageByModel = [{
      vendorProvider: "openai", vendorModel: "gpt-5.4",
      tokenUsage: { inputTokens: 100_000, outputTokens: 0 }, pricing,
    }];
    const settings = buildLlmSettings("openai", "gpt-5.4");
    (settings.llm as Record<string, unknown>).pricingOverrides = [
      { vendor: "openai", model: "gpt-5.4", inputPer1M: 10, outputPer1M: 0 },
    ];
    const ctx = await launchSeededElectron({
      settings,
      historyRows: [
        { index: 0, role: "user", content: "historical request" },
        { index: 1, role: "assistant", content: "completed request", turnSummary: {
          turnDurationMs: 1, toolCount: 0, cumulativeToolMs: 0,
          tokensIn: 100_000, freshInputTokens: 100_000, tokensOut: 0,
          vendorProvider: "openai", vendorModel: "gpt-5.4", usageByModel,
        } },
      ],
    });
    try {
      const badge = ctx.page.getByTestId("token-cost-badge");
      await badge.click();
      await expect(badge).toContainText("$0.100");
      const auditDir = path.join(ctx.aveHome, "audit");
      fs.mkdirSync(auditDir, { recursive: true });
      const day = todayKey();
      fs.writeFileSync(path.join(auditDir, `${day}.jsonl`), `${JSON.stringify({
        timestamp: new Date().toISOString(), type: "turn", sessionId: "recorded-request",
        route: "openai/gpt-5.4", usageByModel,
      })}\n`, "utf-8");
      const settingsPage = await openInlineSettings(ctx.app, ctx.page, "usage");
      const csvPath = path.join(ctx.tempHome, "recorded-cost.csv");
      try {
        const row = settingsPage.locator("table").filter({ hasText: t("usageDashboard.colVendor") }).first().locator("tbody tr");
        await expect(row.filter({ hasText: "openai" })).toContainText("$0.100");
        await ctx.app.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        }, csvPath);
        await settingsPage.getByRole("button", { name: t("usageDashboard.exportCsv"), exact: true }).click();
        await expect.poll(() => fs.existsSync(csvPath)).toBe(true);
        const csvRows = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
        expect(Number(csvRows[1].split(",")[8])).toBe(0.1);
        await ctx.page.screenshot({ path: test.info().outputPath("recorded-prices.png") });
      } finally {
        await closeInlineSettings(ctx.app, settingsPage);
      }
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("historical mixed-provider rows keep their provider pricing and unknown-cost rows stay unknown", async () => {
    const ctx = await launchSeededElectron({
      sessionTitle: "usage dashboard token cost",
      historyRows: [
        {
          index: 0,
          role: "user",
          content: "사용량 대시보드 e2e",
          createdAt: Date.now() - 1000,
        },
      ],
    });

    try {
      writeUsageAudit(ctx.aveHome);
      const settingsPage = await openInlineSettings(
        ctx.app,
        ctx.page,
        "usage",
      );
      try {
        await expect(settingsPage.getByTestId("usage-dashboard")).toBeVisible(
          {
            timeout: 10_000,
          },
        );
        await expect(
          settingsPage.getByText(t("usageDashboard.perVendor")),
        ).toBeVisible();

        const vendorTableRows = settingsPage
          .locator("table")
          .filter({ hasText: t("usageDashboard.colVendor") })
          .first()
          .locator("tbody tr");
        const claudeRow = vendorTableRows.filter({ hasText: "claude" });
        const openaiRow = vendorTableRows.filter({ hasText: "openai" });
        const unknownRow = vendorTableRows.filter({ hasText: "unknown" });

        await expect(claudeRow).toContainText("claude");
        await expect(claudeRow).not.toContainText(
          t("tokenCostBadge.pricingUnknownBadge"),
        );
        await expect(openaiRow).toContainText("openai");
        await expect(openaiRow).not.toContainText(
          t("tokenCostBadge.pricingUnknownBadge"),
        );

        await expect(unknownRow).toContainText("unknown");
        await expect(unknownRow).toContainText(
          t("usageDashboard.unknownCostTurns", { base: "$0", turns: "1" }),
        );
        // unknownCostIncluded is "{base} + 미정 포함"; assert the static suffix
        // (after the dynamic {base}) via the catalog rather than a literal.
        const unknownIncludedSuffix = t("usageDashboard.unknownCostIncluded", {
          base: "",
        })
          .split("+")
          .pop()!
          .trim();
        await expect(
          settingsPage.getByText(unknownIncludedSuffix).first(),
        ).toBeVisible();

        await expect(
          settingsPage.getByText("claude-sonnet-4-6"),
        ).toBeVisible();
        await expect(settingsPage.getByText("gpt-5.4-mini").first()).toBeVisible();
      } finally {
        await closeInlineSettings(ctx.app, settingsPage);
      }
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
