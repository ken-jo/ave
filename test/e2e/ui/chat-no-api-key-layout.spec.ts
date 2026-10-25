import { test, expect } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Keep the no-key chip in the reserved strip without moving the empty-conversation composer.
test.describe("chat no-API-key layout", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  let ctx: SeededElectronContext;

  test.afterEach(async () => {
    if (ctx) await teardownSeededElectron(ctx);
  });

  test("puts the no-key chip in the composer strip, not the transcript", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "ave-no-api-key-layout-user-data-",
      homePrefix: "ave-no-api-key-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1040, height: 360 });

    const chip = ctx.page.locator('[data-testid="composer-api-key-chip"]');
    const composer = ctx.page.locator(testIdSelector(TEST_IDS.composerInputBar));
    const projectSelector = ctx.page.locator('[data-testid="composer-project-selector-slot"]');
    await expect(chip).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(projectSelector).toBeVisible();

    const metrics = await ctx.page.evaluate(() => {
      const toBox = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, height: rect.height };
      };
      const chipEl = document.querySelector('[data-testid="composer-api-key-chip"]');
      const chipBox = toBox('[data-testid="composer-api-key-chip"]');
      const selectorBox = toBox('[data-testid="composer-project-selector-slot"]');
      const composerBox = toBox('[data-testid="composer-input-bar"]');
      const composerDock = document.querySelector("[data-composer-placement]");
      if (!chipBox || !selectorBox || !composerBox) return null;
      const overlapsComposer = !(
        chipBox.right <= composerBox.left ||
        chipBox.left >= composerBox.right ||
        chipBox.bottom <= composerBox.top ||
        chipBox.top >= composerBox.bottom
      );
      return {
        placement: composerDock?.getAttribute("data-composer-placement"),
        hasLiftAttr: composerDock?.hasAttribute("data-composer-centered-lift") ?? false,
        chipInsideScroll: Boolean(chipEl?.closest(".ave-chat-scroll")),
        overlapsComposer,
        chipRightOfSelector: chipBox.left >= selectorBox.right,
        chipAboveComposer: chipBox.bottom <= composerBox.top,
        sameStrip: Math.abs(chipBox.top - selectorBox.top) <= 12,
        composerBottom: composerBox.bottom,
        viewportHeight: window.innerHeight,
        chipBox,
        selectorBox,
        composerBox,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("bottom");
    expect(metrics?.hasLiftAttr, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.chipInsideScroll).toBe(false);
    expect(metrics?.overlapsComposer, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.chipRightOfSelector, JSON.stringify(metrics)).toBe(true);
    expect(metrics?.chipAboveComposer, JSON.stringify(metrics)).toBe(true);
    expect(metrics?.sameStrip, JSON.stringify(metrics)).toBe(true);
    expect(metrics?.composerBottom, JSON.stringify(metrics)).toBeLessThanOrEqual(
      metrics?.viewportHeight ?? 0,
    );
  });

  test("keeps the composer bottom-docked on a tall viewport when no key is set", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "ave-no-api-key-tall-layout-user-data-",
      homePrefix: "ave-no-api-key-tall-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1076, height: 798 });

    await expect(ctx.page.locator('[data-testid="composer-api-key-chip"]')).toBeVisible();
    await expect(ctx.page.locator(testIdSelector(TEST_IDS.composerInputBar))).toBeVisible();

    const metrics = await ctx.page.evaluate(() => {
      const composerDock = document.querySelector("[data-composer-placement]");
      const composerEl = document.querySelector('[data-testid="composer-input-bar"]');
      if (!composerDock || !composerEl) return null;
      return {
        viewportHeight: window.innerHeight,
        placement: composerDock.getAttribute("data-composer-placement"),
        hasLiftAttr: composerDock.hasAttribute("data-composer-centered-lift"),
        marginBottom: Number.parseFloat(getComputedStyle(composerDock).marginBottom),
        composerTop: composerEl.getBoundingClientRect().top,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("bottom");
    expect(metrics?.hasLiftAttr, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.marginBottom, JSON.stringify(metrics)).toBe(0);
    expect(metrics?.composerTop, JSON.stringify(metrics)).toBeGreaterThan(
      (metrics?.viewportHeight ?? 0) * 0.6,
    );
  });

  test("chip popover preserves both destinations from the retired card", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "ave-no-api-key-popover-user-data-",
      homePrefix: "ave-no-api-key-popover-home-",
    });

    await ctx.page.setViewportSize({ width: 1076, height: 798 });

    const chip = ctx.page.locator('[data-testid="composer-api-key-chip"]');
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:settings"]')).toBeVisible();
    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:marketplace"]')).toBeVisible();

    // Opening the overlay must not move the composer.
    const composerTopBefore = await ctx.page.evaluate(() =>
      document.querySelector('[data-testid="composer-input-bar"]')!.getBoundingClientRect().top,
    );
    await ctx.page.keyboard.press("Escape");
    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:settings"]')).toHaveCount(0);
    const composerTopAfter = await ctx.page.evaluate(() =>
      document.querySelector('[data-testid="composer-input-bar"]')!.getBoundingClientRect().top,
    );
    expect(Math.abs(composerTopAfter - composerTopBefore)).toBeLessThanOrEqual(1);
  });
});
