import { expect, test } from "@playwright/test";
import { OVERLAY_V1 } from "../../../src/shared/ipc-channels.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import type { AlertCard } from "../../../src/shared/alerts-types.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("a narrowed split keeps alert and approval actions reachable", async ({}, testInfo) => {
  const ctx = await launchSeededElectron({ historyRows: [], settings: buildE2eBaseSettings(true, "en") });
  try {
    const { app, page } = ctx;
    await page.setViewportSize({ width: 1440, height: 900 });
    const skipTour = page.getByTestId("spotlight-tour:skip");
    if (await skipTour.isVisible()) await skipTour.click();
    const sidebarToggle = page.getByTestId("sidebar-collapse-toggle");
    if (await sidebarToggle.count() === 1 && await sidebarToggle.getAttribute("aria-label") === "Collapse sidebar") {
      await sidebarToggle.click();
    }
    await page.getByTestId("pane-split").first().click();
    await page.getByTestId("pane-split-row").click();
    await expect(page.getByTestId("pane")).toHaveCount(2);

    const pluginId = `plugin-${"x".repeat(56)}a`;
    const card: AlertCard = {
      id: "alert:narrow-split",
      source: { kind: "alert", pluginId, kindId: "notice", alertId: "narrow-split" },
      pluginDisplayName: "Mail tools",
      title: "Review notice",
      summary: "Review this notice.",
      running: false,
      pendingPrompt: "Review this notice.",
      primaryActionLabel: "Review",
      priority: "normal",
      createdAt: new Date().toISOString(),
    };
    await app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
      if (!win) throw new Error("No visible window");
      win.webContents.send(payload.channel, payload.card);
    }, { channel: OVERLAY_V1.show, card });
    const overlay = page.getByTestId("routine-card");
    await expect(overlay.getByTestId("plugin-provenance-id")).toHaveText(`Plugin: ${pluginId}`);
    await page.setViewportSize({ width: 390, height: 900 });

    const layout = () => page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="routine-card"]');
      const pane = card?.closest<HTMLElement>('[data-testid="pane"]');
      const lane = card?.closest<HTMLElement>('[data-testid="floating-right-lane"]');
      const id = card?.querySelector<HTMLElement>('[data-testid="plugin-provenance-id"]');
      const close = card?.querySelector<HTMLElement>('[data-testid="routine-card-dismiss"]');
      const review = card?.querySelector<HTMLElement>('[data-testid="overlay-card-primary-action"]');
      if (!card || !pane || !lane || !id || !close || !review) return null;
      const p = pane.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const i = id.getBoundingClientRect();
      const idText = id.firstChild;
      const lastGlyph = document.createRange();
      if (!idText?.textContent) return null;
      lastGlyph.setStart(idText, idText.textContent.length - 1);
      lastGlyph.setEnd(idText, idText.textContent.length);
      const last = lastGlyph.getBoundingClientRect();
      const hit = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const under = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        return under === element || element.contains(under);
      };
      return {
        leftGap: c.left - p.left,
        rightGap: p.right - c.right,
        cardWidth: c.width,
        idWidth: i.width,
        idWithinCard: i.left >= c.left && i.right <= c.right,
        idOverflow: id.scrollWidth > id.clientWidth + 1,
        idLastGlyphVisible: last.left >= i.left - 1 && last.right <= i.right + 1
          && last.top >= p.top && last.bottom <= p.bottom && last.bottom <= c.bottom + 1,
        closeHit: hit(close),
        reviewHit: hit(review),
        laneClientHeight: lane.clientHeight,
        laneScrollHeight: lane.scrollHeight,
        laneScrollTop: lane.scrollTop,
      };
    });

    const narrow = await layout();
    expect(narrow).not.toBeNull();
    expect(Math.abs(narrow!.leftGap - narrow!.rightGap)).toBeLessThanOrEqual(1);
    expect(narrow!.idWidth).toBeGreaterThan(0);
    expect(narrow!.idWithinCard).toBe(true);
    expect(narrow!.idOverflow).toBe(false);
    expect(narrow!.idLastGlyphVisible).toBe(true);
    expect(narrow!.closeHit).toBe(true);
    expect(narrow!.reviewHit).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("long-id-narrow-split.png") });

    await page.setViewportSize({ width: 390, height: 320 });
    const short = await layout();
    expect(short).not.toBeNull();
    expect(short!.laneScrollHeight).toBeGreaterThan(short!.laneClientHeight);
    expect(short!.closeHit).toBe(true);
    const narrowCard = await overlay.boundingBox();
    expect(narrowCard).not.toBeNull();
    const touchX = Math.round(narrowCard!.x + narrowCard!.width / 2);
    await page.mouse.move(touchX, 180);
    await page.mouse.wheel(0, 600);
    await expect.poll(async () => (await layout())?.reviewHit).toBe(true);
    expect((await layout())!.laneScrollTop).toBeGreaterThan(0);

    await page.evaluate(() => {
      const lane = document.querySelector<HTMLElement>('[data-testid="routine-card"]')
        ?.closest<HTMLElement>('[data-testid="floating-right-lane"]');
      if (lane) lane.scrollTop = 0;
    });
    expect((await layout())!.laneScrollTop).toBe(0);
    expect((await layout())!.closeHit).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      for (let gesture = 0; gesture < 3; gesture++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: 250 }] });
        for (const y of [210, 170, 130, 90]) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y }] });
          await page.waitForTimeout(30);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(150);
        if ((await layout())?.reviewHit) break;
      }
      await expect.poll(async () => (await layout())?.reviewHit).toBe(true);
      expect((await layout())!.laneScrollTop).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath("long-id-narrow-split-touch.png") });
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
    }

    await page.evaluate(() => {
      const lane = document.querySelector<HTMLElement>('[data-testid="routine-card"]')
        ?.closest<HTMLElement>('[data-testid="floating-right-lane"]');
      if (lane) lane.scrollTop = 0;
    });
    await app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
      if (!win) throw new Error("No visible window");
      win.webContents.send(payload.channel, payload.request);
    }, {
      channel: CHANNELS.approval.request,
      request: {
        id: "approval:narrow-split",
        category: "tool",
        toolName: "read_file",
        toolCategory: "read",
        args: { path: "/tmp/layout-fixture.txt" },
        reason: "Review fixture read",
        createdAt: Date.now(),
        requireExplicit: false,
      },
    });
    const approval = page.getByTestId("approval-lane-card");
    await expect(approval).toBeVisible();
    const approvalLayout = () => page.evaluate(() => {
      const approval = document.querySelector<HTMLElement>('[data-testid="approval-lane-card"]');
      const lane = approval?.closest<HTMLElement>('[data-testid="floating-right-lane"]');
      if (!approval || !lane) return null;
      const hit = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const under = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        return under === element || element.contains(under);
      };
      return {
        shrink: getComputedStyle(approval).flexShrink,
        scrollRange: approval.scrollHeight - approval.clientHeight,
        scrollTop: approval.scrollTop,
        laneScrollTop: lane.scrollTop,
        buttons: ["deny-button", "approval-deny-menu", "allow-session-button", "approval-allow-menu", "approve-button"]
          .map((id) => {
            const button = approval.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            return button ? hit(button) : false;
          }),
      };
    });
    const approvalBefore = await approvalLayout();
    expect(approvalBefore).not.toBeNull();
    expect(approvalBefore!.shrink).toBe("0");
    expect(approvalBefore!.scrollRange).toBeGreaterThan(0);
    await page.mouse.move(touchX, 180);
    await page.mouse.wheel(0, approvalBefore!.scrollRange);
    await expect.poll(async () => (await approvalLayout())?.buttons).toEqual([true, true, true, true]);
    await page.screenshot({ path: testInfo.outputPath("approval-narrow-split-wheel.png") });

    await page.evaluate(() => {
      const approval = document.querySelector<HTMLElement>('[data-testid="approval-lane-card"]');
      const lane = approval?.closest<HTMLElement>('[data-testid="floating-right-lane"]');
      if (approval) approval.scrollTop = 0;
      if (lane) lane.scrollTop = 0;
    });
    const approvalTouch = await page.context().newCDPSession(page);
    try {
      await approvalTouch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      for (let gesture = 0; gesture < 8; gesture++) {
        await approvalTouch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: 250 }] });
        for (const y of [230, 210, 190, 170, 150]) {
          await approvalTouch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y }] });
          await page.waitForTimeout(30);
        }
        await approvalTouch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(180);
        if ((await approvalLayout())?.buttons.every(Boolean)) break;
      }
      await expect.poll(async () => (await approvalLayout())?.buttons).toEqual([true, true, true, true]);
      await page.screenshot({ path: testInfo.outputPath("approval-narrow-split-touch.png") });
    } finally {
      await approvalTouch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await approvalTouch.detach();
    }
  } finally {
    await teardownSeededElectron(ctx);
  }
});
