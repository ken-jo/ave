import { expect, test } from "@playwright/test";
import { OVERLAY_V1 } from "../../../src/shared/ipc-channels.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { SUGGESTIONS_SESSION_ID } from "../../../src/shared/suggestions-session.js";
import { makeTestT } from "./i18n.js";
import type { AlertCard } from "../../../src/shared/alerts-types.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("a narrowed split keeps alert and approval actions reachable", async ({}, testInfo) => {
  const t = makeTestT("en");
  // An alert that names no conversation is staged in Suggestions, never in the conversation on screen, and main creates that
  // conversation before it sends the card. The card below is sent straight to the window, so the conversation a previous alert
  // created is seeded and shown, and the split keeps it in one of its tiles.
  const ctx = await launchSeededElectron({
    historyRows: [], sessionId: SUGGESTIONS_SESSION_ID, settings: buildE2eBaseSettings(true, "en"),
  });
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
    await expect(overlay.getByTestId("plugin-provenance-id")).toHaveText(t("alerts.pluginIdOnly", { id: pluginId }));
    // A narrow window shows only the focused tile, so focus the one holding Suggestions and its card.
    const suggestionsPane = page.getByTestId("pane").filter({ has: overlay });
    await suggestionsPane.getByRole("heading").first().click();
    await expect(suggestionsPane).toHaveAttribute("data-focused", "true");
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

    // Short enough that the card overflows its lane and its primary action starts out of view. Suggestions has no composer under the lane, so the lane reaches lower than
    // in a conversation tile and the window must be shorter for the card to need scrolling.
    await page.setViewportSize({ width: 390, height: 240 });
    const short = await layout();
    expect(short).not.toBeNull();
    expect(short!.laneScrollHeight).toBeGreaterThan(short!.laneClientHeight);
    expect(short!.closeHit).toBe(true);
    // The primary action starts below the lane's edge, so reaching it needs the lane to scroll.
    expect(short!.reviewHit).toBe(false);
    const narrowCard = await overlay.boundingBox();
    expect(narrowCard).not.toBeNull();
    const touchX = Math.round(narrowCard!.x + narrowCard!.width / 2);
    // Gestures run inside the lane: from near its bottom edge up towards its top.
    const lane = page.getByTestId("floating-right-lane").filter({ has: overlay });
    const laneBox = await lane.boundingBox();
    expect(laneBox).not.toBeNull();
    const laneMidY = () => Math.round(laneBox!.y + laneBox!.height / 2);
    const swipe = (steps: number) => {
      const from = Math.round(laneBox!.y + laneBox!.height - 8);
      const to = Math.round(laneBox!.y + 8);
      return { from, moves: Array.from({ length: steps }, (_, index) => Math.round(from - ((from - to) * (index + 1)) / steps)) };
    };
    await page.mouse.move(touchX, laneMidY());
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
        const { from, moves } = swipe(4);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: from }] });
        for (const y of moves) {
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
        buttons: ["deny-button", "approval-deny-menu", "allow-session-button", "approval-allow-menu", "approve-button"]
          .map((id) => {
            const button = approval.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            return button ? hit(button) : false;
          }),
      };
    });
    // The shared approval row (c7701bb5e) fits its card at the narrow split's 320px height, so no scrolling stands between the
    // user and its decisions there: every button is reachable as drawn. The scroll-to-reach path is exercised by the alert
    // card above, which overflows its lane at 240px.
    await page.setViewportSize({ width: 390, height: 320 });
    await expect.poll(async () => (await approvalLayout())?.buttons).toEqual([true, true, true, true, true]);
    const approvalShown = await approvalLayout();
    expect(approvalShown!.shrink).toBe("0");
    await page.screenshot({ path: testInfo.outputPath("approval-narrow-split.png") });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
