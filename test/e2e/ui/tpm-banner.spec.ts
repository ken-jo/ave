// Verify token-limit notice thresholds and stacking without overflowing chat layout.

import { test, expect, type Page } from "@playwright/test";
import type { LLMVendor } from "../../../src/shared/llm-vendor-defaults.js";
import { getUsableContext } from "../../../src/shared/context-budget.js";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron.js";
import { makeTestT } from "./i18n.js";
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

const t = makeTestT("ko");
const TPM_LABEL = t("chatView.tpmUsagePercent").split("{pct}")[0].trim();
const TPM_LABEL_RE = TPM_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONTEXT_WINDOW = 400_000;
const CONTEXT_BUDGET = getUsableContext(CONTEXT_WINDOW);
const MAIN = '[data-composer-surface="main"]';

function nextPaint(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function expectTpmWarning(page: Page, percent: number) {
  const notice = page.locator(MAIN).getByRole("status").filter({ hasText: TPM_LABEL });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/\btext-warning\b/);
  await expect(notice).not.toHaveClass(/\btext-destructive\b/);
  await expect(notice).toHaveAttribute("aria-live", "polite");
  await expect(notice.locator("span.font-medium")).toHaveText(new RegExp(`^${TPM_LABEL_RE}\\s+${percent}%`));
  return notice;
}

function makeHistoryRows(tokensIn: number): Array<Record<string, unknown>> {
  const now = Date.now();
  return [
    { index: 0, role: "user", content: "테스트 메시지", createdAt: now - 6000 },
    {
      index: 1,
      role: "assistant",
      content: "테스트 응답",
      createdAt: now - 5000,
      turnSummary: {
        tokensIn,
        tokensOut: 500,
        turnDurationMs: 3000,
        toolCount: 0,
        cumulativeToolMs: 0,
        freshInputTokens: tokensIn,
      },
    },
  ];
}

async function launchWithTokens(opts: {
  tokensIn: number;
  vendor: LLMVendor;
  model: string;
}): Promise<SeededElectronContext> {
  const { tokensIn, vendor, model } = opts;
  const settings = buildLlmSettings(vendor, model);
  const llm = settings.llm as { vendors: Record<string, { contextWindow?: number }> };
  // An explicit route window keeps threshold cases independent of catalog prompt-cap updates.
  llm.vendors[vendor].contextWindow = CONTEXT_WINDOW;
  settings.chat = { autoCompact: true };
  return launchSeededElectron({
    sessionId: "aa000000-bb11-4cc2-8dd3-eeeeeeeeeeee",
    sessionTitle: "TPM e2e probe",
    settings,
    historyRows: makeHistoryRows(tokensIn),
    userDataPrefix: "ave-tpm-e2e-user-data-",
    homePrefix: "ave-tpm-e2e-home-",
  });
}

test.describe("Composer usage warnings", () => {
  test.beforeAll(() => {
    expect(builtMainExists(), "Build the app before running its usage-notice E2E").toBe(true);
  });

  test("nano model + 160 K usedTokens shows an 80% TPM warning", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    try {
      await expect(ctx.page.locator(testIdSelector(TEST_IDS.composer)).first()).toBeVisible();
      const notice = await expectTpmWarning(ctx.page, 80);
      await expect(notice).toContainText(t("chatView.tpmNearingWarning"));
      await expect(ctx.page.getByTestId("composer-context-notice")).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("nano model + 200 K usedTokens retains warning severity at the TPM limit", async () => {
    const ctx = await launchWithTokens({ tokensIn: 200_000, vendor: "openai", model: "gpt-5.4-nano" });
    try {
      await expect(ctx.page.locator(testIdSelector(TEST_IDS.composer)).first()).toBeVisible();
      const notice = await expectTpmWarning(ctx.page, 100);
      await expect(notice).toContainText(t("chatView.tpmOverflowWarning"));
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("a model without a per-minute host limit shows no TPM notice", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-4o-mini" });
    try {
      await expect(ctx.page.getByText("테스트 응답")).toBeVisible();
      await expect(ctx.page.locator(MAIN).getByRole("status").filter({ hasText: TPM_LABEL })).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("TPM warning renders in both compiled themes", async ({}, testInfo) => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    try {
      for (const theme of ["gallery", "moonstone"]) {
        await ctx.page.evaluate((theme) => {
          document.documentElement.setAttribute("data-theme-bundle", theme);
        }, theme);
        await nextPaint(ctx.page);
        await expectTpmWarning(ctx.page, 80);
        await ctx.page.screenshot({ path: testInfo.outputPath(`tpm-banner-${theme}.png`) });
      }
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  for (const contextPercent of [89, 90, 100, 109]) {
    test(`context ${contextPercent}% and TPM notices follow warning thresholds without overflow`, async ({}, testInfo) => {
      const tokensIn = CONTEXT_BUDGET * contextPercent / 100;
      const ctx = await launchWithTokens({ tokensIn, vendor: "openai", model: "gpt-5.4-nano" });
      const { page } = ctx;
      try {
        const tpm = await expectTpmWarning(page, Math.round(tokensIn / 200_000 * 100));
        const context = page.locator(MAIN).getByTestId("composer-context-notice");
        if (contextPercent < 90) {
          await expect(context).toHaveCount(0);
        } else {
          await expect(context).toBeVisible();
          await expect(context).toHaveAttribute("data-severity", "warning");
          await expect(context).toHaveAttribute("role", "status");
          await expect(context).toHaveAttribute("aria-live", "polite");
          await expect(context.locator("span.font-medium")).toHaveText(t("chatView.contextUsagePercent", { pct: contextPercent }));
          await expect(context.locator("svg")).toHaveClass(/\btext-warning\b/);
          await expect(context.locator(".text-destructive")).toHaveCount(0);
          await expect(context).toContainText(t(contextPercent >= 100 ? "chatView.contextOverflowWarning" : "chatView.contextNearingWarning"));
        }
        const geometry = await tpm.evaluate((notice) => {
          const dock = notice.closest('[data-composer-surface="main"]')!;
          const frame = dock.querySelector('[data-testid="composer-frame"]')!.getBoundingClientRect();
          const context = dock.querySelector('[data-testid="composer-context-notice"]');
          const notices = [notice, ...(context ? [context] : [])].map((el) => {
            const rect = el.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          });
          const root = document.getElementById("root")!;
          return { frame: { left: frame.left, right: frame.right, width: frame.width }, notices, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
        });
        expect(geometry.frame.width).toBeGreaterThan(0);
        for (const notice of geometry.notices) {
          expect(Math.abs(notice.left - geometry.frame.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(notice.right - geometry.frame.right)).toBeLessThanOrEqual(1);
        }
        expect(geometry.clientWidth).toBeGreaterThan(0);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 4);
        await page.screenshot({ path: testInfo.outputPath(`usage-${contextPercent}.png`) });
      } finally {
        await teardownSeededElectron(ctx);
      }
    });
  }
});
