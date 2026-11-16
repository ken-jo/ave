import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import {
  buildLlmSettings,
  launchSeededElectron,
  setWindowSize,
  teardownSeededElectron,
} from "./seeded-electron.js";

// The default expanded list is 232px wide; rendered header content includes the card's 1px border.
const EXPECTED_RAIL_BAND_START = { darwin: 80, linux: 136, win32: 72 } as const;

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
    const strip = document.querySelector('[data-testid="window-notice-strip"]');
    const card = document.querySelector('[data-testid="sidebar-card"]');
    const rail = document.querySelector('[data-testid="sidebar-rail"]');
    const handle = document.querySelector('[data-testid="sidebar-resize-handle"]');
    const panes = [...document.querySelectorAll('[data-testid="pane"]')]
      .filter((pane) => pane.getBoundingClientRect().width > 0);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-card-inset")),
      cardGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-card-gap")),
      // Where the band's path row starts: its content edge, past the padding CustomTitleBar computes.
      bandLead: band ? band.getBoundingClientRect().left + parseFloat(getComputedStyle(band).paddingLeft) : null,
      strip: strip ? box(strip) : null,
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

for (const [width, height] of [[950, 734], [1440, 900], [360, 734]]) {
  for (const state of ["expanded", "rail", "hidden"] as const) {
    test(`${width}x${height} ${state} shares the outside card inset`, async () => {
      const context = await launchSeededElectron({
        historyRows: [],
        settings: { ...buildLlmSettings(), system: { sidebarState: state } },
      });
      try {
        await setWindowSize(context.app, width, height);
        for (const gap of [8, 12]) {
          await context.page.evaluate((value) => {
            document.documentElement.style.setProperty("--chrome-gap", `${value}px`);
            document.documentElement.style.setProperty("--shell-card-gap", `${value / 2}px`);
          }, gap);
          const geometry = await measureShell(context.page, test.info(), `outside-${width}-${state}-${gap}`);
          expect(geometry.viewport).toEqual({ width, height });
          const pane = geometry.panes[0];
          expect((geometry.rail ?? pane).left).toBe(geometry.inset);
          expect(width - pane.right).toBe(geometry.inset);
          expect(height - pane.bottom).toBe(geometry.inset);
          for (const card of [geometry.rail, geometry.card]) {
            if (card) expect(height - card.bottom).toBe(geometry.inset);
          }
          if (geometry.rail && geometry.card) {
            expect(geometry.card.left - geometry.rail.right).toBe(geometry.cardGap);
          }
          const leadingCard = geometry.card ?? geometry.rail;
          if (leadingCard && !geometry.overlay) expect(pane.left - leadingCard.right).toBe(geometry.cardGap);
        }
      } finally {
        await teardownSeededElectron(context, { terminate: true });
      }
    });
  }
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

test("docked and overlay work cards share the inter-card gap", async () => {
  const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
  try {
    const { app, page } = context;
    await setWindowSize(app, 1440, 900);
    await page.getByTestId("pane-panel-toggle").click();
    const column = page.getByTestId("chat-side-panel-motion");
    await expect(column).toHaveAttribute("aria-hidden", "false");
    for (const [width, mode] of [[1440, "docked"], [950, "overlay"]] as const) {
      await setWindowSize(app, width, 734);
      await expect(column).toHaveAttribute("data-panel-mode", mode);
      for (const gap of [4, 6]) {
        await page.evaluate((value) => document.documentElement.style.setProperty("--shell-card-gap", `${value}px`), gap);
        await measureShell(page, test.info(), `work-card-${mode}-${gap}`);
        const insets = await column.evaluate((element) => {
          const card = element.querySelector("aside");
          if (!card) throw new Error("Expected work panel card");
          const outside = element.getBoundingClientRect();
          const inside = card.getBoundingClientRect();
          return [inside.left - outside.left, outside.right - inside.right, inside.top - outside.top, outside.bottom - inside.bottom];
        });
        expect(insets).toEqual([gap, gap, gap, gap]);
      }
    }
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});

test("native resize edges stay outside the titlebar drag rectangle", async () => {
  const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
  try {
    for (const [width, height] of [[950, 734], [1440, 900]]) {
      await setWindowSize(context.app, width, height);
      const regions = await context.page.evaluate(() => {
        const band = document.querySelector('[data-testid^="custom-titlebar"]');
        const drag = document.querySelector('[data-testid="titlebar-drag-region"]');
        if (!band || !drag) throw new Error("Expected titlebar regions");
        const bounds = drag.getBoundingClientRect();
        // Regions compose in document order; later no-drag boxes exclude earlier drag boxes.
        // Include pointer-transparent boxes, which still participate in native drag-region collection.
        const regions = [...document.querySelectorAll("*")].flatMap(element => {
          const style = getComputedStyle(element);
          const mode = style.getPropertyValue("-webkit-app-region");
          const rect = element.getBoundingClientRect();
          return style.visibility === "visible" && rect.width > 0 && rect.height > 0 && (mode === "drag" || mode === "no-drag")
            ? [{ mode, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }] : [];
        });
        const canDrag = (x: number, y: number) => regions.reduce((active, region) =>
          x >= region.left && x < region.right && y >= region.top && y < region.bottom ? region.mode === "drag" : active, false);
        const spacer = document.querySelector('[data-testid="main-toolbar-drag-band"]')?.getBoundingClientRect();
        const button = band.querySelector("button")?.getBoundingClientRect();
        if (!spacer || !button) throw new Error("Expected titlebar spacer and control");
        return {
          band: getComputedStyle(band).getPropertyValue("-webkit-app-region"),
          drag: getComputedStyle(drag).getPropertyValue("-webkit-app-region"),
          inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-gap-tight")),
          bounds: { left: bounds.left, top: bounds.top, right: bounds.right },
          interiorDrags: canDrag(spacer.left + spacer.width / 2, spacer.top + spacer.height / 2),
          controlDrags: canDrag(button.left + button.width / 2, button.top + button.height / 2),
          nativeEdgeDrags: [[1, 1], [innerWidth / 2, 1], [innerWidth - 1, 1], [1, 18], [innerWidth - 1, 18]]
            .map(([x, y]) => canDrag(x, y)),
          edges: [[1, 1], [innerWidth / 2, 1], [innerWidth - 1, 1], [1, 18], [innerWidth - 1, 18],
            [1, innerHeight / 2], [innerWidth - 1, innerHeight / 2], [innerWidth / 2, innerHeight - 1]]
            .map(([x, y]) => document.elementsFromPoint(x, y).map(element => getComputedStyle(element).getPropertyValue("-webkit-app-region"))),
        };
      });
      expect(regions.band).toBe("none");
      expect(regions.drag).toBe("drag");
      expect(regions.bounds).toEqual({ left: regions.inset, top: regions.inset, right: width - regions.inset });
      expect(regions.edges.every(stack => !stack.includes("drag"))).toBe(true);
      expect(regions.interiorDrags).toBe(true);
      expect(regions.controlDrags).toBe(false);
      expect(regions.nativeEdgeDrags).toEqual([false, false, false, false, false]);
      await test.info().attach(`resize-regions-${width}.json`, { body: JSON.stringify(regions, null, 2), contentType: "application/json" });
    }
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
          expect(geometry.bandLead).toBe(308);
          expect(pane.titleLeft).toBe(309);
        } else if (state !== "hidden") {
          const platform = process.platform;
          if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("Unsupported window platform");
          expect(pane.titleLeft).toBe(73);
          expect(geometry.bandLead).toBe(EXPECTED_RAIL_BAND_START[platform]);
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
          expect(resized.bandLead).toBe(328);
          expect(resized.panes[0].titleLeft).toBe(329);
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
        expect(Math.abs(second.left - first.right - 4)).toBeLessThanOrEqual(0.5);
      } else {
        expect(Math.abs(second.top - first.bottom - 4)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(second.left - first.left)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(second.right - first.right)).toBeLessThanOrEqual(0.5);
      }
      if (geometry.bandLead === null || first.titleLeft === null || second.titleLeft === null) throw new Error("Expected band and pane header titles");
      expect(geometry.bandLead).toBe(308);
      expect(first.titleLeft).toBe(309);
      if (axis === "column") expect(Math.abs(second.titleLeft - first.titleLeft)).toBeLessThanOrEqual(0.5);
      expect(geometry.handle.hit).toBe(true);
      expect(geometry.panes.every((pane) => pane.buttons.length > 0 && pane.buttons.every((button) => button.hit))).toBe(true);
    } finally {
      await teardownSeededElectron(context, { terminate: true });
    }
  });
}

test("a visible banner moves the pane down by its lane while the sidebar card stays on the card line", async () => {
  const testInfo = test.info();
  const settings = buildLlmSettings();
  // A retired provider id raises the persistent RetiredProviderNotice banner on launch.
  const context = await launchSeededElectron({
    historyRows: [],
    settings: { ...settings, llm: { ...(settings.llm as Record<string, unknown>), provider: "copilot" } },
  });
  try {
    await setWindowSize(context.app, 1243, 800);
    await expect(context.page.getByTestId("retired-provider-notice")).toBeVisible();
    const geometry = await measureShell(context.page, testInfo, "shell-visible-banner");
    if (!geometry.card || !geometry.strip) throw new Error("Expected sidebar card and banner lane");
    expect(geometry.strip.height).toBeGreaterThan(0);
    expect(Math.abs(geometry.card.top - 40)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.panes[0].top - geometry.card.top - geometry.strip.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.panes[0].left - geometry.card.right - 4)).toBeLessThanOrEqual(0.5);
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});

// Fullscreen is not driven here: entering it on macOS takes the Space and the focus, which the background e2e rule forbids.
// The `keepVisibleInFullscreen` branch is covered by CustomTitleBar.test.tsx, which holds its lead on the same `leadClearance`.

test("a toolbar wider than the window cannot widen the shell column past the pane", async () => {
  const testInfo = test.info();
  const context = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings() });
  try {
    await setWindowSize(context.app, 1243, 800);
    const before = await measureShell(context.page, testInfo, "shell-wide-toolbar-before");
    await context.page.getByTestId("main-toolbar").evaluate((toolbar) => {
      const wide = document.createElement("div");
      wide.style.cssText = "flex: none; width: 3000px; height: 1px";
      toolbar.append(wide);
    });
    const after = await measureShell(context.page, testInfo, "shell-wide-toolbar-after");
    expect(after.viewport).toEqual({ width: 1243, height: 800 });
    expect(Math.abs(after.panes[0].left - before.panes[0].left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.panes[0].right - before.panes[0].right)).toBeLessThanOrEqual(0.5);
    expect(after.panes[0].right).toBeLessThanOrEqual(after.viewport.width);
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});
