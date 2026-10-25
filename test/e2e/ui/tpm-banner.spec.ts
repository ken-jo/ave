/**
 * TPM warning / destructive banner Playwright E2E — issue #909.
 *
 * PR #908 added a sticky per-request TPM (Tokens Per Minute) hint region
 * above the composer in ChatView. This suite validates that the banner
 * appears/disappears correctly depending on model and usedTokens, and that
 * the layout does not regress when both the context-overflow and TPM banners
 * stack simultaneously.
 *
 * Simulation strategy
 * -------------------
 * The renderer derives `tpmPct` from:
 *   usedTokens / tpmLimit
 * where `tpmLimit` comes from `hostTpmDefault(llmVendor, llmModel)` (model-host-policy.ts)
 * and `usedTokens` comes from the last `kind:"turn_summary"` ChatEntry in the
 * active session (field `tokensIn`).
 *
 * We inject both dependencies before launch:
 *   1. `userDataDir/ave-settings.json` — sets `llm.provider="openai"` and
 *      `llm.vendors.openai.model="gpt-5.4-nano"` so `tpmLimit=200_000`.
 *   2. `tempHome/.ave/sessions/<id>.jsonl` — a seeded session whose
 *      turn-final assistant message carries `turnSummary.tokensIn` at the
 *      desired level.
 *   3. `tempHome/.ave/sessions/.active-session.json` — resumes that session
 *      on boot so the hydrated entries flow into the budget hook.
 *
 * Model for banner thresholds (gpt-5.4-nano):
 *   host TPM default = 200_000
 *   contextWindow = 400_000  →  contextBudget (usable) = 360_000
 *
 *   TPM warning    : tpmPct ∈ [0.80, 0.95)  → usedTokens ∈ [160_000, 190_000)
 *   TPM destructive: tpmPct ≥ 0.95          → usedTokens ≥ 190_000
 *   Both-banner    : usedTokens ≥ 288_000   → tpmPct ≥ 1.44 (destructive) +
 *                                              contextPct = 0.80 (warning)
 */

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Locale-agnostic catalog binding. `launchSeededElectron` seeds the ko locale
// (buildE2eBaseSettings default), so bind the resolver to ko — the assertions
// below match against the catalog value rather than a hard-coded Korean literal,
// so the suite can flip the seeded locale without rewriting them. (#1212 follow-up.)
const t = makeTestT("ko");

// The TPM / context banner catalog values carry a `{pct}` placeholder
// (e.g. "분당 한도(TPM) {pct}% — {used} / {limit}"). Tests match only the static
// label prefix that precedes the dynamic percentage, so slice it off the
// rendered template. Escaped into a RegExp for the matchers that also assert a
// dynamic percentage.
const TPM_LABEL = t("chatView.tpmUsagePercent").split("{pct}")[0].trim();
const CONTEXT_LABEL = t("chatView.contextUsagePercent").split("{pct}")[0].trim();
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TPM_LABEL_RE = escapeRegExp(TPM_LABEL);

/** Resolve once the browser has painted the current DOM (two animation frames). */
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

/**
 * Seed the per-test isolated filesystem and launch Electron.
 * Returns `{ app, page, userDataDir, tempHome }` for cleanup.
 */
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("TPM warning / destructive banner", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  // -------------------------------------------------------------------------
  // Case 1 — nano model + 160K tokens → warning banner (80% ≤ tpmPct < 95%)
  // -------------------------------------------------------------------------
  test("nano model + 160 K usedTokens shows TPM warning banner", async () => {
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // tpmPct = 160_000 / 200_000 = 0.80 → warning banner (warning tone)
      // Span text: "분당 한도(TPM) 80% — 160,000 / 200,000"
      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      // Verify text shows 80%
      const textContent = await tpmText.first().textContent();
      expect(textContent).toMatch(new RegExp(`${TPM_LABEL_RE} 80%`));

      // The banner row carries the warning tone, not the destructive one.
      const warningDiv = page.locator("div.text-warning").filter({ hasText: TPM_LABEL });
      await expect(warningDiv).toBeVisible({ timeout: 5_000 });

      // Destructive-styled TPM div must NOT be present
      const destructiveDiv = page.locator("div.text-destructive").filter({ hasText: TPM_LABEL });
      await expect(destructiveDiv).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Case 2 — nano model + 200K tokens → destructive banner (tpmPct ≥ 100%)
  // -------------------------------------------------------------------------
  test("nano model + 200 K usedTokens shows TPM destructive banner", async () => {
    const ctx = await launchWithTokens({ tokensIn: 200_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // tpmPct = 200_000 / 200_000 = 1.00 ≥ 0.95 → destructive banner
      // Text: "분당 한도(TPM) 100% — …"
      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      const textContent = await tpmText.first().textContent();
      // pct = 100% → "100%"
      expect(textContent).toMatch(
        new RegExp(`${TPM_LABEL_RE}\\s+1\\d\\d%|${TPM_LABEL_RE}\\s+9[5-9]%`),
      );

      // The banner row carries the destructive tone, not the warning one.
      const bannerDiv = page.locator("div.text-destructive").filter({ hasText: TPM_LABEL });
      await expect(bannerDiv).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("div.text-warning").filter({ hasText: TPM_LABEL })).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Case 3 — non-nano model (gpt-4o-mini) → NO banner (no host TPM default)
  // -------------------------------------------------------------------------
  test("non-nano model (gpt-4o-mini) shows no TPM banner — backward compat", async () => {
    // gpt-4o-mini has no host TPM default → tpmLimit=undefined → banner hidden
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-4o-mini" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // The seeded turn, whose summary carries the token usage the banners
      // read, is on screen: a banner that was going to render has rendered.
      await expect(page.getByText("테스트 응답")).toBeVisible({ timeout: 10_000 });

      const tpmBanners = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmBanners).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Case 4 — dark / light theme screenshot (visual regression anchor)
  // -------------------------------------------------------------------------
  test("TPM warning banner renders in both compiled themes", async () => {
    // Use 160K tokens on nano → stable warning banner for screenshot
    const ctx = await launchWithTokens({ tokensIn: 160_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // Wait for the banner to appear
      const tpmText = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmText).toBeVisible({ timeout: 10_000 });

      // The compiled bundles; every other theme is an installed package.
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

      // Both screenshots taken without error — visual regression anchor established.
      // Banner still visible after theme swap.
      await expect(tpmText).toBeVisible();
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Case 5 — two-banner stacking: context 80% + TPM destructive simultaneously
  // gpt-5.4-nano: contextBudget=360K, tpmLimit=200K
  // With 288K tokens: contextPct=80% (warning), tpmPct=144% (destructive)
  // Both banners stack above the composer — layout must not overflow.
  // -------------------------------------------------------------------------
  test("context-overflow + TPM destructive banners stack without layout overflow", async () => {
    // 288_000 tokens: tpmPct = 288/200 = 1.44 → TPM destructive
    //                 contextPct = 288/360 = 0.8 → context warning
    const ctx = await launchWithTokens({ tokensIn: 288_000, vendor: "openai", model: "gpt-5.4-nano" });
    const { page } = ctx;
    try {
      const composer = page.locator(testIdSelector(TEST_IDS.composer)).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // Both banners must be present
      const tpmBanner = page.locator("span.font-semibold").filter({ hasText: TPM_LABEL });
      await expect(tpmBanner).toBeVisible({ timeout: 10_000 });

      const contextBanner = page.locator("span.font-semibold").filter({ hasText: CONTEXT_LABEL });
      await expect(contextBanner).toBeVisible({ timeout: 5_000 });

      // Layout regression guard: the chat-area root must not overflow horizontally.
      // We check that the scrollWidth of the main container does not exceed
      // its clientWidth (no horizontal scroll bar injected by banner stacking).
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

      // Screenshot for stacked layout visual record
      await page.screenshot({ path: "test-results/tpm-banner-stacked.png", fullPage: false });
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
