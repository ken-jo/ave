import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import {
  buildLlmSettings,
  launchSeededElectron,
  setWindowSize,
  teardownSeededElectron,
} from "./seeded-electron.js";
import {
  BAND_EDGE_PAD,
  BAND_LEAD_PAD_DARWIN,
  BAND_LEAD_PAD_LINUX,
  RAIL_BAND_LEAD,
} from "../../../src/shared/shell-geometry.js";

/** The band never pads under the platform's own window buttons (CustomTitleBar); elsewhere the path sits on the title line. */
function bandLeadFor(titleLeft: number): number {
  if (process.platform === "darwin") return Math.max(BAND_LEAD_PAD_DARWIN, titleLeft);
  if (process.platform === "linux") return Math.max(BAND_LEAD_PAD_LINUX, titleLeft);
  return Math.max(BAND_EDGE_PAD, titleLeft);
}

async function measureShell(page: Page, testInfo: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().every(
    (animation) => !(animation instanceof CSSTransition) || animation.playState !== "running",
  ))).toBe(true);
  const geometry = await page.evaluate(() => {
    const box = (element: Element) => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const hit = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [0.15, 0.5, 0.85].every((fraction) => {
        const target = document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2);
        return target === element || (target !== null && element.contains(target));
      });
    };
    const band = document.querySelector('[data-testid^="custom-titlebar"]');
    const card = document.querySelector('[data-testid="sidebar-card"]');
    const rail = document.querySelector('[data-testid="sidebar-rail"]');
    const handle = document.querySelector('[data-testid="sidebar-resize-handle"]');
    const panes = [...document.querySelectorAll('[data-testid="pane"]')]
      .filter((pane) => pane.getBoundingClientRect().width > 0);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      // Where the band's path row starts: its content edge, past the padding CustomTitleBar computes.
      bandLead: band ? band.getBoundingClientRect().left + parseFloat(getComputedStyle(band).paddingLeft) : null,
      card: card ? box(card) : null,
      rail: rail ? box(rail) : null,
      handle: handle ? { ...box(handle), hit: hit(handle) } : null,
      panes: panes.map((pane) => ({
        ...box(pane),
        // The header row's leading edge: its glyph, then the h2 (DESIGN.md, header band). The band path starts on this line.
        titleLeft: pane.querySelector('[data-testid="pane-header"] > :first-child')?.getBoundingClientRect().left ?? null,
        h2Left: pane.querySelector('[data-testid="pane-header"] h2')?.getBoundingClientRect().left ?? null,
        buttons: [...pane.querySelectorAll('[data-testid="pane-header"] button')]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .map((button) => ({ id: button.getAttribute("data-testid"), hit: hit(button) })),
      })),
      overlay: document.querySelector('[data-testid="primary-sidebar"]')?.getAttribute("data-sidebar-overlay") === "true",
    };
  });
  const measurements = testInfo.outputPath(`${name}.json`);
  writeFileSync(measurements, JSON.stringify(geometry, null, 2));
  await testInfo.attach(`${name}.json`, { path: measurements, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  return geometry;
}

test("empty banner text cannot reserve space above the pane cards", async () => {
  const testInfo = test.info();
  const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
  try {
    await setWindowSize(context.app, 1243, 800);
    await context.page.getByTestId("window-notice-banners").evaluate((lane) => lane.append(" "));
    const geometry = await measureShell(context.page, testInfo, "shell-empty-banner");
    if (!geometry.card) throw new Error("Expected sidebar card");
    expect(Math.abs(geometry.panes[0].top - geometry.card.top)).toBeLessThanOrEqual(0.5);
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});

test("pane cards follow a changed shared card-top token", async () => {
  const testInfo = test.info();
  const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
  try {
    await setWindowSize(context.app, 1243, 800);
    await context.page.evaluate(() => document.documentElement.style.setProperty("--shell-card-top", "52px"));
    const geometry = await measureShell(context.page, testInfo, "shell-card-top-token");
    if (!geometry.card) throw new Error("Expected sidebar card");
    expect(geometry.card.top).toBe(52);
    expect(Math.abs(geometry.panes[0].top - geometry.card.top)).toBeLessThanOrEqual(0.5);
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});

for (const width of [1243, 360]) {
  for (const state of ["expanded", "rail", "hidden"] as const) {
    test(`${width}x800 ${state} keeps pane cards on the shell top line`, async () => {
      const testInfo = test.info();
      const context = await launchSeededElectron({
        historyRows: [],
        settings: { ...buildLlmSettings(), system: { sidebarState: state } },
      });
      try {
        const { app, page } = context;
        await setWindowSize(app, width, 800);
        const geometry = await measureShell(page, testInfo, `shell-${width}-${state}`);
        expect(geometry.viewport).toEqual({ width, height: 800 });
        expect(Boolean(geometry.card)).toBe(state === "expanded");
        expect(Boolean(geometry.rail)).toBe(state !== "hidden");
        expect(geometry.panes).toHaveLength(1);
        const pane = geometry.panes[0];
        expect(Math.abs(pane.top - 40)).toBeLessThanOrEqual(0.5);
        if (geometry.bandLead === null || pane.titleLeft === null) throw new Error("Expected band and pane header title");
        if (state === "expanded" && !geometry.overlay) {
          expect(Math.abs(geometry.bandLead - pane.titleLeft)).toBeLessThanOrEqual(1);
        } else if (state !== "hidden") {
          // Rail and overlay: the title sits on the rail's line, and the path follows it unless window buttons own that space.
          expect(Math.abs(pane.titleLeft - RAIL_BAND_LEAD)).toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.bandLead - bandLeadFor(pane.titleLeft))).toBeLessThanOrEqual(1);
        }
        const sidebar = geometry.card ?? geometry.rail;
        if (sidebar) expect(Math.abs(sidebar.top - pane.top)).toBeLessThanOrEqual(0.5);
        if (sidebar && !geometry.overlay) expect(Math.abs(pane.left - sidebar.right - 4)).toBeLessThanOrEqual(0.5);
        if (geometry.handle) {
          if (!geometry.card) throw new Error("Expected sidebar card around resize handle");
          expect(geometry.handle.width).toBe(8);
          expect(geometry.handle.hit).toBe(true);
          expect(geometry.handle.right).toBe(geometry.card.right);
          if (!geometry.overlay) expect(geometry.handle.right).toBeLessThan(pane.left);
        }
        // Expanded navigation intentionally covers the narrow canvas until folded.
        if (!geometry.overlay) {
          expect(pane.buttons.length).toBeGreaterThan(0);
          expect(pane.buttons.every((button) => button.hit)).toBe(true);
        }
        if (geometry.handle && geometry.card && !geometry.overlay) {
          const handle = page.getByTestId("sidebar-resize-handle");
          const before = geometry.card.width;
          await page.mouse.move(geometry.handle.left + geometry.handle.width / 2, geometry.handle.top + geometry.handle.height / 2);
          await page.mouse.down();
          await page.mouse.move(geometry.handle.left + geometry.handle.width / 2 + 20, geometry.handle.top + geometry.handle.height / 2, { steps: 5 });
          await page.mouse.up();
          await expect(handle).toHaveAttribute("aria-valuenow", String(before + 20));
          const resized = await measureShell(page, testInfo, `shell-${width}-${state}-resized`);
          if (!resized.card || !resized.handle) throw new Error("Expected resized sidebar with handle");
          expect(resized.card.width).toBe(before + 20);
          expect(Math.abs(resized.panes[0].left - resized.card.right - 4)).toBeLessThanOrEqual(0.5);
          expect(resized.handle.width).toBe(8);
          expect(resized.handle.right).toBe(resized.card.right);
          expect(resized.handle.hit).toBe(true);
          if (resized.bandLead === null || resized.panes[0].titleLeft === null) throw new Error("Expected band and pane header title");
          expect(Math.abs(resized.bandLead - resized.panes[0].titleLeft)).toBeLessThanOrEqual(1);
          expect(resized.panes[0].buttons.every((button) => button.hit)).toBe(true);
        }
      } finally {
        await teardownSeededElectron(context, { terminate: true });
      }
    });
  }
}

for (const axis of ["row", "column"] as const) {
  test(`1243x800 ${axis} split preserves shell alignment and the inner gutter`, async () => {
    const testInfo = test.info();
    const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
    try {
      const { app, page } = context;
      await setWindowSize(app, 1243, 800);
      await page.getByTestId("pane-split").click();
      await page.getByTestId(`pane-split-${axis}`).click();
      await expect(page.getByTestId("pane")).toHaveCount(2);
      const geometry = await measureShell(page, testInfo, `shell-1243-split-${axis}`);
      if (!geometry.card || !geometry.handle) throw new Error("Expected expanded sidebar with resize handle");
      const [first, second] = geometry.panes;
      expect(geometry.panes).toHaveLength(2);
      expect(Math.abs(first.top - geometry.card.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(first.left - geometry.card.right - 4)).toBeLessThanOrEqual(0.5);
      if (axis === "row") {
        expect(Math.abs(second.top - first.top)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(second.left - first.right - 8)).toBeLessThanOrEqual(0.5);
      } else {
        expect(Math.abs(second.top - first.bottom - 8)).toBeLessThanOrEqual(0.5);
      }
      if (geometry.bandLead === null || first.titleLeft === null || second.titleLeft === null) throw new Error("Expected band and pane header titles");
      expect(Math.abs(geometry.bandLead - first.titleLeft)).toBeLessThanOrEqual(1);
      expect(geometry.handle.hit).toBe(true);
      expect(geometry.panes.every((pane) => pane.buttons.length > 0 && pane.buttons.every((button) => button.hit))).toBe(true);
    } finally {
      await teardownSeededElectron(context, { terminate: true });
    }
  });
}
