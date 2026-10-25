// Verify token-limit banner thresholds and stacking without overflowing chat layout.

import { test, expect, type Page } from "@playwright/test";
import type { LLMVendor } from "../../../src/shared/llm-vendor-defaults.js";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";
import { makeTestT } from "./i18n";
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Bind assertions to the locale seeded by this harness.
const t = makeTestT("ko");

// Match escaped static label prefixes before dynamic catalog placeholders.
const TPM_LABEL = t("chatView.tpmUsagePercent").split("{pct}")[0].trim();
const CONTEXT_LABEL = t("chatView.contextUsagePercent").split("{pct}")[0].trim();
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TPM_LABEL_RE = escapeRegExp(TPM_LABEL);

function nextPaint(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
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
  return launchSeededElectron({
    sessionId: "aa000000-bb11-4cc2-8dd3-eeeeeeeeeeee",
    sessionTitle: "TPM e2e probe",
    settings: buildLlmSettings(vendor, model),
    historyRows: makeHistoryRows(tokensIn),
    userDataPrefix: "ave-tpm-e2e-user-data-",
    homePrefix: "ave-tpm-e2e-home-",
  });
}

test.describe("TPM warning / destructive banner", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("nano model + 160 K usedTokens shows TPM warning banner", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      const textContent = await tpmText.first().textContent();
      expect(textContent).toMatch(new RegExp(`${TPM_LABEL_RE} 80%`));

      const warningDiv = page.locator("div.text-warning").filter({ hasText: TPM_LABEL });
      await expect(warningDiv).toBeVisible({ timeout: 5_000 });

      const destructiveDiv = page.locator("div.text-destructive").filter({ hasText: TPM_LABEL });
      await expect(destructiveDiv).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("nano model + 200 K usedTokens shows TPM destructive banner", async () => {
    const ctx = await launchWithTokens({ tokensIn: 200_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      const textContent = await tpmText.first().textContent();
      expect(textContent).toMatch(
        new RegExp(`${TPM_LABEL_RE}\\s+1\\d\\d%|${TPM_LABEL_RE}\\s+9[5-9]%`),
      );

      const bannerDiv = page.locator("div.text-destructive").filter({ hasText: TPM_LABEL });
      await expect(bannerDiv).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("div.text-warning").filter({ hasText: TPM_LABEL })).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("non-nano model (gpt-4o-mini) shows no TPM banner — backward compat", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-4o-mini" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // Wait for the usage-bearing turn before asserting banners are absent.
      await expect(page.getByText("테스트 응답")).toBeVisible({ timeout: 10_000 });

      const tpmBanners = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmBanners).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("TPM warning banner renders in both compiled themes", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme-bundle", "gallery");
      });
      await nextPaint(page);
      await page.screenshot({ path: "test-results/tpm-banner-gallery.png", fullPage: false });

      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme-bundle", "moonstone");
      });
      await nextPaint(page);
      await page.screenshot({ path: "test-results/tpm-banner-moonstone.png", fullPage: false });

      await expect(tpmText).toBeVisible();
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  // Use a fixture that crosses context and per-minute thresholds simultaneously.
  test("context-overflow + TPM destructive banners stack without layout overflow", async () => {
    // This usage produces an 80% context warning and a 144% per-minute destructive state.
    const ctx = await launchWithTokens({ tokensIn: 288_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      const tpmBanner = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmBanner).toBeVisible({ timeout: 10_000 });

      const contextBanner = page.locator("span.font-semibold").filter({ hasText: CONTEXT_LABEL });
      await expect(contextBanner).toBeVisible({ timeout: 5_000 });

      // Stacked banners must not introduce horizontal overflow.
      const overflowCheck = await page.evaluate(() => {
        const root = document.getElementById("root");
        if (!root) return { overflows: false, scrollWidth: 0, clientWidth: 0 };
        return {
          overflows: root.scrollWidth > root.clientWidth + 4, // 4px tolerance for borders
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
        };
      });
      expect(
        overflowCheck.overflows,
        `Horizontal overflow detected: scrollWidth=${overflowCheck.scrollWidth} > clientWidth=${overflowCheck.clientWidth}`,
      ).toBe(false);

      await page.screenshot({ path: "test-results/tpm-banner-stacked.png", fullPage: false });
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
